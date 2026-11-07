import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, SiteState } from '../src/types';

/** A stand-in for caches.default: a Map of URL → stored response. */
class FakeCache {
	store = new Map<string, Response>();
	puts: Array<{ key: string; cacheControl: string | null }> = [];
	async match(key: RequestInfo | URL): Promise<Response | undefined> {
		return this.store.get(String(key))?.clone();
	}
	async put(key: RequestInfo | URL, res: Response): Promise<void> {
		this.puts.push({ key: String(key), cacheControl: res.headers.get('Cache-Control') });
		this.store.set(String(key), new Response(await res.text(), res));
	}
}

function fakeEnv(opts: { roomDown?: boolean } = {}) {
	const queries: string[] = [];
	const stmt = (sql: string) => ({
		bind: () => stmt(sql),
		all: async () => {
			queries.push(sql);
			return { results: sql.includes('status_history') ? [{ status: 'no', at: '2026-10-01T00:00:00.000Z' }] : [] };
		},
		first: async () => {
			queries.push(sql);
			return null;
		},
	});
	const room = { details: async () => ({ viewers: 3, sockets: 2, streams: 1, vibes: 7, vibesByEmoji: [], openSince: null }) };
	const env = {
		DB: {
			prepare: (sql: string) => stmt(sql),
			batch: async (stmts: Array<{ all: () => Promise<unknown> }>) => Promise.all(stmts.map((s) => s.all())),
		},
		WAITING_ROOM: {
			idFromName: () => ({}),
			get: () => {
				if (opts.roomDown) throw new Error('waiting room down');
				return room;
			},
		},
	} as unknown as Env;
	return { env, queries };
}

async function request(state: SiteState, env: Env, colo = 'LHR') {
	// Fresh modules per test, so the per-isolate caches in counters/live start empty.
	const { liveRoutes } = await import('../src/routes/live');
	const app = new Hono<AppEnv>();
	app.use('*', async (c, next) => {
		c.set('state', state);
		await next();
	});
	app.route('/', liveRoutes);
	const waits: Promise<unknown>[] = [];
	const req = new Request('https://iszacka.dad/stats');
	Object.defineProperty(req, 'cf', { value: { colo } });
	const res = await app.request(req, undefined, env, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} });
	await Promise.all(waits);
	return res;
}

const NO: SiteState = { status: 'no', statusChangedAt: '2026-10-01T00:00:00.000Z', dueDate: '2026-11-20' };

describe('/stats edge cache', () => {
	let cache: FakeCache;
	beforeEach(() => {
		vi.resetModules();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		cache = new FakeCache();
		vi.stubGlobal('caches', { default: cache });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('stores a rendered page for 30 seconds, and serves it without touching D1 or the waiting room', async () => {
		const { STATS_CACHE_SECONDS, statsCacheKey } = await import('../src/routes/live');
		const first = fakeEnv();
		const miss = await request(NO, first.env);
		expect(miss.status).toBe(200);
		expect(miss.headers.get('Cache-Control')).toBe('no-store');
		const page = await miss.text();
		expect(page).toContain('How often do people check?');
		expect(first.queries.length).toBeGreaterThan(0);
		expect(cache.puts).toEqual([{ key: statsCacheKey('https://iszacka.dad', NO, 'LHR', 'local'), cacheControl: `public, max-age=${STATS_CACHE_SECONDS}` }]);
		expect(STATS_CACHE_SECONDS).toBe(30);

		vi.resetModules();
		const second = fakeEnv({ roomDown: true }); // would show "not answering" if it rendered
		const hit = await request(NO, second.env);
		expect(hit.status).toBe(200);
		expect(hit.headers.get('Cache-Control')).toBe('no-store');
		expect(hit.headers.get('Content-Type')).toMatch(/^text\/html/);
		expect(await hit.text()).toBe(page);
		expect(second.queries).toEqual([]);
		expect(cache.puts).toHaveLength(1);
	});

	it('keys by everything the page shows that is not a shared count', async () => {
		const { statsCacheKey } = await import('../src/routes/live');
		const variants: Array<[SiteState, string]> = [
			[NO, 'LHR'],
			[{ ...NO, status: 'yes' }, 'LHR'],
			[NO, 'AMS'],
			[{ ...NO, statusChangedAt: '2026-10-02T00:00:00.000Z' }, 'LHR'],
			[{ ...NO, dueDate: '2026-11-21' }, 'LHR'],
			[{ ...NO, dueDate: null }, 'LHR'],
		];
		for (const [state, colo] of variants) {
			vi.resetModules();
			await request(state, fakeEnv().env, colo);
		}
		expect(cache.puts.map((p) => p.key)).toEqual(variants.map(([state, colo]) => statsCacheKey('https://iszacka.dad', state, colo, 'local')));
		expect(new Set(cache.puts.map((p) => p.key)).size).toBe(variants.length);
		// A new deploy gets its own entries.
		expect(statsCacheKey('https://iszacka.dad', NO, 'LHR', 'v2@2026-11-07')).not.toBe(statsCacheKey('https://iszacka.dad', NO, 'LHR', 'local'));
	});

	it('does not cache an incomplete page', async () => {
		const down = await request(NO, fakeEnv({ roomDown: true }).env);
		expect(down.status).toBe(200);
		expect(await down.text()).toContain('isn’t answering the door');
		expect(cache.puts).toEqual([]);
	});

	it('works without an edge cache (unit tests, workers.dev)', async () => {
		vi.unstubAllGlobals();
		const res = await request(NO, fakeEnv().env);
		expect(res.status).toBe(200);
		expect(cache.puts).toEqual([]);
	});
});

describe('formatShare', () => {
	it('writes shares exactly as Intl percent with one decimal does', async () => {
		const { formatShare } = await import('../src/routes/live');
		const intl = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 });
		const shares = [0, 1, 0.5, 0.0005, 0.00049999, 0.0045, 0.0015, 0.285, 0.9995, 0.99949, 1e-9, 0.1234999];
		for (let total = 1; total <= 400; total++) for (let count = 0; count <= total; count++) shares.push(count / total);
		for (const share of shares) expect(formatShare(share), String(share)).toBe(intl.format(share));
		expect(formatShare(0.0045)).toBe('0.5%'); // shortest decimal, half up: not toFixed's 0.4
		expect(formatShare(2)).toBe(intl.format(2));
	});
});
