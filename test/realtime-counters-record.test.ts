import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Worker side of check counting: decide whether a request counts, then one RPC to the
// WaitingRoom (which does the tallying and the D1 writes; see realtime-room-checks).
const room = vi.hoisted(() => ({
	recordCheck: vi.fn(async (_check: unknown) => {}),
	checkTotal: vi.fn(async () => 0),
}));
vi.mock('../src/lib/live', () => ({ waitingRoom: () => room }));

const {
	CHECK_TOTAL_SQL,
	checkFromRequest,
	checkUpserts,
	emptyCheckTallies,
	getCheckStats,
	getCheckTotal,
	mergeCheckTallies,
	parseCheckEvent,
	recordCheck,
	tallyCheck,
} = await import('../src/lib/counters');

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

function request(path = '/api/status', cf: Record<string, unknown> = { country: 'GB', colo: 'LHR' }, ua = BROWSER): Request {
	const req = new Request(`https://iszacka.dad${path}`, { headers: { 'user-agent': ua } });
	Object.defineProperty(req, 'cf', { value: cf });
	return req;
}

/** A D1 that records every call, so a test can say "none". */
function spyDb(total = 0) {
	const calls: string[] = [];
	return {
		calls,
		prepare(sql: string) {
			calls.push(`prepare ${sql}`);
			return {
				bind: () => ({}),
				async first() {
					calls.push(`first ${sql}`);
					return { total };
				},
			};
		},
		async batch() {
			calls.push('batch');
			return [];
		},
	};
}

