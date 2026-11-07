// OWNER: ledger agent.
// The Dad Ledger: an append-only, hash-chained, Ed25519-signed log of status changes.
//
// Every entry commits to the one before it:
//
//   canonical = "<seq>|<at>|<status>|<note>|<prevHash>"
//   hash      = lowercase hex SHA-256 of the UTF-8 bytes of `canonical`
//   signature = base64url (unpadded) Ed25519 signature over the UTF-8 bytes of `hash`
//
// seq 0 is the genesis entry ("Genesis. Zack is not a dad."), whose prevHash is 64
// zeros. The signing key pair is generated on first use and kept in D1 `settings`
// under `ledger_keys`. Editing any past entry changes its hash, which breaks the
// next entry's prevHash; re-hashing the rest needs the private key to re-sign. It is
// tamper-evident, not tamper-proof: the point is that cheating would be obvious.
//
// The canonical string is unambiguous even though notes may contain '|': seq is an
// integer, `at` is an ISO timestamp, status is one of three words, and prevHash is
// always exactly 64 hex characters at the end, so everything else is the note.

import { isStatus, type Status } from '../types';
import { base64UrlDecode, base64UrlEncode, sha256Hex } from './security';
import { STATUS_COPY } from './site';
import { getOrCreateSetting } from './state';
import { nowIso } from './time';

export interface LedgerEntry {
	seq: number;
	at: string;
	status: Status;
	note: string;
	prevHash: string;
	hash: string;
	signature: string;
}

/** The fields an entry's hash commits to. */
export type LedgerFields = Pick<LedgerEntry, 'seq' | 'at' | 'status' | 'note' | 'prevHash'>;

/** Result of checking a chain. `entries` is how many entries were presented for checking. */
export interface LedgerVerification {
	valid: boolean;
	entries: number;
	/** seq (position) of the first entry that fails, when `valid` is false. */
	brokenAt?: number;
	/** Human-readable explanation, when `valid` is false. */
	reason?: string;
}

/** What `ledger_keys` holds in D1 `settings`. */
export interface StoredLedgerKeys {
	/** base64url of the raw 32-byte Ed25519 public key. */
	publicKey: string;
	privateJwk: JsonWebKey;
}

export const LEDGER_ALGORITHM = 'Ed25519';
export const LEDGER_HASH_ALGORITHM = 'SHA-256';
export const LEDGER_KEYS_SETTING = 'ledger_keys';
export const GENESIS_PREV_HASH = '0'.repeat(64);
export const GENESIS_NOTE = 'Genesis. Zack is not a dad.';
export const GENESIS_STATUS: Status = 'no';
export const CANONICAL_FORMAT = '<seq>|<at>|<status>|<note>|<prevHash>';
/** Longest note we will sign, in Unicode code points. */
export const MAX_NOTE_LENGTH = 1000;
/** How many times appendLedger retries after losing a race for the next seq. */
export const MAX_APPEND_RETRIES = 3;

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
/** Enough to read the whole chain for verification (status changes are, mercifully, rare). */
export const LEDGER_SNAPSHOT_LIMIT = MAX_LIMIT;
const HEX_64 = /^[0-9a-f]{64}$/;
const ED25519 = { name: LEDGER_ALGORITHM } as const;
const encoder = new TextEncoder();

// ── Pure crypto (no D1; unit-tested) ────────────────────────────────────────

/** The exact string an entry's hash is computed over. */
export function canonicalString(fields: LedgerFields): string {
	return `${fields.seq}|${fields.at}|${fields.status}|${fields.note}|${fields.prevHash}`;
}

/** Lowercase hex SHA-256 of the canonical string. */
export function hashLedgerFields(fields: LedgerFields): Promise<string> {
	return sha256Hex(canonicalString(fields));
}

/** Fresh extractable Ed25519 key pair, in the shape stored in `settings`. */
export async function generateLedgerKeys(): Promise<StoredLedgerKeys> {
	const pair = (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair;
	const raw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
	const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
	return { publicKey: base64UrlEncode(raw), privateJwk };
}

/** Import the signing key. Only the fields Ed25519 needs are passed on, so runtimes that disagree about `alg` still agree. */
export async function importLedgerPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
	if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
		throw new Error('Ledger private key is not an Ed25519 JWK');
	}
	const clean: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x };
	return crypto.subtle.importKey('jwk', clean, ED25519, false, ['sign']);
}

