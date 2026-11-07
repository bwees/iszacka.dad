import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The WaitingRoom's terminals (GET /live), run under Node against a fake DO context and D1:
// whole-screen frames on connect and on every broadcast, a 5-second clock tick only while a
// terminal is connected, one render per tick for everyone, the 15-minute goodbye, the caps,
// and the fireworks.

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
const { FIREWORKS_FRAME_MS, FIREWORKS_MS, MAX_TERMINALS, MAX_TERMINALS_PER_CLIENT, TERMINAL_MAX_MS, TERMINAL_TAG, TERMINAL_TICK_MS } = await import(
	'../src/do/waiting-room-protocol'
);
const { CHECK_TOTAL_SQL } = await import('../src/lib/counters');
const { LIVE_PREAMBLE, SHOW_CURSOR } = await import('../src/lib/ascii-live');
const { invalidateStateCache } = await import('../src/lib/state');

import type { SiteState } from '../src/types';

const T0 = Date.parse('2026-11-07T12:00:01Z');
const NO: SiteState = { status: 'no', statusChangedAt: '2026-11-01T09:00:00.000Z', dueDate: '2026-11-20' };

interface FakeSocket {
	readyState: number;
	tags: string[];
	attachment: unknown;
	sent: string[];
	send(data: string): void;
	close(): void;
	serializeAttachment(value: unknown): void;
	deserializeAttachment(): unknown;
}

function socket(tags: string[] = [], attachment: unknown = null): FakeSocket {
	return {
		readyState: 1,
		tags,
		attachment,
		sent: [],
		send(data: string) {
			this.sent.push(data);
		},
		close() {
			this.readyState = 3;
		},
		serializeAttachment(value: unknown) {
			this.attachment = value;
		},
		deserializeAttachment() {
			return this.attachment;
		},
	};
}