describe('recordCheck', () => {
	beforeEach(() => {
		room.recordCheck.mockReset();
		room.recordCheck.mockResolvedValue(undefined);
	});

	it('sends the waiting room one tiny check, and touches D1 not at all', async () => {
		const db = spyDb();
		const env = { DB: db } as unknown as Env;
		await recordCheck(env, request('/', { country: 'gb', colo: 'lhr', city: 'London' }));
		expect(room.recordCheck).toHaveBeenCalledTimes(1);
		const [check] = room.recordCheck.mock.calls[0] ?? [];
		expect(Object.keys(check as object).sort()).toEqual(['colo', 'country', 'day', 'hour']);
		expect(check).toMatchObject({ country: 'gb', colo: 'lhr' }); // normalised by the room
		expect((check as { day: string }).day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(db.calls).toEqual([]);
	});

	it('uses the London day and hour', () => {
		// 23:30 UTC on 1 July is 00:30 on 2 July in London (BST).
		const check = checkFromRequest(request(), new Date('2026-07-01T23:30:00Z'));
		expect(check).toEqual({ day: '2026-07-02', hour: 0, country: 'GB', colo: 'LHR' });
		// Winter: London is UTC.
		expect(checkFromRequest(request(), new Date('2026-12-01T23:30:00Z'))).toMatchObject({ day: '2026-12-01', hour: 23 });
	});

	it("doesn't count bots, verified bots, prefetches or refresh polls", async () => {
		const env = { DB: spyDb() } as unknown as Env;
		await recordCheck(env, request('/', {}, 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'));
		await recordCheck(env, request('/', { botManagement: { verifiedBot: true } }));
		await recordCheck(env, request('/api/status?poll=1'));
		const prefetch = new Request('https://iszacka.dad/', { headers: { 'user-agent': BROWSER, 'sec-purpose': 'prefetch' } });
		await recordCheck(env, prefetch);
		expect(room.recordCheck).not.toHaveBeenCalled();
	});

	it('bounds what it forwards from cf, and copes without cf', () => {
		expect(checkFromRequest(request('/', { country: 'X'.repeat(500), colo: 42 }))).toMatchObject({ country: 'XXXXXXXX', colo: '' });
		const bare = new Request('https://iszacka.dad/', { headers: { 'user-agent': BROWSER } });
		expect(checkFromRequest(bare)).toMatchObject({ country: '', colo: '' });
	});

	it('never rejects, even when the waiting room is down', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		room.recordCheck.mockRejectedValueOnce(new Error('DO unavailable'));
		await expect(recordCheck({ DB: spyDb() } as unknown as Env, request())).resolves.toBeUndefined();
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});

describe('parseCheckEvent (the waiting room side)', () => {
	it('normalises country and colo', () => {
		expect(parseCheckEvent({ day: '2026-11-07', hour: 9, country: 'gb', colo: 'lhr' })).toEqual({
			day: '2026-11-07',
			hour: 9,
			country: 'GB',
			colo: 'LHR',
		});
		expect(parseCheckEvent({ day: '2026-11-07', hour: 0, country: '<b>', colo: '' })).toMatchObject({ country: 'XX', colo: 'XXX' });
	});

	it('rejects anything that is not a check', () => {
		for (const bad of [
			null,
			'check',
			{},
			{ day: '2026-13-01', hour: 1 },
			{ day: '7 Nov', hour: 1 },
			{ day: '2026-11-07', hour: 24 },
			{ day: '2026-11-07', hour: -1 },
			{ day: '2026-11-07', hour: 1.5 },
			{ day: '2026-11-07', hour: '9' },
		]) {
			expect(parseCheckEvent(bad)).toBeNull();
		}
	});
});

describe('check tallies', () => {
	it('turns N checks into one upsert per distinct key', () => {
		const t = emptyCheckTallies();
		for (let i = 0; i < 50; i++) tallyCheck(t, { day: '2026-11-07', hour: 9, country: i % 2 ? 'GB' : 'FR', colo: 'LHR' });
		const rows = checkUpserts(t);
		// daily + hourly + 2 countries + 1 colo
		expect(rows).toHaveLength(5);
		expect(rows.find((r) => r.sql.includes('checks_daily'))?.args).toEqual(['2026-11-07', 50]);
		expect(rows.find((r) => r.sql.includes('checks_country') && r.args[0] === 'GB')?.args[1]).toBe(25);
		expect(rows.every((r) => r.sql.includes('count = count + excluded.count'))).toBe(true);
		expect(t.total).toBe(50);
	});

	it('merges a failed batch back in', () => {
		const a = emptyCheckTallies();
		const b = emptyCheckTallies();
		tallyCheck(a, { day: '2026-11-07', hour: 9, country: 'GB', colo: 'LHR' });
		tallyCheck(b, { day: '2026-11-07', hour: 10, country: 'GB', colo: 'MAN' });
		mergeCheckTallies(a, b);
		expect(a.total).toBe(2);
		expect(a.daily.get('2026-11-07')).toBe(2);
		expect(a.country.get('GB')).toBe(2);
		expect([...a.hourly.keys()].sort((x, y) => x - y)).toEqual([9, 10]);
		expect(checkUpserts(emptyCheckTallies())).toEqual([]);
	});
});

describe('getCheckTotal', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
		room.checkTotal.mockReset();
	});
	afterEach(() => vi.useRealTimers());

	it('asks the waiting room (one RPC, no D1), and reuses the answer for a moment', async () => {
		const db = spyDb(5);
		const env = { DB: db } as unknown as Env;
		room.checkTotal.mockResolvedValue(1234);
		expect(await getCheckTotal(env)).toBe(1234);
		expect(await getCheckTotal(env)).toBe(1234);
		expect(room.checkTotal).toHaveBeenCalledTimes(1);
		expect(db.calls).toEqual([]);
		vi.advanceTimersByTime(5_000);
		room.checkTotal.mockResolvedValue(1240);
		expect(await getCheckTotal(env)).toBe(1240);
	});

	it("falls back to D1 when the waiting room is down, but doesn't go backwards", async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.advanceTimersByTime(60_000);
		room.checkTotal.mockResolvedValueOnce(2000);
		const env = { DB: spyDb(1990) } as unknown as Env;
		expect(await getCheckTotal(env)).toBe(2000);

		vi.advanceTimersByTime(5_000);
		room.checkTotal.mockRejectedValue(new Error('DO unavailable'));
		const db = spyDb(1990); // D1 hasn't caught up with the room's last few seconds
		expect(await getCheckTotal({ DB: db } as unknown as Env)).toBe(2000);
		expect(db.calls).toContain(`first ${CHECK_TOTAL_SQL}`);

		vi.advanceTimersByTime(5_000);
		expect(await getCheckTotal({ DB: spyDb(2100) } as unknown as Env)).toBe(2100);

		vi.advanceTimersByTime(5_000);
		const broken = { DB: { prepare: () => ({ first: async () => Promise.reject(new Error('D1 down')) }) } } as unknown as Env;
		expect(await getCheckTotal(broken)).toBe(2100);
		error.mockRestore();
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

describe('isRefreshPoll', () => {
	it('spots ?poll, however it is spelt, and nothing else', async () => {
		const { isRefreshPoll } = await import('../src/lib/counters');
		const at = (path: string) => isRefreshPoll(new Request(`https://iszacka.dad${path}`));
		expect(at('/api/status?poll=1')).toBe(true);
		expect(at('/api/status?x=1&poll')).toBe(true);
		expect(at('/api/status?%70oll=1')).toBe(true);
		expect(at('/api/status')).toBe(false);
		expect(at('/api/status?x=1')).toBe(false);
		expect(at('/api/status?polling=1')).toBe(false);
		expect(at('/poll')).toBe(false);
	});
});