/** Import a base64url raw 32-byte Ed25519 public key. */
export async function importLedgerPublicKey(publicKey: string): Promise<CryptoKey> {
	const raw = base64UrlDecode(publicKey);
	if (raw.byteLength !== 32) throw new Error('An Ed25519 public key is exactly 32 bytes');
	return crypto.subtle.importKey('raw', raw, ED25519, true, ['verify']);
}

/** base64url Ed25519 signature over the UTF-8 bytes of the hash hex string. */
export async function signLedgerHash(hash: string, privateKey: CryptoKey): Promise<string> {
	return base64UrlEncode(await crypto.subtle.sign(ED25519, privateKey, encoder.encode(hash)));
}

/** True if `signature` is a valid signature of `hash`. Never throws (malformed input is just invalid). */
export async function verifyLedgerSignature(hash: string, signature: string, publicKey: CryptoKey): Promise<boolean> {
	try {
		const sig = base64UrlDecode(signature);
		if (sig.byteLength !== 64) return false;
		return await crypto.subtle.verify(ED25519, publicKey, sig, encoder.encode(hash));
	} catch {
		return false;
	}
}

/** Hash and sign a set of fields into a complete entry. */
export async function createLedgerEntry(fields: LedgerFields, privateKey: CryptoKey): Promise<LedgerEntry> {
	const hash = await hashLedgerFields(fields);
	const signature = await signLedgerHash(hash, privateKey);
	return { ...fields, hash, signature };
}

/** The genesis entry (seq 0) for a given timestamp. */
export function createGenesisEntry(at: string, privateKey: CryptoKey): Promise<LedgerEntry> {
	return createLedgerEntry(
		{ seq: 0, at, status: GENESIS_STATUS, note: GENESIS_NOTE, prevHash: GENESIS_PREV_HASH },
		privateKey,
	);
}

/**
 * Verify a complete chain, oldest first, starting at genesis. Checks, for every
 * entry: seq is contiguous from 0, prevHash links to the previous hash (64 zeros
 * for genesis), the hash matches the contents, and the signature is valid for
 * `publicKey` (a base64url raw key or an imported CryptoKey). Pure: no I/O.
 */
export async function verifyLedger(
	entries: readonly LedgerEntry[],
	publicKey: string | CryptoKey,
): Promise<LedgerVerification> {
	const count = entries.length;
	if (count === 0) {
		return { valid: false, entries: 0, brokenAt: 0, reason: 'The ledger is empty: not even a genesis entry.' };
	}

	let key: CryptoKey;
	try {
		key = typeof publicKey === 'string' ? await importLedgerPublicKey(publicKey) : publicKey;
	} catch {
		return { valid: false, entries: count, brokenAt: 0, reason: 'The public key is not a valid Ed25519 key.' };
	}

	let prevHash = GENESIS_PREV_HASH;
	for (let i = 0; i < count; i++) {
		const entry = entries[i] as LedgerEntry;
		const broken = (reason: string): LedgerVerification => ({ valid: false, entries: count, brokenAt: i, reason });

		if (entry.seq !== i) {
			return broken(`Expected seq ${i} but found ${String(entry.seq)}: an entry is missing, duplicated or out of order.`);
		}
		if (!isStatus(entry.status)) return broken(`Entry ${i} has an unknown status.`);
		if (typeof entry.at !== 'string' || typeof entry.note !== 'string') {
			return broken(`Entry ${i} is malformed.`);
		}
		if (entry.prevHash !== prevHash) {
			return broken(
				i === 0
					? 'The genesis entry does not point at 64 zeros.'
					: `Entry ${i} does not point at the hash of entry ${i - 1}.`,
			);
		}
		if (typeof entry.hash !== 'string' || !HEX_64.test(entry.hash)) {
			return broken(`Entry ${i} has a malformed hash.`);
		}
		if ((await hashLedgerFields(entry)) !== entry.hash) {
			return broken(`Entry ${i} has been edited: its contents no longer match its hash.`);
		}
		if (typeof entry.signature !== 'string' || !(await verifyLedgerSignature(entry.hash, entry.signature, key))) {
			return broken(`Entry ${i} has an invalid signature.`);
		}
		prevHash = entry.hash;
	}
	return { valid: true, entries: count };
}

/** Trim, strip control characters, NFC-normalise and cap a note; fall back to the status's default note. */
export function normaliseLedgerNote(note: unknown, status: Status): string {
	const cleaned = (typeof note === 'string' ? note : '')
		.normalize('NFC')
		.replace(/\r\n?/g, '\n')
		.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
		.trim();
	const capped = [...cleaned].slice(0, MAX_NOTE_LENGTH).join('').trim();
	return capped || STATUS_COPY[status].ledgerNote;
}

