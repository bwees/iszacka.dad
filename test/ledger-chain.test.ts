import { beforeAll, describe, expect, it } from 'vitest';
import {
	canonicalString,
	createGenesisEntry,
	createLedgerEntry,
	GENESIS_NOTE,
	GENESIS_PREV_HASH,
	generateLedgerKeys,
	hashLedgerFields,
	importLedgerPrivateKey,
	importLedgerPublicKey,
	type LedgerEntry,
	ledgerVerifierScript,
	MAX_NOTE_LENGTH,
	normaliseLedgerNote,
	signLedgerHash,
	type StoredLedgerKeys,
	verifyLedger,
	verifyLedgerSignature,
} from '../src/lib/ledger';
import { base64UrlDecode, base64UrlEncode } from '../src/lib/security';
import type { Status } from '../src/types';

let stored: StoredLedgerKeys;
let privateKey: CryptoKey;
let chain: LedgerEntry[];

async function buildChain(key: CryptoKey, steps: Array<{ status: Status; note: string }>): Promise<LedgerEntry[]> {
	const entries: LedgerEntry[] = [await createGenesisEntry('2026-11-01T09:00:00.000Z', key)];
	for (const [i, step] of steps.entries()) {
		const prev = entries[entries.length - 1] as LedgerEntry;
		entries.push(
			await createLedgerEntry(
				{ seq: prev.seq + 1, at: `2026-11-0${i + 2}T12:00:00.000Z`, status: step.status, note: step.note, prevHash: prev.hash },
				key,
			),
		);
	}
	return entries;
}

beforeAll(async () => {
	stored = await generateLedgerKeys();
	privateKey = await importLedgerPrivateKey(stored.privateJwk);
	chain = await buildChain(privateKey, [
		{ status: 'soon', note: 'Labour has started. Zack is about to be a dad.' },
		{ status: 'yes', note: 'Zack is a dad. | Pipes | in | notes | are fine.' },
	]);
});

describe('ledger keys', () => {
	it('stores a raw 32-byte public key that matches the private JWK', async () => {
		expect(base64UrlDecode(stored.publicKey).byteLength).toBe(32);
		expect(stored.privateJwk.x).toBe(stored.publicKey);
		await expect(importLedgerPublicKey(stored.publicKey)).resolves.toBeDefined();
	});

	it('rejects a public key of the wrong length', async () => {
		await expect(importLedgerPublicKey('AAAA')).rejects.toThrow();
	});
});

