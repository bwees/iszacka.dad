import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The WaitingRoom's side of check counting, run under Node against a fake DO context and D1.

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));
vi.stubGlobal(
	'WebSocketRequestResponsePair',
	class {
		constructor(
			readonly request: string,
			readonly response: string,
		) {}
	},
);

const { WaitingRoom } = await import('../src/do/waiting-room');
const { CHECK_FLUSH_MS, CHECK_RETRY_MS, CHECK_TICK_MS } = await import('../src/do/waiting-room-protocol');
const { CHECK_TOTAL_SQL } = await import('../src/lib/counters');

const T0 = Date.parse('2026-11-07T12:00:00Z');
const CHECK = { day: '2026-11-07', hour: 12, country: 'gb', colo: 'lhr' };

interface FakeSocket {
	readyState: number;
	sent: string[];
	send(data: string): void;
	close(): void;
	serializeAttachment(): void;
	deserializeAttachment(): unknown;
}

function socket(): FakeSocket {
	return {
		readyState: 1,
		sent: [],
		send(data: string) {
			this.sent.push(data);
		},
		close() {
			this.readyState = 3;
		},
		serializeAttachment() {},
		deserializeAttachment: () => null,
	};
}

/** Durable Object storage + WebSockets, in memory. Survives "hibernation" (a new WaitingRoom on the same ctx). */
function fakeCtx() {
	const kv = new Map<string, unknown>();
	const ctx = {
		alarm: null as number | null,
		sockets: [] as FakeSocket[],
		getWebSocketsCalls: 0,
		storage: {
			sql: {
				exec: (_query: string) => ({ one: () => ({ total: 0 }), toArray: () => [] }),
			},
			kv: {
				get: (key: string) => kv.get(key),
				put: (key: string, value: unknown) => kv.set(key, value),
				delete: (key: string) => kv.delete(key),
			},
			transactionSync: (fn: () => void) => fn(),
			getAlarm: async () => ctx.alarm,
			setAlarm: async (at: number) => {
				ctx.alarm = at;
			},
		},
		getWebSockets() {
			ctx.getWebSocketsCalls++;
			return ctx.sockets;
		},
		setWebSocketAutoResponse() {},
		waitUntil(promise: Promise<unknown>) {
			void promise;
		},
	};
	return ctx;
}

/** D1 with the checks_* tables reduced to what the room writes and reads. */
function fakeDb(total = 0) {
	const db = {
		total,
		batches: [] as Array<Array<{ sql: string; args: unknown[] }>>,
		failNext: false,
		prepare(sql: string) {
			const stmt = {
				sql,
				args: [] as unknown[],
				bind(...args: unknown[]) {
					stmt.args = args;
					return stmt;
				},
				async first() {
					return null; // settings (reload nonce): never set
				},
			};
			return stmt;
		},
		async batch(statements: Array<{ sql: string; args: unknown[] }>) {
			if (db.failNext) {
				db.failNext = false;
				throw new Error('D1 is having a moment');
			}
			db.batches.push(statements.map((s) => ({ sql: s.sql, args: s.args })));
			for (const s of statements) if (s.sql.includes('INSERT INTO checks_daily')) db.total += Number(s.args[1]);
			return statements.map((s) => ({ results: s.sql === CHECK_TOTAL_SQL ? [{ total: db.total }] : [] }));
		},
	};
	return db;
}

function setup(total = 100) {
	const ctx = fakeCtx();
	const db = fakeDb(total);
	const env = { DB: db, ENVIRONMENT: 'production' } as unknown as Env;
	const room = new WaitingRoom(ctx as unknown as DurableObjectState, env);
	return { ctx, db, env, room };
}

const checksSent = (ws: FakeSocket) =>
	ws.sent.map((s) => JSON.parse(s) as { type: string; checks?: number }).filter((m) => m.type === 'checks').map((m) => m.checks);
const upsertsIn = (batch: Array<{ sql: string; args: unknown[] }> | undefined) => (batch ?? []).filter((s) => s.sql !== CHECK_TOTAL_SQL);

/** Run the alarm if it's due by `at`, the way the runtime would. */
async function runAlarmsUntil(ctx: ReturnType<typeof fakeCtx>, room: InstanceType<typeof WaitingRoom>, at: number) {
	for (let i = 0; i < 100 && ctx.alarm !== null && ctx.alarm <= at; i++) {
		vi.setSystemTime(ctx.alarm);
		ctx.alarm = null;
		await room.alarm();
	}
	vi.setSystemTime(at);
}