function fakeCtx() {
	const kv = new Map<string, unknown>();
	const ctx = {
		alarm: null as number | null,
		sockets: [] as FakeSocket[],
		storage: {
			sql: { exec: (_query: string) => ({ one: () => ({ total: 0 }), toArray: () => [] }) },
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
		getWebSockets(tag?: string) {
			return tag ? ctx.sockets.filter((ws) => ws.tags.includes(tag)) : ctx.sockets;
		},
		setWebSocketAutoResponse() {},
		waitUntil(promise: Promise<unknown>) {
			void promise;
		},
	};
	return ctx;
}

/** D1 answering the three reads the room makes: settings (state), the newest update, the check total. */
function fakeDb(state: SiteState = NO) {
	const db = {
		state,
		updates: [] as Array<Record<string, unknown>>,
		reads: 0,
		prepare(sql: string) {
			const stmt = {
				sql,
				args: [] as unknown[],
				bind(...args: unknown[]) {
					stmt.args = args;
					return stmt;
				},
				async all() {
					db.reads++;
					if (sql.includes('FROM settings')) {
						const rows = [
							{ key: 'status', value: db.state.status },
							{ key: 'status_changed_at', value: db.state.statusChangedAt },
						];
						if (db.state.dueDate) rows.push({ key: 'due_date', value: db.state.dueDate });
						return { results: rows };
					}
					if (sql.includes('FROM updates')) return { results: db.updates };
					return { results: [] };
				},
				async first() {
					return null;
				},
			};
			return stmt;
		},
		async batch(statements: Array<{ sql: string }>) {
			return statements.map((s) => ({ results: s.sql === CHECK_TOTAL_SQL ? [{ total: 41 }] : [] }));
		},
	};
	return db;
}

function setup(state: SiteState = NO) {
	const ctx = fakeCtx();
	const db = fakeDb(state);
	const env = { DB: db, ENVIRONMENT: 'production' } as unknown as Env;
	const room = new WaitingRoom(ctx as unknown as DurableObjectState, env);
	return { ctx, db, room };
}

const settle = async () => {
	for (let i = 0; i < 50; i++) await Promise.resolve();
};

/** Read a stream in the background, the way curl would. */
function watch(res: Response) {
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	const out = { frames: [] as string[], done: false, reader };
	void (async () => {
		for (;;) {
			const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
			if (done) break;
			out.frames.push(decoder.decode(value));
		}
		out.done = true;
	})();
	return out;
}

const live = (ip?: string) => new Request('https://iszacka.dad/live', { headers: ip ? { 'cf-connecting-ip': ip } : {} });
const plain = (frame: string) => frame.replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

/** Run the alarm whenever it's due, up to `at`, the way the runtime would. */
async function runAlarmsUntil(ctx: ReturnType<typeof fakeCtx>, room: InstanceType<typeof WaitingRoom>, at: number) {
	for (let i = 0; i < 1_000 && ctx.alarm !== null && ctx.alarm <= at; i++) {
		vi.setSystemTime(ctx.alarm);
		ctx.alarm = null;
		await room.alarm();
		await settle();
	}
	vi.setSystemTime(at);
}

describe('WaitingRoom terminals (GET /live)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		invalidateStateCache();
	});
	afterEach(() => vi.useRealTimers());

	it('streams unbuffered plain text: hides the cursor, clears the screen and draws the dashboard', async () => {
		const { ctx, room } = setup();
		const res = await room.fetch(live('203.0.113.7'));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
		expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
		expect(res.headers.get('X-Accel-Buffering')).toBe('no');
		const stream = watch(res);
		await settle();
		expect(stream.frames).toHaveLength(1);
		const first = stream.frames[0] ?? '';
		expect(first.startsWith(LIVE_PREAMBLE)).toBe(true);
		expect(plain(first)).toContain('Zack is not a dad');
		expect(plain(first)).toMatch(/Asked\s+41 times/);
		// The viewer count goes out within a second; the clock ticks within five.
		expect(ctx.alarm).not.toBeNull();
		expect((ctx.alarm ?? 0) - T0).toBeLessThanOrEqual(TERMINAL_TICK_MS);
	});

	it('redraws the moment a broadcast arrives', async () => {
		const { room } = setup();
		const stream = watch(await room.fetch(live()));
		await settle();
		vi.setSystemTime(T0 + 1_000);
		await room.broadcast({ type: 'state', state: { ...NO, status: 'soon', statusChangedAt: new Date(T0 + 1_000).toISOString() } });
		await settle();
		expect(stream.frames).toHaveLength(2);
		expect(plain(stream.frames[1] ?? '')).toContain('CAUTION: DAD UNDER CONSTRUCTION');
		expect(stream.frames[1]).not.toContain('\u001b[2J'); // drawn in place, not cleared
	});

	it('coalesces a burst of broadcasts into one redraw', async () => {
		const { room } = setup();
		const stream = watch(await room.fetch(live()));
		await settle();
		vi.setSystemTime(T0 + 1_000);
		for (let i = 1; i <= 10; i++) {
			const update = { id: i, kind: 'system' as const, title: `Update number ${i}`, body: '', status: 'no' as const, audience: 'all' as const, createdAt: new Date(T0).toISOString(), notifiedAt: null };
			await room.broadcast({ type: 'update', update });
		}
		await settle();
		expect(stream.frames).toHaveLength(2); // the first one at once
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		expect(stream.frames).toHaveLength(3); // and the rest together, a moment later
		expect(plain(stream.frames[1] ?? '')).toContain('Update number 1 ');
		expect(plain(stream.frames[2] ?? '')).toContain('Update number 10 ');
	});

	it('ticks every five seconds while connected, sending everyone the same bytes', async () => {
		const { ctx, room } = setup();
		const a = watch(await room.fetch(live('203.0.113.1')));
		const b = watch(await room.fetch(live('203.0.113.2')));
		await settle();
		const before = a.frames.length;
		await runAlarmsUntil(ctx, room, T0 + 30_500);
		const ticks = a.frames.length - before;
		expect(ticks).toBeGreaterThanOrEqual(6);
		expect(ticks).toBeLessThanOrEqual(8); // six ticks, plus the viewer-count redraw
		expect(a.frames.slice(-3)).toEqual(b.frames.slice(-3));
		expect(ctx.alarm).not.toBeNull();
		expect((ctx.alarm ?? 0) - Date.now()).toBeLessThanOrEqual(TERMINAL_TICK_MS);
	});

	it('stops ticking once the last terminal leaves', async () => {
		const { ctx, room } = setup();
		const stream = watch(await room.fetch(live()));
		await settle();
		await runAlarmsUntil(ctx, room, T0 + 6_000);
		await stream.reader.cancel(); // Ctrl-C
		await settle();
		await runAlarmsUntil(ctx, room, T0 + 60_000);
		expect(ctx.alarm).toBeNull();
		expect((await room.stats()).viewers).toBe(0);
	});

	it('says goodbye after fifteen minutes, gives the cursor back and hangs up', async () => {
		const { ctx, room } = setup();
		const stream = watch(await room.fetch(live()));
		await settle();
		await runAlarmsUntil(ctx, room, T0 + TERMINAL_MAX_MS - 10_000);
		expect(stream.done).toBe(false);
		await runAlarmsUntil(ctx, room, T0 + TERMINAL_MAX_MS + TERMINAL_TICK_MS + 1_000);
		await settle();
		expect(stream.done).toBe(true);
		const last = stream.frames.at(-1) ?? '';
		expect(plain(last)).toContain("That's your 15 minutes. Still no.");
		expect(plain(last)).toContain('Run it again: curl -N iszacka.dad/live');
		expect(last).toContain(SHOW_CURSOR);
		await runAlarmsUntil(ctx, room, T0 + TERMINAL_MAX_MS + 60_000);
		expect(ctx.alarm).toBeNull(); // nobody left: no more ticks
	});

	it(`seats ${MAX_TERMINALS} terminals at once, then answers 503 with a Retry-After`, async () => {
		const { room } = setup();
		const open: Response[] = [];
		for (let i = 0; i < MAX_TERMINALS; i++) open.push(await room.fetch(live()));
		expect(open.every((r) => r.status === 200)).toBe(true);
		const full = await room.fetch(live());
		expect(full.status).toBe(503);
		expect(full.headers.get('Retry-After')).toMatch(/^\d+$/);
		expect(await full.text()).toContain('terminal seats');
	});

	it(`allows ${MAX_TERMINALS_PER_CLIENT} terminals per network`, async () => {
		const { room } = setup();
		for (let i = 0; i < MAX_TERMINALS_PER_CLIENT; i++) expect((await room.fetch(live('198.51.100.9'))).status).toBe(200);
		const greedy = await room.fetch(live('198.51.100.9'));
		expect(greedy.status).toBe(429);
		expect(greedy.headers.get('Retry-After')).toBeTruthy();
		expect((await room.fetch(live('198.51.100.10'))).status).toBe(200);
	});

	it('sets off fireworks for about ten seconds after the flip to YES, then settles', async () => {
		const { ctx, room } = setup({ ...NO, status: 'soon' });
		const stream = watch(await room.fetch(live()));
		await settle();
		const before = stream.frames.length;
		await room.broadcast({ type: 'state', state: { status: 'yes', statusChangedAt: new Date(T0).toISOString(), dueDate: NO.dueDate } });
		await settle();
		expect(stream.frames[before]?.startsWith('\u0007')).toBe(true); // the bell, once
		await vi.advanceTimersByTimeAsync(FIREWORKS_MS + 1_000);
		await settle();
		const frames = stream.frames.length - before;
		expect(frames).toBeGreaterThanOrEqual(FIREWORKS_MS / FIREWORKS_FRAME_MS - 5);
		expect(frames).toBeLessThanOrEqual(FIREWORKS_MS / FIREWORKS_FRAME_MS + 5);
		expect(stream.frames.slice(before + 1).some((f) => f.startsWith('\u0007'))).toBe(false);
		// Over: no more animation timers, just the clock tick.
		const settled = stream.frames.length;
		await vi.advanceTimersByTimeAsync(2_000);
		expect(stream.frames.length).toBe(settled);
		expect(ctx.alarm).not.toBeNull();
		// The same state again (a re-broadcast) is not a second celebration.
		vi.setSystemTime(Date.now() + 1_000);
		await room.broadcast({ type: 'state', state: { status: 'yes', statusChangedAt: new Date(T0).toISOString(), dueDate: NO.dueDate } });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(stream.frames.length - settled).toBeLessThanOrEqual(1);
	});

	it('sends terminal WebSockets frames and browser WebSockets JSON', async () => {
		const { ctx, room } = setup();
		const browser = socket([], { connectedAt: T0, vibes: [], frameWindowStart: T0, frames: 0 });
		const terminal = socket([TERMINAL_TAG], { connectedAt: T0, vibes: [], frameWindowStart: T0, frames: 0, terminal: true });
		ctx.sockets.push(browser, terminal);
		await room.broadcast({ type: 'state', state: NO });
		expect(browser.sent).toHaveLength(1);
		expect(JSON.parse(browser.sent[0] ?? '')).toMatchObject({ type: 'state' });
		expect(terminal.sent).toHaveLength(1);
		expect(terminal.sent[0]).toContain('\u001b[H');
		expect(() => JSON.parse(terminal.sent[0] ?? '')).toThrow();
	});

	it('ignores whatever is typed into a terminal WebSocket', async () => {
		const { ctx, room } = setup();
		const terminal = socket([TERMINAL_TAG], { connectedAt: T0, vibes: [], frameWindowStart: T0, frames: 0, terminal: true });
		ctx.sockets.push(terminal);
		await room.webSocketMessage(terminal as unknown as WebSocket, 'hello? is anyone there');
		expect(terminal.readyState).toBe(1);
		expect(terminal.sent).toEqual([]);
	});
});
