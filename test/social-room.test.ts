import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The WaitingRoom's social side (check feed, milestones, anxiety meter, vibes by country), run
// under Node against a fake Durable Object context and D1, like test/realtime-room-checks.

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
const { CHECKFEED_INTERVAL_MS } = await import('../src/lib/social');
const { CHECK_TOTAL_SQL } = await import('../src/lib/counters');

const T0 = Date.parse('2026-11-07T12:00:00Z');
const MIN = 60_000;
const check = (country = 'GB') => ({ day: '2026-11-07', hour: 12, country, colo: 'LHR' });

interface Msg {
	type: string;
	[key: string]: unknown;
}

function socket(attachment: unknown = null) {
	const ws = {
		readyState: 1,
		sent: [] as string[],
		attachment,
		send(data: string) {
			ws.sent.push(data);
		},
		close() {
			ws.readyState = 3;
		},
		serializeAttachment(value: unknown) {
			ws.attachment = value;
		},
		deserializeAttachment: () => ws.attachment,
		messages: (type?: string) => ws.sent.map((s) => JSON.parse(s) as Msg).filter((m) => !type || m.type === type),
	};
	return ws;
}

function fakeCtx() {
	const kv = new Map<string, unknown>();
	const ctx = {
		kv,
		alarm: null as number | null,
		sockets: [] as Array<ReturnType<typeof socket>>,
		storage: {
			sql: { exec: () => ({ one: () => ({ total: 0 }), toArray: () => [] }) },
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
		getWebSockets: () => ctx.sockets,
		setWebSocketAutoResponse() {},
		waitUntil(promise: Promise<unknown>) {
			void promise;
		},
	};
	return ctx;
}

function fakeDb(total = 0) {
	const db = {
		total,
		prepare(sql: string) {
			const stmt = {
				sql,
				args: [] as unknown[],
				bind(...args: unknown[]) {
					stmt.args = args;
					return stmt;
				},
				async first() {
					return null;
				},
			};
			return stmt;
		},
		async batch(statements: Array<{ sql: string; args: unknown[] }>) {
			for (const s of statements) if (s.sql.includes('INSERT INTO checks_daily')) db.total += Number(s.args[1]);
			return statements.map((s) => ({ results: s.sql === CHECK_TOTAL_SQL ? [{ total: db.total }] : [] }));
		},
	};
	return db;
}

function setup(total = 0) {
	const ctx = fakeCtx();
	const db = fakeDb(total);
	const env = { DB: db, ENVIRONMENT: 'production' } as unknown as Env;
	const room = new WaitingRoom(ctx as unknown as DurableObjectState, env);
	return { ctx, db, env, room };
}

async function runAlarmsUntil(ctx: ReturnType<typeof fakeCtx>, room: InstanceType<typeof WaitingRoom>, at: number) {
	for (let i = 0; i < 200 && ctx.alarm !== null && ctx.alarm <= at; i++) {
		vi.setSystemTime(ctx.alarm);
		ctx.alarm = null;
		await room.alarm();
	}
	vi.setSystemTime(at);
}

describe('WaitingRoom social', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => vi.useRealTimers());

	it('tells viewers who just checked: the first at once, then a summary every 3 s', async () => {
		const { ctx, room } = setup(10);
		const ws = socket();
		ctx.sockets.push(ws);
		await room.recordCheck(check('PT'));
		expect(ws.messages('checkfeed')).toEqual([{ type: 'checkfeed', items: [{ country: 'PT', n: 1 }] }]);
		for (const [i, c] of ['GB', 'GB', 'pt', 'XX'].entries()) {
			vi.setSystemTime(T0 + 200 * (i + 1));
			await room.recordCheck(check(c));
		}
		expect(ws.messages('checkfeed')).toHaveLength(1);
		await runAlarmsUntil(ctx, room, T0 + CHECKFEED_INTERVAL_MS);
		expect(ws.messages('checkfeed').at(-1)).toEqual({
			type: 'checkfeed',
			items: [
				{ country: 'GB', n: 2 },
				{ country: 'PT', n: 1 },
				{ country: 'XX', n: 1 },
			],
		});
		await runAlarmsUntil(ctx, room, T0 + 60_000);
		expect(ws.messages('checkfeed')).toHaveLength(2); // nothing new, nothing sent
	});

	it('keeps no feed, and sets no extra alarm, when nobody is watching', async () => {
		const { ctx, room } = setup(10);
		await room.recordCheck(check());
		expect(ctx.alarm).toBeNull(); // the realtime test's expectation, unchanged
		const ws = socket();
		ctx.sockets.push(ws);
		vi.setSystemTime(T0 + 10_000);
		await room.alarm(); // a connect is followed by an alarm (viewer count), which recounts sockets
		await room.recordCheck(check('FR'));
		// The check from before anyone was watching isn't news.
		expect(ws.messages('checkfeed')).toEqual([{ type: 'checkfeed', items: [{ country: 'FR', n: 1 }] }]);
	});

	it('celebrates the 100th check once, with its country, and never again', async () => {
		const { ctx, env, room } = setup(97);
		const ws = socket();
		ctx.sockets.push(ws);
		await room.recordCheck(check('GB')); // 98: learns the total, records the milestones behind it
		expect(ctx.kv.get('social_milestone')).toBe(0);
		await room.recordCheck(check('GB')); // 99
		expect(ws.messages('milestone')).toEqual([]);
		await room.recordCheck(check('CA')); // 100
		expect(ws.messages('milestone')).toEqual([{ type: 'milestone', n: 100, country: 'CA' }]);
		expect(ctx.kv.get('social_milestone')).toBe(100);
		await room.recordCheck(check('GB')); // 101
		expect(ws.messages('milestone')).toHaveLength(1);

		// Hibernation forgets memory, not storage: a woken room won't repeat it.
		await runAlarmsUntil(ctx, room, T0 + 60_000);
		const woken = new WaitingRoom(ctx as unknown as DurableObjectState, env);
		for (let i = 0; i < 148; i++) await woken.recordCheck(check('FR')); // up to 249
		expect(ws.messages('milestone')).toHaveLength(1);
		await woken.recordCheck(check('BR')); // 250
		expect(ws.messages('milestone')).toEqual([
			{ type: 'milestone', n: 100, country: 'CA' },
			{ type: 'milestone', n: 250, country: 'BR' },
		]);
	});

	it("doesn't celebrate old milestones on a site that has been counting for a while", async () => {
		const { ctx, room } = setup(3_456);
		const ws = socket();
		ctx.sockets.push(ws);
		await room.recordCheck(check());
		expect(ws.messages('milestone')).toEqual([]);
		expect(ctx.kv.get('social_milestone')).toBe(2_500);
	});

	it('moves the anxiety meter on level changes only, and lets it fall when things go quiet', async () => {
		const { ctx, room } = setup(0);
		const ws = socket();
		ctx.sockets.push(ws);
		for (let i = 0; i < 16; i++) {
			vi.setSystemTime(T0 + i * 1_000);
			await room.recordCheck(check());
		}
		expect(ws.messages('anxiety').map((m) => m.level)).toEqual(['elevated', 'frantic']);
		expect((await room.liveSnapshot()).anxiety).toEqual({ level: 'frantic', perMinute: 3.2 });
		// Nobody else checks: the room wakes itself once, when the window empties, to say so.
		await runAlarmsUntil(ctx, room, T0 + 10 * MIN);
		expect(ws.messages('anxiety').map((m) => m.level)).toEqual(['elevated', 'frantic', 'calm']);
		expect(ctx.alarm).toBeNull();
	});

	it('remembers the meter across hibernation, saving it only once checks are written', async () => {
		const { ctx, env, room } = setup(0);
		for (let i = 0; i < 5; i++) {
			vi.setSystemTime(T0 + i * 100);
			await room.recordCheck(check());
		}
		await runAlarmsUntil(ctx, room, T0 + 20_000); // the quiet flush
		expect(typeof ctx.kv.get('social_pulse')).toBe('string');
		const woken = new WaitingRoom(ctx as unknown as DurableObjectState, env);
		expect((await woken.liveSnapshot()).anxiety).toEqual({ level: 'elevated', perMinute: 1 });
	});

	it('sends vibes with the sender’s country, when it is known', async () => {
		const { ctx, room } = setup(0);
		const sender = socket({ connectedAt: T0, vibes: [], frameWindowStart: T0, frames: 0, country: 'PT' });
		const anonymous = socket({ connectedAt: T0, vibes: [], frameWindowStart: T0, frames: 0 });
		const bogus = socket({ connectedAt: T0, vibes: [], frameWindowStart: T0, frames: 0, country: '<script>' });
		ctx.sockets.push(sender, anonymous, bogus);
		await room.webSocketMessage(sender as unknown as WebSocket, JSON.stringify({ type: 'vibe', emoji: '💛' }));
		await room.webSocketMessage(anonymous as unknown as WebSocket, JSON.stringify({ type: 'vibe', emoji: '🍼' }));
		await room.webSocketMessage(bogus as unknown as WebSocket, JSON.stringify({ type: 'vibe', emoji: '🎉' }));
		expect(anonymous.messages('vibes')).toEqual([
			{ type: 'vibes', vibes: 1, emoji: '💛', country: 'PT' },
			{ type: 'vibes', vibes: 2, emoji: '🍼' },
			{ type: 'vibes', vibes: 3, emoji: '🎉' },
		]);
		expect((sender.attachment as { country?: string }).country).toBe('PT'); // kept through the rate-limit bookkeeping
	});
});
