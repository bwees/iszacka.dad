import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const broadcast = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/lib/live', () => ({ broadcast }));

const { CHECK_FLUSH_DELAY_MS, flushChecks, getCheckStats, pendingCheckCount, recordCheck } = await import('../src/lib/counters');

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

function request(path = '/api/status', cf: Record<string, unknown> = { country: 'GB', colo: 'LHR' }): Request {
	const req = new Request(`https://iszacka.dad${path}`, { headers: { 'user-agent': BROWSER } });
	Object.defineProperty(req, 'cf', { value: cf });
	return req;
}

function fakeDb() {
	const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
	let total = 0;
	let failNext = false;
	return {
		batches,
		failNext() {
			failNext = true;
		},
		prepare(sql: string) {
			const stmt = {
				sql,
				args: [] as unknown[],
				bind(...args: unknown[]) {
					stmt.args = args;
					return stmt;
				},
				async first() {
					return { total };
				},
			};
			return stmt;
		},
		async batch(statements: Array<{ sql: string; args: unknown[] }>) {
			if (failNext) {
				failNext = false;
				throw new Error('D1 is having a moment');
			}
			batches.push(statements.map((s) => ({ sql: s.sql, args: s.args })));
			for (const s of statements) if (s.sql.includes('checks_daily')) total += Number(s.args[1]);
			return statements.map(() => ({ results: [] }));
		},
	};
}

describe('check counting', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		await flushChecks({ DB: fakeDb() } as unknown as Env); // start each test with an empty tally
		broadcast.mockClear();
	});
	afterEach(() => vi.useRealTimers());

	it('turns N checks into one batch with one row per distinct key', async () => {
		const db = fakeDb();
		const env = { DB: db } as unknown as Env;
		const first = recordCheck(env, request());
		for (let i = 1; i < 50; i++) await recordCheck(env, request('/', { country: i % 2 ? 'GB' : 'FR', colo: 'LHR' }));
		expect(db.batches).toHaveLength(0); // nothing written per request
		expect(pendingCheckCount()).toBe(50);

		await vi.advanceTimersByTimeAsync(CHECK_FLUSH_DELAY_MS);
		await first;
		expect(db.batches).toHaveLength(1);
		const [batch] = db.batches;
		// daily + hourly + 2 countries + 1 colo
		expect(batch).toHaveLength(5);
		expect(batch?.find((s) => s.sql.includes('checks_daily'))?.args[1]).toBe(50);
		expect(batch?.find((s) => s.sql.includes('checks_country') && s.args[0] === 'GB')?.args[1]).toBe(26);
		expect(batch?.every((s) => s.sql.includes('count + excluded.count'))).toBe(true);
		expect(pendingCheckCount()).toBe(0);
		expect(broadcast).toHaveBeenCalledWith(env, { type: 'checks', checks: 50 });
	});

	it("doesn't count refresh polls", async () => {
		const db = fakeDb();
		const env = { DB: db } as unknown as Env;
		await recordCheck(env, request('/api/status?poll=1'));
		expect(pendingCheckCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(CHECK_FLUSH_DELAY_MS);
		expect(db.batches).toHaveLength(0);
		expect(broadcast).not.toHaveBeenCalled();
	});

	it('keeps the counts when a flush fails', async () => {
		const db = fakeDb();
		const env = { DB: db } as unknown as Env;
		const first = recordCheck(env, request());
		db.failNext();
		await vi.advanceTimersByTimeAsync(CHECK_FLUSH_DELAY_MS);
		await first;
		expect(pendingCheckCount()).toBe(1);
		expect(await flushChecks(env)).toBe(1);
		expect(db.batches).toHaveLength(1);
	});
});

describe('getCheckStats', () => {
	it('reuses the aggregates for a while, and falls back to them when D1 fails', async () => {
		let calls = 0;
		let broken = false;
		const db = {
			prepare: () => ({ bind: () => ({}) }),
			async batch(statements: unknown[]) {
				calls++;
				if (broken) throw new Error('D1 is down');
				return statements.map(() => ({ results: [{ total: 7, n: 0 }] }));
			},
		};
		const env = { DB: db } as unknown as Env;
		const a = await getCheckStats(env, { days: 7, top: 3 });
		const b = await getCheckStats(env, { days: 7, top: 3 });
		expect(calls).toBe(1);
		expect(b).toBe(a);
		broken = true;
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 60_000);
		try {
			expect(await getCheckStats(env, { days: 7, top: 3 })).toEqual(a);
		} finally {
			vi.useRealTimers();
		}
		await expect(getCheckStats(env, { days: 8, top: 3 })).rejects.toThrow('D1 is down');
	});
});