describe('canonicalisation and hashing', () => {
	it('builds the documented canonical string', () => {
		expect(
			canonicalString({ seq: 3, at: '2026-11-06T21:30:00.000Z', status: 'yes', note: 'Hello', prevHash: 'ab'.repeat(32) }),
		).toBe(`3|2026-11-06T21:30:00.000Z|yes|Hello|${'ab'.repeat(32)}`);
	});

	it('hashes to 64 lowercase hex characters', async () => {
		const hash = await hashLedgerFields({ seq: 0, at: 'x', status: 'no', note: 'n', prevHash: GENESIS_PREV_HASH });
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('signs the hash hex string, not the raw digest', async () => {
		const genesis = chain[0] as LedgerEntry;
		const publicKey = await importLedgerPublicKey(stored.publicKey);
		const raw = Uint8Array.from(genesis.hash.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
		const sig = base64UrlDecode(genesis.signature);
		expect(await crypto.subtle.verify('Ed25519', publicKey, sig, new TextEncoder().encode(genesis.hash))).toBe(true);
		expect(await crypto.subtle.verify('Ed25519', publicKey, sig, raw)).toBe(false);
	});

	it('produces deterministic Ed25519 signatures', async () => {
		const genesis = chain[0] as LedgerEntry;
		expect(await signLedgerHash(genesis.hash, privateKey)).toBe(genesis.signature);
	});
});

describe('genesis', () => {
	it('is seq 0, status no, pointing at 64 zeros', () => {
		const genesis = chain[0] as LedgerEntry;
		expect(genesis.seq).toBe(0);
		expect(genesis.status).toBe('no');
		expect(genesis.note).toBe(GENESIS_NOTE);
		expect(genesis.prevHash).toBe('0'.repeat(64));
	});
});

describe('verifyLedger', () => {
	it('accepts an untouched chain', async () => {
		expect(await verifyLedger(chain, stored.publicKey)).toEqual({ valid: true, entries: 3 });
	});

	it('accepts an imported CryptoKey as well as a base64url key', async () => {
		const key = await importLedgerPublicKey(stored.publicKey);
		expect((await verifyLedger(chain, key)).valid).toBe(true);
	});

	it('accepts a genesis-only chain', async () => {
		expect(await verifyLedger(chain.slice(0, 1), stored.publicKey)).toEqual({ valid: true, entries: 1 });
	});

	it('rejects an empty ledger', async () => {
		const result = await verifyLedger([], stored.publicKey);
		expect(result.valid).toBe(false);
		expect(result.entries).toBe(0);
	});

	it('detects a changed note', async () => {
		const tampered = chain.map((e) => ({ ...e }));
		(tampered[1] as LedgerEntry).note = 'Zack has always been a dad. Trust me.';
		const result = await verifyLedger(tampered, stored.publicKey);
		expect(result).toMatchObject({ valid: false, entries: 3, brokenAt: 1 });
		expect(result.reason).toMatch(/edited/);
	});

	it('detects a changed status in the head entry', async () => {
		const tampered = chain.map((e) => ({ ...e }));
		(tampered[2] as LedgerEntry).status = 'no';
		expect(await verifyLedger(tampered, stored.publicKey)).toMatchObject({ valid: false, brokenAt: 2 });
	});

	it('detects a re-hashed entry because the next prevHash no longer links', async () => {
		const tampered = chain.map((e) => ({ ...e }));
		const forged = await createLedgerEntry({ ...(tampered[1] as LedgerEntry), note: 'Forged, but re-signed.' }, privateKey);
		tampered[1] = forged;
		const result = await verifyLedger(tampered, stored.publicKey);
		expect(result).toMatchObject({ valid: false, brokenAt: 2 });
		expect(result.reason).toMatch(/does not point at the hash of entry 1/);
	});

	it('detects a bad signature', async () => {
		const tampered = chain.map((e) => ({ ...e }));
		const sig = base64UrlDecode((tampered[2] as LedgerEntry).signature);
		sig[0] = (sig[0] as number) ^ 0xff;
		(tampered[2] as LedgerEntry).signature = base64UrlEncode(sig);
		const result = await verifyLedger(tampered, stored.publicKey);
		expect(result).toMatchObject({ valid: false, entries: 3, brokenAt: 2 });
		expect(result.reason).toMatch(/signature/);
	});

	it('detects garbage in the signature field without throwing', async () => {
		const tampered = chain.map((e) => ({ ...e }));
		(tampered[0] as LedgerEntry).signature = '!!! not base64 !!!';
		expect(await verifyLedger(tampered, stored.publicKey)).toMatchObject({ valid: false, brokenAt: 0 });
	});

	it('detects a chain re-signed with somebody else’s key', async () => {
		const impostor = await generateLedgerKeys();
		const forgedChain = await buildChain(await importLedgerPrivateKey(impostor.privateJwk), [
			{ status: 'yes', note: 'Zack is a dad. Source: me.' },
		]);
		expect(await verifyLedger(forgedChain, stored.publicKey)).toMatchObject({ valid: false, brokenAt: 0 });
		expect((await verifyLedger(forgedChain, impostor.publicKey)).valid).toBe(true);
	});

	it('detects a deleted entry', async () => {
		const result = await verifyLedger([chain[0], chain[2]] as LedgerEntry[], stored.publicKey);
		expect(result).toMatchObject({ valid: false, brokenAt: 1 });
		expect(result.reason).toMatch(/Expected seq 1/);
	});

	it('detects a missing genesis entry', async () => {
		expect(await verifyLedger(chain.slice(1), stored.publicKey)).toMatchObject({ valid: false, brokenAt: 0 });
	});

	it('detects a genesis entry that does not point at zeros', async () => {
		const genesis = await createLedgerEntry(
			{ seq: 0, at: '2026-11-01T09:00:00.000Z', status: 'no', note: GENESIS_NOTE, prevHash: 'f'.repeat(64) },
			privateKey,
		);
		const result = await verifyLedger([genesis], stored.publicKey);
		expect(result).toMatchObject({ valid: false, brokenAt: 0 });
		expect(result.reason).toMatch(/64 zeros/);
	});

	it('rejects a malformed public key without throwing', async () => {
		expect(await verifyLedger(chain, 'not-a-key')).toMatchObject({ valid: false, brokenAt: 0 });
	});
});

describe('verifyLedgerSignature', () => {
	it('returns false for a truncated signature', async () => {
		const key = await importLedgerPublicKey(stored.publicKey);
		const genesis = chain[0] as LedgerEntry;
		expect(await verifyLedgerSignature(genesis.hash, genesis.signature.slice(0, 20), key)).toBe(false);
	});
});

describe('normaliseLedgerNote', () => {
	it('trims and strips control characters', () => {
		expect(normaliseLedgerNote('  Hello\u0000 world\u0007  ', 'yes')).toBe('Hello  world');
	});

	it('falls back to the status default for empty notes', () => {
		expect(normaliseLedgerNote('   ', 'soon')).toBe('Labour has started. Zack is about to be a dad.');
		expect(normaliseLedgerNote(undefined, 'yes')).toBe('Zack is a dad.');
	});

	it('caps the length without splitting emoji', () => {
		const note = normaliseLedgerNote('👶'.repeat(MAX_NOTE_LENGTH + 50), 'yes');
		expect([...note]).toHaveLength(MAX_NOTE_LENGTH);
		expect(note.endsWith('👶')).toBe(true);
	});

	it('normalises to NFC so the same text always hashes the same', () => {
		expect(normaliseLedgerNote('café', 'no')).toBe('café');
	});
});

describe('ledgerVerifierScript (the verify-it-yourself snippet)', () => {
	type AsyncFn = (...args: unknown[]) => Promise<unknown>;
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...src: string[]) => AsyncFn;

	async function runVerifier(entries: LedgerEntry[], servedKey = stored.publicKey, pinnedKey = stored.publicKey) {
		const script = ledgerVerifierScript('https://iszacka.dad', pinnedKey);
		const fetched: string[] = [];
		const fakeFetch = async (url: string) => {
			fetched.push(url);
			return new Response(JSON.stringify({ publicKey: servedKey, entries }));
		};
		const logs: string[] = [];
		const fakeConsole = { log: (msg: string) => logs.push(msg) };
		await new AsyncFunction('fetch', 'console', script)(fakeFetch, fakeConsole);
		return { fetched, logs };
	}

	it('is self-contained and pins the current key', () => {
		const script = ledgerVerifierScript('https://iszacka.dad', stored.publicKey);
		expect(script).toContain(`const PINNED_KEY = "${stored.publicKey}";`);
		expect(script).not.toMatch(/\bimport\b|\brequire\(/);
	});

	it('verifies an untouched chain from the API', async () => {
		const { fetched, logs } = await runVerifier(chain);
		expect(fetched).toEqual(['https://iszacka.dad/api/ledger']);
		expect(logs[0]).toMatch(/^✅ 3 entries verified/);
	});

	it('throws on a tampered note, like the server-side verifier', async () => {
		const tampered = chain.map((e) => ({ ...e }));
		(tampered[1] as LedgerEntry).note = 'Edited.';
		await expect(runVerifier(tampered)).rejects.toThrow(/Chain broken at seq 1/);
	});

	it('throws on a bad signature', async () => {
		const tampered = chain.map((e) => ({ ...e }));
		const sig = base64UrlDecode((tampered[2] as LedgerEntry).signature);
		sig[10] = (sig[10] as number) ^ 0x01;
		(tampered[2] as LedgerEntry).signature = base64UrlEncode(sig);
		await expect(runVerifier(tampered)).rejects.toThrow(/Chain broken at seq 2/);
	});

	it('refuses a swapped public key', async () => {
		const impostor = await generateLedgerKeys();
		await expect(runVerifier(chain, impostor.publicKey)).rejects.toThrow(/public key has changed/);
	});
});