/**
 * Source of a small, dependency-free verifier (an ES module using only fetch +
 * WebCrypto), shown on /ledger and served at /ledger/verify.mjs. It re-implements
 * verifyLedger from scratch so nobody has to trust this file to check this file.
 */
export function ledgerVerifierScript(origin: string, publicKey: string): string {
	return `// verify-dad-ledger.mjs: re-checks every hash, link and Ed25519 signature in the Dad Ledger.
// Node 22+, Deno, or a modern browser console. No dependencies. No trust required.
const ORIGIN = ${JSON.stringify(origin)};
// The key you wrote down the first time. Set to null to accept whatever the server says.
const PINNED_KEY = ${JSON.stringify(publicKey)};

const { publicKey, entries } = await (await fetch(\`\${ORIGIN}/api/ledger\`)).json();
if (PINNED_KEY && publicKey !== PINNED_KEY) throw new Error('The public key has changed. Be suspicious.');

const bytes = (b64url) => Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
const utf8 = (text) => new TextEncoder().encode(text);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const key = await crypto.subtle.importKey('raw', bytes(publicKey), { name: 'Ed25519' }, false, ['verify']);

let prevHash = '0'.repeat(64);
for (const [i, e] of entries.entries()) {
  const canonical = \`\${e.seq}|\${e.at}|\${e.status}|\${e.note}|\${e.prevHash}\`;
  const hash = hex(await crypto.subtle.digest('SHA-256', utf8(canonical)));
  const signed = await crypto.subtle.verify('Ed25519', key, bytes(e.signature), utf8(hash));
  if (e.seq !== i || e.prevHash !== prevHash || e.hash !== hash || !signed) {
    throw new Error(\`Chain broken at seq \${i}. Somebody has been editing history.\`);
  }
  prevHash = hash;
}
const head = entries.at(-1);
console.log(\`✅ \${entries.length} entries verified. Latest (seq \${head.seq}, \${head.status}): \${head.note}\`);
`;
}

// ── Keys (D1 settings) ──────────────────────────────────────────────────────

interface LedgerKeys {
	publicKey: string;
	privateKey: CryptoKey;
}

// Imported keys, per isolate, keyed by the stored JSON so a changed setting is noticed.
let keyCache: { raw: string; keys: Promise<LedgerKeys> } | null = null;

function parseStoredKeys(raw: string): StoredLedgerKeys {
	const parsed = JSON.parse(raw) as Partial<StoredLedgerKeys> | null;
	if (!parsed || typeof parsed.publicKey !== 'string' || !parsed.privateJwk || typeof parsed.privateJwk !== 'object') {
		throw new Error('ledger_keys setting is malformed');
	}
	if (parsed.privateJwk.x !== parsed.publicKey) {
		throw new Error('ledger_keys public key does not match the private key');
	}
	return { publicKey: parsed.publicKey, privateJwk: parsed.privateJwk };
}

async function loadLedgerKeys(env: Env): Promise<LedgerKeys> {
	const raw = await getOrCreateSetting(env, LEDGER_KEYS_SETTING, async () => JSON.stringify(await generateLedgerKeys()));
	if (keyCache?.raw === raw) return keyCache.keys;
	const keys = (async () => {
		const stored = parseStoredKeys(raw);
		return { publicKey: stored.publicKey, privateKey: await importLedgerPrivateKey(stored.privateJwk) };
	})();
	keyCache = { raw, keys };
	keys.catch(() => {
		if (keyCache?.keys === keys) keyCache = null;
	});
	return keys;
}

/** The ledger's public key (base64url, raw 32 bytes). Generates the key pair on first use. */
export async function getLedgerPublicKey(env: Env): Promise<string> {
	return (await loadLedgerKeys(env)).publicKey;
}

// ── D1 ──────────────────────────────────────────────────────────────────────

interface LedgerRow {
	seq: number;
	at: string;
	status: Status;
	note: string;
	prev_hash: string;
	hash: string;
	signature: string;
}

const COLUMNS = 'seq, at, status, note, prev_hash, hash, signature';

function rowToEntry(row: LedgerRow): LedgerEntry {
	return {
		seq: row.seq,
		at: row.at,
		status: row.status,
		note: row.note,
		prevHash: row.prev_hash,
		hash: row.hash,
		signature: row.signature,
	};
}

