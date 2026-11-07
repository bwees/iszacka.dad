import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createGenesisEntry,
	createLedgerEntry,
	generateLedgerKeys,
	importLedgerPrivateKey,
	type LedgerEntry,
	type StoredLedgerKeys,
	verifyLedger,
} from '../src/lib/ledger';
import { ledgerRoutes, resetLedgerVerificationCache, verifyLedgerCached } from '../src/routes/ledger';
import type { AppEnv } from '../src/types';

let keys: StoredLedgerKeys;
let otherKeys: StoredLedgerKeys;
let chain: LedgerEntry[];

beforeAll(async () => {
	keys = await generateLedgerKeys();
	otherKeys = await generateLedgerKeys();
	const privateKey = await importLedgerPrivateKey(keys.privateJwk);
	chain = [await createGenesisEntry('2026-11-01T09:00:00.000Z', privateKey)];
	for (const [i, status] of (['soon', 'yes'] as const).entries()) {
		const prev = chain.at(-1) as LedgerEntry;
		chain.push(
			await createLedgerEntry(
				{ seq: i + 1, at: `2026-11-0${i + 2}T12:00:00.000Z`, status, note: `entry ${i + 1}`, prevHash: prev.hash },
				privateKey,
			),
		);
	}
});

/** A fresh deep copy, as each D1 read would return. */
const copy = (entries: LedgerEntry[]) => entries.map((e) => ({ ...e }));

let verifySpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	resetLedgerVerificationCache();
	verifySpy = vi.spyOn(crypto.subtle, 'verify');
});
afterEach(() => verifySpy.mockRestore());

describe('verifyLedgerCached', () => {
	it('gives the same answer as verifyLedger', async () => {
		expect(await verifyLedgerCached(copy(chain), keys.publicKey)).toEqual(await verifyLedger(chain, keys.publicKey));
	});

	it('checks the signatures once per isolate while the chain is unchanged', async () => {
		await verifyLedgerCached(copy(chain), keys.publicKey);
		expect(verifySpy).toHaveBeenCalledTimes(chain.length);
		for (let i = 0; i < 3; i++) {
			expect(await verifyLedgerCached(copy(chain), keys.publicKey)).toEqual({ valid: true, entries: chain.length });
		}
		expect(verifySpy).toHaveBeenCalledTimes(chain.length);
	});

	it('re-verifies when a new entry arrives', async () => {
		await verifyLedgerCached(copy(chain.slice(0, 2)), keys.publicKey);
		verifySpy.mockClear();
		expect(await verifyLedgerCached(copy(chain), keys.publicKey)).toEqual({ valid: true, entries: chain.length });
		expect(verifySpy).toHaveBeenCalledTimes(chain.length);
	});

	it('re-verifies under a different public key', async () => {
		await verifyLedgerCached(copy(chain), keys.publicKey);
		const result = await verifyLedgerCached(copy(chain), otherKeys.publicKey);
		expect(result.valid).toBe(false);
		expect(result.brokenAt).toBe(0);
	});

	it('still catches an edited past entry when the head is untouched', async () => {
		expect((await verifyLedgerCached(copy(chain), keys.publicKey)).valid).toBe(true);
		const edited = copy(chain);
		(edited[1] as LedgerEntry).note = 'History, revised.';
		const result = await verifyLedgerCached(edited, keys.publicKey);
		expect(result.valid).toBe(false);
		expect(result.brokenAt).toBe(1);
		// ...and goes back to valid once the row is put right.
		expect((await verifyLedgerCached(copy(chain), keys.publicKey)).valid).toBe(true);
	});

	it("hands out copies, so a caller can't poison the memo", async () => {
		const first = await verifyLedgerCached(copy(chain), keys.publicKey);
		(first as { valid: boolean }).valid = false;
		expect((await verifyLedgerCached(copy(chain), keys.publicKey)).valid).toBe(true);
	});
});

describe('ledger routes reuse the verification', () => {
	function env(): Env {
		const rows = chain.map((e) => ({
			seq: e.seq,
			at: e.at,
			status: e.status,
			note: e.note,
			prev_hash: e.prevHash,
			hash: e.hash,
			signature: e.signature,
		}));
		const stored = JSON.stringify(keys);
		return {
			DB: {
				prepare(sql: string) {
					const stmt = {
						bind: () => stmt,
						first: async () => (sql.includes('FROM settings') ? { value: stored } : null),
						all: async () => ({ results: sql.includes('FROM ledger') ? rows.map((r) => ({ ...r })).reverse() : [] }),
						run: async () => ({}),
					};
					return stmt;
				},
			},
		} as unknown as Env;
	}

	it('verifies the chain on the first hit only', async () => {
		const app = new Hono<AppEnv>();
		app.use('*', async (c, next) => {
			c.set('state', { status: 'yes', statusChangedAt: '2026-11-03T12:00:00.000Z', dueDate: null });
			await next();
		});
		app.route('/', ledgerRoutes);
		const e = env();

		for (const path of ['/api/ledger', '/api/ledger', '/ledger']) {
			const res = await app.request(path, { headers: { accept: 'application/json' } }, e);
			expect(res.status, path).toBe(200);
			expect(res.headers.get('x-ledger-verified'), path).toBe('true');
			const body = (await res.json()) as { verification: { valid: boolean; entries: number } };
			expect(body.verification).toMatchObject({ valid: true, entries: chain.length });
		}
		expect(verifySpy).toHaveBeenCalledTimes(chain.length);
	});
});
