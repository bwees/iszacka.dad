import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, SiteState } from '../src/types';

/** A stand-in for caches.default: a Map of URL → stored response. */
class FakeCache {
	store = new Map<string, { body: ArrayBuffer; headers: [string, string][] }>();
	puts: Array<{ key: string; headers: Headers }> = [];
	matches = 0;
	async match(key: RequestInfo | URL): Promise<Response | undefined> {
		this.matches++;
		const hit = this.store.get(String(key));
		return hit ? new Response(hit.body.slice(0), { headers: hit.headers }) : undefined;
	}
	async put(key: RequestInfo | URL, res: Response): Promise<void> {
		this.puts.push({ key: String(key), headers: res.headers });
		this.store.set(String(key), { body: await res.arrayBuffer(), headers: [...res.headers] });
	}
}

interface FakeOpts {
	latest?: number;
	done?: number;
	roomDown?: boolean;
	updatesDown?: boolean;
}

function fakeEnv(opts: FakeOpts = {}) {
	const calls = { content: 0, updates: 0, readiness: 0, snapshot: 0 };
	const latest = opts.latest ?? 2;
	const updates = Array.from({ length: latest }, (_, i) => ({
		id: latest - i,
		kind: 'daily',
		title: `Day ${latest - i}: still no <b>really</b>.`,
		body: 'Still no.',
		status: 'no',
		audience: 'daily',
		created_at: `2026-11-0${Math.max(1, 6 - i)}T09:00:00.000Z`,
		notified_at: null,
	}));
	const stmt = (sql: string) => ({
		bind: () => stmt(sql),
		all: async () => {
			if (sql.includes('FROM updates') && sql.includes('ORDER BY id DESC')) {
				calls.updates++;
				if (opts.updatesDown) throw new Error('D1 down');
				return { results: updates.slice(0, 5) };
			}
			return { results: [] };
		},
		first: async () => {
			if (sql.includes('MAX(id)')) {
				calls.content++;
				return { latest, total: 20, done: opts.done ?? 7 };
			}
			if (sql.includes('FROM checklist')) {
				calls.readiness++;
				return { total: 20, done: opts.done ?? 7 };
			}
			return null;
		},
	});
	const room = {
		liveSnapshot: async () => {
			calls.snapshot++;
			if (opts.roomDown) throw new Error('room down');
			return { viewers: 3, vibes: 7, checks: 48213, reloadNonce: 'n', anxiety: { level: 'elevated', perMinute: 4.2 } };
		},
		checkTotal: async () => 48213,
	};
	const env = {
		DB: { prepare: (sql: string) => stmt(sql) },
		WAITING_ROOM: { idFromName: () => ({}), get: () => room },
		CF_VERSION: { id: '0123abcd-0000-0000-0000-000000000000', tag: '', timestamp: '2026-11-07T00:00:00Z' },
		SITE_URL: 'https://iszacka.dad',
	} as unknown as Env;
	return { env, calls };
}

const NO: SiteState = { status: 'no', statusChangedAt: '2026-11-01T09:00:00.000Z', dueDate: '2026-11-20' };

interface Visitor {
	lang?: string;
	cf?: Record<string, string>;
}

async function home(env: Env, state: SiteState = NO, visitor: Visitor = {}) {
	const { pageRoutes } = await import('../src/routes/pages');
	const app = new Hono<AppEnv>();
	app.use('*', async (c, next) => {
		c.set('state', state);
		await next();
	});
	app.route('/', pageRoutes);
	const waits: Promise<unknown>[] = [];
	const req = new Request('https://iszacka.dad/', { headers: { 'accept-language': visitor.lang ?? 'en-GB,en;q=0.9' } });
	Object.defineProperty(req, 'cf', { value: visitor.cf ?? { country: 'GB', city: 'London', colo: 'LHR' } });
	const res = await app.request(req, undefined, env, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} });
	const body = await res.text();
	await Promise.all(waits);
	return { res, body };
}

const PARIS: Visitor = { lang: 'fr-FR,fr;q=0.9', cf: { country: 'FR', city: "L'Haÿ-les-Roses <&> <!--home:greeting-->", colo: 'CDG' } };