/** Insert an entry unless its seq is taken. Returns true if this call won the seq. */
async function insertEntry(env: Env, entry: LedgerEntry): Promise<boolean> {
	const result = await env.DB.prepare(
		`INSERT INTO ledger (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (seq) DO NOTHING`,
	)
		.bind(entry.seq, entry.at, entry.status, entry.note, entry.prevHash, entry.hash, entry.signature)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

/** Write the genesis entry if there isn't one. Concurrent callers converge on whichever insert wins. */
async function ensureGenesis(env: Env, keys: LedgerKeys): Promise<void> {
	await insertEntry(env, await createGenesisEntry(nowIso(), keys.privateKey));
}

async function readHead(env: Env): Promise<{ seq: number; hash: string } | null> {
	return env.DB.prepare('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1').first<{ seq: number; hash: string }>();
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Append an entry (creating the genesis entry + signing keys on first use). Never throws. */
export async function appendLedger(env: Env, input: { status: Status; note: string }): Promise<LedgerEntry | null> {
	try {
		if (!isStatus(input.status)) {
			console.error('ledger append refused: unknown status', input.status);
			return null;
		}
		const note = normaliseLedgerNote(input.note, input.status);
		const keys = await loadLedgerKeys(env);

		let head = await readHead(env);
		if (!head) {
			await ensureGenesis(env, keys);
			head = await readHead(env);
			if (!head) throw new Error('genesis entry vanished immediately after being written');
		}

		// seq = MAX(seq) + 1. Two concurrent appends can pick the same seq; the loser
		// re-reads the head and re-signs against the winner's hash.
		for (let attempt = 0; attempt <= MAX_APPEND_RETRIES; attempt++) {
			const entry = await createLedgerEntry(
				{ seq: head.seq + 1, at: nowIso(), status: input.status, note, prevHash: head.hash },
				keys.privateKey,
			);
			if (await insertEntry(env, entry)) return entry;
			if (attempt === MAX_APPEND_RETRIES) break;
			await pause((attempt + 1) * (10 + Math.random() * 40));
			const latest = await readHead(env);
			if (!latest) throw new Error('ledger head disappeared during append');
			head = latest;
		}
		console.error(`ledger append gave up after ${MAX_APPEND_RETRIES} retries (seq contention)`);
		return null;
	} catch (err) {
		console.error('ledger append failed:', err);
		return null;
	}
}

/**
 * Ledger entries, oldest first. With `limit`, the newest `limit` entries (still
 * oldest first); default 1000. Writes the genesis entry if the ledger is empty.
 */
export async function getLedger(env: Env, opts: { limit?: number } = {}): Promise<LedgerEntry[]> {
	const requested = Number.isFinite(opts.limit) ? Math.floor(opts.limit as number) : DEFAULT_LIMIT;
	const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
	const read = async () =>
		(
			await env.DB.prepare(`SELECT ${COLUMNS} FROM ledger ORDER BY seq DESC LIMIT ?`).bind(limit).all<LedgerRow>()
		).results;

	let rows = await read();
	if (rows.length === 0) {
		try {
			await ensureGenesis(env, await loadLedgerKeys(env));
			rows = await read();
		} catch (err) {
			console.error('ledger genesis failed:', err);
		}
	}
	return rows.reverse().map(rowToEntry);
}

export interface LedgerSummary {
	publicKey: string;
	count: number;
	head: LedgerEntry | null;
}

/** Public key, entry count and newest entry, without reading the whole chain. */
export async function getLedgerSummary(env: Env): Promise<LedgerSummary> {
	const publicKey = await getLedgerPublicKey(env);
	const [countResult, headResult] = await env.DB.batch<unknown>([
		env.DB.prepare('SELECT COUNT(*) AS n FROM ledger'),
		env.DB.prepare(`SELECT ${COLUMNS} FROM ledger ORDER BY seq DESC LIMIT 1`),
	]);
	const count = (countResult?.results[0] as { n: number } | undefined)?.n ?? 0;
	const headRow = (headResult?.results[0] as LedgerRow | undefined) ?? null;
	if (count > 0 && headRow) return { publicKey, count, head: rowToEntry(headRow) };
	// Empty ledger: getLedger writes the genesis entry.
	const entries = await getLedger(env, { limit: 1 });
	return { publicKey, count: entries.length, head: entries[0] ?? null };
}
