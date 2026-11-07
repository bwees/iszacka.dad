// VAPID (RFC 8292): the signed "it's really us" token that lets a push service
// accept a message from this Worker. Keys are an ECDSA P-256 pair generated with
// WebCrypto on first use and kept in D1 `settings` under 'vapid_keys'.
//
// Pushes here are payload-less, so there's no RFC 8291 encryption to do: the
// service worker wakes up and asks /api/status what happened. Anyone who wants a
// payload can have one when the baby learns to read.

import { base64UrlDecode, base64UrlEncode } from './security';
import { getOrCreateSetting } from './state';

/** What's stored in `settings.vapid_keys` (as JSON). */
export interface VapidKeys {
	/** base64url of the 65-byte uncompressed P-256 public point (0x04 || X || Y). */
	publicKey: string;
	/** The private key as a JWK (kty EC, crv P-256, with d, x, y). */
	privateJwk: JsonWebKey;
}

export interface VapidClaims {
	/** Origin of the push service, e.g. "https://fcm.googleapis.com". */
	aud: string;
	/** Expiry, in seconds since the epoch. */
	exp: number;
	/** Contact for the push service operator. */
	sub: string;
}

export const VAPID_SETTING_KEY = 'vapid_keys';
export const VAPID_SUBJECT = 'mailto:stork@iszacka.dad';
/** Longest-lived token we mint. RFC 8292 allows 24h; 12h leaves room for clock skew. */
export const VAPID_MAX_TTL_SECONDS = 12 * 60 * 60;

const ALGORITHM: SubtleCryptoImportKeyAlgorithm = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS: SubtleCryptoSignAlgorithm = { name: 'ECDSA', hash: 'SHA-256' };
const encoder = new TextEncoder();

/** Generate a fresh P-256 key pair in the stored format. */
export async function generateVapidKeys(): Promise<VapidKeys> {
	const pair = (await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])) as CryptoKeyPair;
	const raw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
	const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
	return { publicKey: base64UrlEncode(raw), privateJwk };
}

/** Parse and sanity-check the stored JSON. Throws on anything that isn't a usable key pair. */
export function parseVapidKeys(json: string): VapidKeys {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new Error('vapid_keys setting is not valid JSON');
	}
	if (typeof value !== 'object' || value === null) throw new Error('vapid_keys setting is not an object');
	const { publicKey, privateJwk } = value as Partial<VapidKeys>;
	if (typeof publicKey !== 'string' || !isUncompressedP256Point(publicKey)) {
		throw new Error('vapid_keys.publicKey is not a 65-byte uncompressed P-256 point');
	}
	if (
		typeof privateJwk !== 'object' ||
		privateJwk === null ||
		privateJwk.kty !== 'EC' ||
		privateJwk.crv !== 'P-256' ||
		typeof privateJwk.d !== 'string' ||
		typeof privateJwk.x !== 'string' ||
		typeof privateJwk.y !== 'string'
	) {
		throw new Error('vapid_keys.privateJwk is not a P-256 private JWK');
	}
	return { publicKey, privateJwk };
}

/** True if `value` is base64url of a 65-byte uncompressed EC point (what browsers want). */
export function isUncompressedP256Point(value: string): boolean {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
	try {
		const bytes = base64UrlDecode(value);
		return bytes.length === 65 && bytes[0] === 0x04;
	} catch {
		return false;
	}
}

// Parsed keys per database binding, so a batch of pushes costs one D1 read and one
// key import. The stored pair never changes once created (getOrCreateSetting), so
// caching it for the life of the isolate is safe.
interface LoadedVapid {
	keys: VapidKeys;
	signingKey: CryptoKey;
}
const loaded = new WeakMap<object, Promise<LoadedVapid>>();

async function loadVapid(env: Env): Promise<LoadedVapid> {
	const cached = loaded.get(env.DB);
	if (cached) return cached;
	const pending = (async () => {
		const json = await getOrCreateSetting(env, VAPID_SETTING_KEY, async () => JSON.stringify(await generateVapidKeys()));
		const keys = parseVapidKeys(json);
		return { keys, signingKey: await importSigningKey(keys.privateJwk) };
	})();
	loaded.set(env.DB, pending);
	pending.catch(() => loaded.delete(env.DB));
	return pending;
}

/** The site's VAPID key pair, generated and stored on first use. */
export async function getVapidKeys(env: Env): Promise<VapidKeys> {
	return (await loadVapid(env)).keys;
}

/** The public key browsers pass to pushManager.subscribe() as applicationServerKey. */
export async function getVapidPublicKey(env: Env): Promise<string> {
	return (await loadVapid(env)).keys.publicKey;
}

/**
 * A signed header is reused for every push to the same push service (the JWT's audience is the
 * service's origin, not the subscription) until it has less than this long left to live.
 */
