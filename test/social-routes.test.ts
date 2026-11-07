import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, SiteState } from '../src/types';

// The home page pulls in other modules' fragments; stub them (as test/frontend-pages does).
vi.mock('../src/routes/subscribe', () => ({ emailSignupForm: () => '' }));
vi.mock('../src/routes/push', () => ({ pushWidget: () => '' }));
vi.mock('../src/routes/webhooks', () => ({ webhookForm: () => '' }));
vi.mock('../src/lib/community', () => ({ getReadinessSummary: async () => ({ done: 0, total: 0, percent: 0 }) }));

const STATE: SiteState = { status: 'no', statusChangedAt: '2026-11-01T00:00:00.000Z', dueDate: '2026-11-12' };

function fakeDb(rows: Array<{ country: unknown; count: unknown }> | Error) {
	const db = {
		reads: 0,
		prepare(sql: string) {
			const stmt = {
				sql,
				bind: () => stmt,
				async all() {
					db.reads++;
					if (rows instanceof Error) throw rows;
					return { results: rows };
				},
				async first() {
					return null;
				},
			};
			return stmt;
		},
	};
	return db;
}

async function load() {
	vi.resetModules();
	return import('../src/routes/social');
}

function app(routes: Hono<AppEnv>) {
	const a = new Hono<AppEnv>();
	a.use('*', async (c, next) => {
		c.set('state', STATE);
		await next();
	});
	a.route('/', routes);
	return a;
}

describe('GET /api/countries', () => {
	beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-07T12:00:00Z'), toFake: ['Date'] }));
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('lists checks per country, busiest first, with names, CORS and a minute of caching', async () => {
		const { socialRoutes } = await load();
		const DB = fakeDb([
			{ country: 'PT', count: 3 },
			{ country: 'GB', count: 40 },
			{ country: 'XX', count: 2 },
			{ country: 'T1', count: 1 },
			{ country: 'zz-bad', count: 9 },
			{ country: 'FR', count: 0 },
		]);
		const res = await app(socialRoutes).request('https://iszacka.dad/api/countries', {}, { DB } as unknown as Env);
		expect(res.status).toBe(200);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(res.headers.get('cache-control')).toBe('public, max-age=60');
		expect(res.headers.get('content-type')).toContain('application/json');
		const body = (await res.json()) as { countries: unknown[]; total: number; updatedAt: string };
		expect(body.countries).toEqual([
			{ country: 'GB', name: 'United Kingdom', n: 40 },
			{ country: 'PT', name: 'Portugal', n: 3 },
			{ country: 'XX', name: 'Parts unknown', n: 2 },
			{ country: 'T1', name: 'Tor (location: yes)', n: 1 },
		]);
		expect(body.total).toBe(46);
		expect(body.updatedAt).toBe('2026-11-07T12:00:00.000Z');

		// The next minute's requests in this isolate don't touch D1.
		await app(socialRoutes).request('https://iszacka.dad/api/countries', {}, { DB } as unknown as Env);
		expect(DB.reads).toBe(1);
		vi.setSystemTime(new Date('2026-11-07T12:01:01Z'));
		await app(socialRoutes).request('https://iszacka.dad/api/countries', {}, { DB } as unknown as Env);
		expect(DB.reads).toBe(2);
	});

	it('answers a CORS preflight', async () => {
		const { socialRoutes } = await load();
		const res = await app(socialRoutes).request('https://iszacka.dad/api/countries', { method: 'OPTIONS' }, {} as Env);
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-methods')).toContain('GET');
	});

	it('is rate limited', async () => {
		const { socialRoutes } = await load();
		const RL_API = { limit: async () => ({ success: false }) };
		const res = await app(socialRoutes).request('https://iszacka.dad/api/countries', {}, { RL_API, DB: fakeDb([]) } as unknown as Env);
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBe('60');
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
	});

	it('says so when D1 is down and there is nothing to fall back on', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { socialRoutes } = await load();
		const res = await app(socialRoutes).request('https://iszacka.dad/api/countries', {}, { DB: fakeDb(new Error('nope')) } as unknown as Env);
		expect(res.status).toBe(503);
		expect(res.headers.get('cache-control')).toBe('no-store');
	});
});

describe('home panels', () => {
	it('renders DADCON, the meter, the map and the feed, all usable without JavaScript', async () => {
		const { socialHomePanels } = await load();
		const html = String(await socialHomePanels(STATE, { today: '2026-11-07', anxiety: { level: 'frantic', perMinute: 4.2 } }));
		expect(html).toContain('CH-12');
		expect(html).toContain('CH-15');
		expect(html).toContain('data-dadcon data-level="3"');
		expect(html).toContain('DADCON 3 · ROUND HOUSE');
		expect(html).toMatch(/class="dc dc-3 is-active"[^>]*aria-current="step"/);
		expect(html).toContain('data-anxiety data-level="frantic"');
		expect(html).toContain('>FRANTIC<');
		expect(html).toContain('>4.2<');
		expect(html).toContain('href="/stats"'); // the map's no-JS fallback
		expect(html).toContain('data-checkfeed');
		expect(html).not.toMatch(/<script(?![^>]*application\/json)/);
	});

	it('calls it DADCON 0: DAD once it is a yes, and is calm without a reading', async () => {
		const { socialHomePanels } = await load();
		const html = String(await socialHomePanels({ ...STATE, status: 'yes' }, { today: '2026-11-07' }));
		expect(html).toContain('DADCON 0: DAD');
		expect(html).toContain('data-anxiety data-level="calm"');
	});

	it('writes rates the British way', async () => {
		const { formatRate } = await load();
		expect(formatRate(0)).toBe('0');
		expect(formatRate(0.6)).toBe('0.6');
		expect(formatRate(12)).toBe('12');
		expect(formatRate(1234.56)).toBe('1,234.6');
		expect(formatRate(Number.NaN)).toBe('0');
	});

	it('are on the home page, with their script and styles', async () => {
		vi.resetModules();
		const { pageRoutes } = await import('../src/routes/pages');
		const res = await app(pageRoutes).request('https://iszacka.dad/', { headers: { 'accept-language': 'en-GB' } }, {} as Env);
		expect(res.status).toBe(200);
		const page = await res.text();
		expect(page).toContain('<script type="module" src="/social.js"></script>');
		expect(page).toContain('<link rel="stylesheet" href="/social.css">');
		expect(page).toContain('data-world-map');
		expect(page.indexOf('data-world-map')).toBeGreaterThan(page.indexOf('id="mission-control"')); // below the fold
	});
});