describe('GET / edge cache', () => {
	let cache: FakeCache;
	beforeEach(() => {
		vi.resetModules();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.useFakeTimers({ now: new Date('2026-11-07T10:00:00.123Z'), toFake: ['Date'] });
		cache = new FakeCache();
		vi.stubGlobal('caches', { default: cache });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('stores the page once, and serves other visitors from it byte for byte', async () => {
		const { env, calls } = fakeEnv();
		const first = await home(env);
		expect(first.res.status).toBe(200);
		expect(cache.puts).toHaveLength(1);
		const { HOME_CACHE_SECONDS } = await import('../src/routes/pages');
		expect(cache.puts[0]?.key).toMatch(/^https:\/\/iszacka\.dad\/__cache\/home\/v1\//);
		expect(cache.puts[0]?.headers.get('Cache-Control')).toBe(`public, max-age=${HOME_CACHE_SECONDS}`);
		expect(calls).toEqual({ content: 1, updates: 1, readiness: 0, snapshot: 1 });

		// Another visitor, another language, a few seconds later: no Durable Object call, no
		// updates read, no render, and the same bytes and headers a render would have given.
		vi.setSystemTime(new Date('2026-11-07T10:00:07.456Z'));
		const hit = await home(env, NO, PARIS);
		expect(calls).toEqual({ content: 2, updates: 1, readiness: 0, snapshot: 1 });
		expect(cache.puts).toHaveLength(1);

		vi.stubGlobal('caches', undefined);
		vi.resetModules();
		const fresh = await home(fakeEnv().env, NO, PARIS);
		expect(hit.body).toBe(fresh.body);
		expect([...hit.res.headers]).toEqual([...fresh.res.headers]);
		expect(hit.body).toContain('Hello, visitor from L&#39;Haÿ-les-Roses &lt;&amp;&gt; &lt;!--home:greeting--&gt;, France.');
		expect(hit.body).toContain('Served from CDG');
		expect(hit.body).toContain('<time datetime="2026-11-07T10:00:07.456Z" data-asof>');
		expect(hit.body).not.toContain('<!--home:');
	});

	it('never serves a copy older than HOME_CACHE_SECONDS', async () => {
		const { HOME_CACHE_SECONDS } = await import('../src/routes/pages');
		const { env, calls } = fakeEnv();
		await home(env);
		vi.setSystemTime(new Date(Date.parse('2026-11-07T10:00:00.123Z') + HOME_CACHE_SECONDS * 1000 - 1));
		await home(env);
		expect(calls.snapshot).toBe(1);
		vi.setSystemTime(new Date(Date.parse('2026-11-07T10:00:00.123Z') + HOME_CACHE_SECONDS * 1000));
		await home(env);
		expect(calls.snapshot).toBe(2);
		expect(cache.puts).toHaveLength(2);
	});

	it('makes a new copy for a new update, a checklist change, a new answer or a new day', async () => {
		await home(fakeEnv().env);
		await home(fakeEnv({ latest: 3 }).env);
		await home(fakeEnv({ latest: 3, done: 8 }).env);
		await home(fakeEnv({ latest: 3, done: 8 }).env, { ...NO, status: 'soon', statusChangedAt: '2026-11-07T09:59:00.000Z' });
		vi.setSystemTime(new Date('2026-11-08T00:30:00.000Z'));
		await home(fakeEnv({ latest: 3, done: 8 }).env, { ...NO, status: 'soon', statusChangedAt: '2026-11-07T09:59:00.000Z' });
		expect(new Set(cache.puts.map((p) => p.key)).size).toBe(5);
	});

	it('does not share a page rendered without the waiting room or the updates', async () => {
		await home(fakeEnv({ roomDown: true }).env);
		await home(fakeEnv({ updatesDown: true }).env);
		expect(cache.puts).toHaveLength(0);
	});

	it('renders as before when the content read fails', async () => {
		const { env, calls } = fakeEnv();
		const prepare = env.DB.prepare.bind(env.DB);
		(env.DB as { prepare: unknown }).prepare = (sql: string) =>
			sql.includes('MAX(id)') ? { bind: () => ({}), first: async () => Promise.reject(new Error('D1 down')) } : prepare(sql);
		const { res, body } = await home(env);
		expect(res.status).toBe(200);
		expect(body).toContain('7 of 20 essential dad tasks complete.');
		expect(calls.readiness).toBe(1);
		expect(cache.matches).toBe(0);
		expect(cache.puts).toHaveLength(0);
	});
});

describe('home page slots', () => {
	it('cuts markup at known slot markers and fills them per request', async () => {
		const { fillHome, homeTemplate } = await import('../src/routes/pages');
		const template = homeTemplate('<p><!--home:greeting--></p><!--home:unknown--><b><!--home:clock--></b>é');
		expect(template.names).toEqual(['greeting', 'clock']);
		const slots = { greeting: 'Hi &amp; bye', clock: '01h', colo: '', language: '', now: '', londonNow: '', asOf: '', foreign: '', speak: '' };
		expect(await fillHome(template, slots).text()).toBe('<p>Hi &amp; bye</p><!--home:unknown--><b>01h</b>é');
	});
});
