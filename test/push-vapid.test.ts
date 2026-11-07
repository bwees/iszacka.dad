import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/lib/state', () => ({
	getOrCreateSetting: vi.fn(async (_env: unknown, key: string, create: () => Promise<string> | string) => {
		if (!settings.has(key)) settings.set(key, await create());
		return settings.get(key) as string;
	}),
}));

import { base64UrlDecode, base64UrlEncode } from '../src/lib/security';
import {
	formatVapidHeader,
	generateVapidKeys,
	getVapidKeys,
	getVapidPublicKey,
	isUncompressedP256Point,
	parseVapidKeys,
	signVapidJwt,
	VAPID_MAX_TTL_SECONDS,
	VAPID_SUBJECT,
	vapidClaims,
	vapidHeaderForEndpoint,
	verifyVapidJwt,
} from '../src/lib/vapid';

const decodeJson = (part: string) => JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));

/** Verify an ES256 JWT with node:crypto, independently of our WebCrypto code. */
function nodeVerifies(jwt: string, publicKey: string): boolean {
	const raw = base64UrlDecode(publicKey);
	const key = createPublicKey({
		key: { kty: 'EC', crv: 'P-256', x: base64UrlEncode(raw.slice(1, 33)), y: base64UrlEncode(raw.slice(33, 65)) },
		format: 'jwk',
	});
	const [header, payload, signature] = jwt.split('.') as [string, string, string];
	return nodeVerify(
		'sha256',
		Buffer.from(`${header}.${payload}`),
		{ key, dsaEncoding: 'ieee-p1363' },
		Buffer.from(base64UrlDecode(signature)),
	);
}

describe('VAPID keys', () => {
	it('generates an uncompressed P-256 public key and a private JWK', async () => {
		const keys = await generateVapidKeys();
		const raw = base64UrlDecode(keys.publicKey);
		expect(raw.length).toBe(65);
		expect(raw[0]).toBe(0x04);
		expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(keys.privateJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
		expect(typeof keys.privateJwk.d).toBe('string');
		expect(isUncompressedP256Point(keys.publicKey)).toBe(true);
	});

	it('round-trips through the stored JSON format and rejects junk', async () => {
		const keys = await generateVapidKeys();
		expect(parseVapidKeys(JSON.stringify(keys))).toEqual(keys);
		expect(() => parseVapidKeys('not json')).toThrow();
		expect(() => parseVapidKeys(JSON.stringify({ publicKey: 'abc', privateJwk: keys.privateJwk }))).toThrow();
		expect(() => parseVapidKeys(JSON.stringify({ publicKey: keys.publicKey, privateJwk: { kty: 'RSA' } }))).toThrow();
	});

	it('creates the key pair once and reuses it', async () => {
		settings.clear();
		const env = { DB: {} } as unknown as Env;
		const first = await getVapidPublicKey(env);
		const again = await getVapidKeys({ DB: {} } as unknown as Env);
		expect(again.publicKey).toBe(first);
		expect(settings.size).toBe(1);
		expect(JSON.parse(settings.get('vapid_keys') as string).publicKey).toBe(first);
	});
});

describe('VAPID claims', () => {
	const now = Date.parse('2026-11-06T21:00:00Z');

	it('uses the push service origin as the audience and expires within 12 hours', () => {
		const claims = vapidClaims('https://fcm.googleapis.com/fcm/send/abc:def?x=1', now);
		expect(claims.aud).toBe('https://fcm.googleapis.com');
		expect(claims.sub).toBe(VAPID_SUBJECT);
		expect(claims.sub).toBe('mailto:stork@iszacka.dad');
		expect(claims.exp).toBe(Math.floor(now / 1000) + 12 * 3600);
		expect(claims.exp - now / 1000).toBeLessThanOrEqual(VAPID_MAX_TTL_SECONDS);
	});

	it('keeps non-default ports in the audience and caps the TTL', () => {
		const claims = vapidClaims('https://push.example.net:8443/x', now, 999_999);
		expect(claims.aud).toBe('https://push.example.net:8443');
		expect(claims.exp).toBe(Math.floor(now / 1000) + VAPID_MAX_TTL_SECONDS);
	});

	it('refuses non-https endpoints', () => {
		expect(() => vapidClaims('http://push.example.com/x', now)).toThrow();
	});
});

describe('VAPID JWT', () => {
	it('is an ES256 JWT that verifies against the public key', async () => {
		const keys = await generateVapidKeys();
		const claims = vapidClaims('https://updates.push.services.mozilla.com/wpush/v2/abc');
		const jwt = await signVapidJwt(keys, claims);
		const [header, payload, signature] = jwt.split('.') as [string, string, string];
		expect(decodeJson(header)).toEqual({ typ: 'JWT', alg: 'ES256' });
		expect(decodeJson(payload)).toEqual(claims);
		expect(base64UrlDecode(signature).length).toBe(64);
		expect(jwt).not.toMatch(/[=+/]/);

		expect(await verifyVapidJwt(jwt, keys.publicKey)).toEqual(claims);
		expect(nodeVerifies(jwt, keys.publicKey)).toBe(true);
	});

	it('fails verification when tampered with or checked against another key', async () => {
		const keys = await generateVapidKeys();
		const other = await generateVapidKeys();
		const jwt = await signVapidJwt(keys, vapidClaims('https://web.push.apple.com/abc'));
		const [header, , signature] = jwt.split('.') as [string, string, string];
		const forged = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ aud: 'https://evil.example', exp: 1, sub: 'x' })));

		expect(await verifyVapidJwt(`${header}.${forged}.${signature}`, keys.publicKey)).toBeNull();
		expect(nodeVerifies(`${header}.${forged}.${signature}`, keys.publicKey)).toBe(false);
		expect(await verifyVapidJwt(jwt, other.publicKey)).toBeNull();
		expect(nodeVerifies(jwt, other.publicKey)).toBe(false);
		expect(await verifyVapidJwt('not.a.jwt', keys.publicKey)).toBeNull();
	});

	it('builds the Authorization header as "vapid t=<jwt>, k=<key>"', async () => {
		settings.clear();
		const env = { DB: {} } as unknown as Env;
		const header = await vapidHeaderForEndpoint(env, 'https://fcm.googleapis.com/fcm/send/xyz');
		const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
		expect(match).not.toBeNull();
		const [, jwt, key] = match as unknown as [string, string, string];
		expect(key).toBe(await getVapidPublicKey(env));
		const claims = await verifyVapidJwt(jwt, key);
		expect(claims?.aud).toBe('https://fcm.googleapis.com');
		expect(nodeVerifies(jwt, key)).toBe(true);
		expect(formatVapidHeader('a.b.c', 'KEY')).toBe('vapid t=a.b.c, k=KEY');
	});
});

beforeEach(() => {
	vi.clearAllMocks();
});