describe('WaitingRoom check counting', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => vi.useRealTimers());

	it('writes the first check after waking straight away, learning the total, and tells everyone', async () => {
		const { ctx, db, room } = setup(100);
		const ws = socket();
		ctx.sockets.push(ws);
		await room.recordCheck(CHECK);
		expect(db.batches).toHaveLength(1);
		const [batch] = db.batches;
		expect(batch?.at(-1)?.sql).toBe(CHECK_TOTAL_SQL); // the total, read in the same batch
		expect(upsertsIn(batch).map((s) => s.args)).toEqual([
			['2026-11-07', 1],
			[12, 1],
			['GB', 1],
			['LHR', 1],
		]);
		expect(checksSent(ws)).toEqual([101]);
		expect(await room.checkTotal()).toBe(101);
		expect(ctx.alarm).toBeNull(); // nothing left waiting, so nothing to wake up for
	});

	it('keeps later checks in memory and writes them in one batch once traffic goes quiet', async () => {
		const { ctx, db, room } = setup(100);
		await room.recordCheck(CHECK);
		for (let i = 1; i <= 50; i++) {
			vi.setSystemTime(T0 + i * 50);
			await room.recordCheck({ ...CHECK, country: i % 2 ? 'GB' : 'FR' });
		}
		expect(db.batches).toHaveLength(1); // just the first one
		expect(await room.checkTotal()).toBe(151); // running total, no SUM
		expect(await room.liveSnapshot()).toMatchObject({ checks: 151 });
		expect(db.batches).toHaveLength(1);
		expect(ctx.alarm).toBe(T0 + 50 + CHECK_TICK_MS);

		await runAlarmsUntil(ctx, room, T0 + 30_000);
		expect(db.batches).toHaveLength(2);
		const upserts = upsertsIn(db.batches[1]);
		expect(upserts).toHaveLength(5); // daily + hourly + 2 countries + 1 colo
		expect(upserts.find((s) => s.sql.includes('checks_daily'))?.args).toEqual(['2026-11-07', 50]);
		expect(upserts.find((s) => s.sql.includes('checks_country') && s.args[0] === 'GB')?.args).toEqual(['GB', 25]);
		expect(upserts.every((s) => s.sql.includes('count = count + excluded.count'))).toBe(true);
		expect(db.total).toBe(151);
		expect(await room.checkTotal()).toBe(151);
		expect(ctx.alarm).toBeNull();
	});

	it('under steady traffic, writes about every CHECK_FLUSH_MS, not on every tick', async () => {
		const { ctx, db, room } = setup(0);
		await room.recordCheck(CHECK); // the wake-up write
		const end = T0 + 2 * CHECK_FLUSH_MS + 1_000;
		for (let t = T0 + 2_000; t <= end; t += 2_000) {
			await runAlarmsUntil(ctx, room, t);
			await room.recordCheck(CHECK);
		}
		// One write per ~30 s window, though the alarm looked in every 5 s.
		expect(db.batches.length).toBeGreaterThanOrEqual(2);
		expect(db.batches.length).toBeLessThanOrEqual(3);
		await runAlarmsUntil(ctx, room, end + 60_000);
		expect(db.total).toBe(await room.checkTotal());
		expect(db.total).toBe(31); // the wake-up check plus one every 2 s
	});

	it('never leaves checks waiting through a quiet spell long enough to hibernate', async () => {
		const { ctx, room } = setup(0);
		await room.recordCheck(CHECK);
		vi.setSystemTime(T0 + 1_000);
		await room.recordCheck(CHECK); // now one is waiting
		// Whatever happens, the alarm comes back within CHECK_TICK_MS (well under ~10 s) while any wait.
		expect(ctx.alarm).not.toBeNull();
		expect((ctx.alarm ?? 0) - Date.now()).toBeLessThanOrEqual(CHECK_TICK_MS);
		await runAlarmsUntil(ctx, room, T0 + 20_000);
		expect(ctx.alarm).toBeNull();
		expect(await room.checkTotal()).toBe(2);
	});

	it('keeps the checks when a write fails, and tries again later', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { ctx, db, room } = setup(10);
		await room.recordCheck(CHECK);
		vi.setSystemTime(T0 + 100);
		await room.recordCheck(CHECK);
		await room.recordCheck(CHECK);
		db.failNext = true;
		await runAlarmsUntil(ctx, room, T0 + 6_000);
		expect(db.batches).toHaveLength(1); // the failed one isn't recorded
		expect(await room.checkTotal()).toBe(13); // still counted
		// No retry before CHECK_RETRY_MS, but the alarm keeps ticking so memory isn't lost.
		await runAlarmsUntil(ctx, room, T0 + 6_000 + CHECK_RETRY_MS - 2_000);
		expect(db.batches).toHaveLength(1);
		expect(ctx.alarm).not.toBeNull();
		await runAlarmsUntil(ctx, room, T0 + 6_000 + CHECK_RETRY_MS + CHECK_TICK_MS);
		expect(db.batches).toHaveLength(2);
		expect(upsertsIn(db.batches[1]).find((s) => s.sql.includes('checks_daily'))?.args).toEqual(['2026-11-07', 2]);
		expect(db.total).toBe(13);
		error.mockRestore();
	});

	it('sends the live total at most once a second', async () => {
		const { ctx, room } = setup(0);
		const ws = socket();
		ctx.sockets.push(ws);
		await room.recordCheck(CHECK);
		for (let i = 0; i < 20; i++) await room.recordCheck(CHECK);
		expect(checksSent(ws)).toEqual([1]); // the rest wait for the alarm
		expect(ctx.alarm).toBe(T0 + 1_000);
		await runAlarmsUntil(ctx, room, T0 + 1_000);
		expect(checksSent(ws)).toEqual([1, 21]);
		vi.setSystemTime(T0 + 2_500);
		await room.recordCheck(CHECK);
		expect(checksSent(ws)).toEqual([1, 21, 22]);
	});

	it('learns the total again after hibernating (memory is gone, D1 is not)', async () => {
		const { ctx, db, env, room } = setup(500);
		await room.recordCheck(CHECK);
		await runAlarmsUntil(ctx, room, T0 + 60_000);
		const woken = new WaitingRoom(ctx as unknown as DurableObjectState, env);
		expect(await woken.checkTotal()).toBe(501);
		expect(db.batches).toHaveLength(2); // the wake-up read, with nothing to write
		expect(upsertsIn(db.batches[1])).toEqual([]);
		expect(await woken.checkTotal()).toBe(501);
		expect(db.batches).toHaveLength(2);
	});

	it("doesn't trust a remembered alarm that storage never accepted", async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { ctx, room } = setup(0);
		await room.recordCheck(CHECK);
		const setAlarm = ctx.storage.setAlarm;
		ctx.storage.setAlarm = async () => {
			throw new Error('storage is having a moment');
		};
		vi.setSystemTime(T0 + 100);
		await room.recordCheck(CHECK); // wants an alarm, can't get one
		expect(ctx.alarm).toBeNull();
		ctx.storage.setAlarm = setAlarm;
		vi.setSystemTime(T0 + 200);
		await room.recordCheck(CHECK);
		expect(ctx.alarm).toBe(T0 + 200 + CHECK_TICK_MS);
		error.mockRestore();
	});

	it('ignores anything that is not a check', async () => {
		const { db, room } = setup(5);
		await room.recordCheck({ day: 'yesterday', hour: 3, country: 'GB', colo: 'LHR' });
		await room.recordCheck(null as never);
		expect(db.batches).toHaveLength(0);
		expect(await room.checkTotal()).toBe(5);
	});
});

describe('WaitingRoom viewer count', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => vi.useRealTimers());

	it('keeps a running count instead of walking every socket on each call', async () => {
		const { ctx, room } = setup();
		ctx.sockets.push(socket(), socket(), socket());
		expect((await room.stats()).viewers).toBe(3);
		for (let i = 0; i < 10; i++) await room.stats();
		expect(ctx.getWebSocketsCalls).toBe(1);

		const leaving = ctx.sockets[0] as FakeSocket;
		leaving.readyState = 3;
		await room.webSocketClose(leaving as unknown as WebSocket, 1000, '', true);
		expect((await room.stats()).viewers).toBe(2);
		expect(ctx.getWebSocketsCalls).toBe(2);
	});
});