export const VAPID_REUSE_MARGIN_SECONDS = 60 * 60;

// Signed headers per database binding, then per push-service origin. A fan-out step pushes to a
// handful of origins (FCM, Mozilla, Apple, WNS), so it signs a handful of JWTs, not one per push.
const signedHeaders = new WeakMap<object, Map<string, { exp: number; header: Promise<string> }>>();

/** The `Authorization` header for a push to `endpoint`, signed with the site's keys. */
export async function vapidHeaderForEndpoint(env: Env, endpoint: string, now: number = Date.now()): Promise<string> {
	const claims = vapidClaims(endpoint, now);
	let byOrigin = signedHeaders.get(env.DB);
	if (!byOrigin) signedHeaders.set(env.DB, (byOrigin = new Map()));
	const cached = byOrigin.get(claims.aud);
	// Also re-sign if the cached token expires further out than a fresh one would (a clock jump).
	if (cached && cached.exp - now / 1000 > VAPID_REUSE_MARGIN_SECONDS && cached.exp <= claims.exp) return cached.header;
	const header = (async () => {
		const { keys, signingKey } = await loadVapid(env);
		return formatVapidHeader(await signJwt(signingKey, claims), keys.publicKey);
	})();
	const entry = { exp: claims.exp, header };
	byOrigin.set(claims.aud, entry);
	header.catch(() => {
		if (byOrigin.get(claims.aud) === entry) byOrigin.delete(claims.aud);
	});
	return header;
}

/** Import a private JWK for signing. */
export async function importSigningKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
	// Drop key_ops / ext so the import doesn't trip over whatever usages it was exported with.
	const { kty, crv, d, x, y } = privateJwk;
	return crypto.subtle.importKey('jwk', { kty, crv, d, x, y }, ALGORITHM, false, ['sign']);
}

/** Import the raw (65-byte, base64url) public key for verification. */
export async function importVerifyKey(publicKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', base64UrlDecode(publicKey), ALGORITHM, false, ['verify']);
}

/**
 * Claims for a push to `endpoint`: the audience is the push service's origin, the
 * expiry is at most VAPID_MAX_TTL_SECONDS ahead, and the subject is the stork.
 */
export function vapidClaims(endpoint: string, now: number = Date.now(), ttlSeconds = VAPID_MAX_TTL_SECONDS): VapidClaims {
	const url = new URL(endpoint);
	if (url.protocol !== 'https:') throw new Error('Push endpoints must be https');
	const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 60), VAPID_MAX_TTL_SECONDS);
	return { aud: url.origin, exp: Math.floor(now / 1000) + ttl, sub: VAPID_SUBJECT };
}

/** ES256 JWS compact serialisation. WebCrypto's ECDSA output is already raw r||s, as JWS wants. */
export async function signJwt(signingKey: CryptoKey, claims: VapidClaims): Promise<string> {
	const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
	const signingInput = `${header}.${payload}`;
	const signature = await crypto.subtle.sign(SIGN_PARAMS, signingKey, encoder.encode(signingInput));
	return `${signingInput}.${base64UrlEncode(signature)}`;
}

/** Sign a VAPID JWT with a stored key pair (for callers that already hold the keys). */
export async function signVapidJwt(keys: VapidKeys, claims: VapidClaims): Promise<string> {
	return signJwt(await importSigningKey(keys.privateJwk), claims);
}

/** RFC 8292 §3: `vapid t=<jwt>, k=<public key>`. */
export function formatVapidHeader(jwt: string, publicKey: string): string {
	return `vapid t=${jwt}, k=${publicKey}`;
}

/**
 * Verify an ES256 JWT against a raw public key and return its claims, or null if
 * the signature, header or shape is wrong. Used by the tests, and by anyone who
 * doesn't trust us (reasonable).
 */
export async function verifyVapidJwt(jwt: string, publicKey: string): Promise<VapidClaims | null> {
	const parts = jwt.split('.');
	if (parts.length !== 3) return null;
	const [header, payload, signature] = parts as [string, string, string];
	try {
		const head = JSON.parse(new TextDecoder().decode(base64UrlDecode(header))) as { alg?: unknown; typ?: unknown };
		if (head.alg !== 'ES256' || head.typ !== 'JWT') return null;
		const sig = base64UrlDecode(signature);
		if (sig.length !== 64) return null;
		const ok = await crypto.subtle.verify(
			SIGN_PARAMS,
			await importVerifyKey(publicKey),
			sig,
			encoder.encode(`${header}.${payload}`),
		);
		if (!ok) return null;
		const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as Partial<VapidClaims>;
		if (typeof claims.aud !== 'string' || typeof claims.exp !== 'number' || typeof claims.sub !== 'string') return null;
		return { aud: claims.aud, exp: claims.exp, sub: claims.sub };
	} catch {
		return null;
	}
}
