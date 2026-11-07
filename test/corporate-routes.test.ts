// src/routes/corporate.ts end to end, over a real SQLite with the repo's migrations: the
// corporate pages, the heritage notification methods (which must keep nothing) and the Catch
// the Stork API.

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { corporateRoutes } from '../src/routes/corporate';
import { DAILY_SCORE_CAP, SCORE_SLACK, clearScoreCache, issueGameToken } from '../src/lib/stork';
import type { AppEnv } from '../src/types';
import { sqliteD1 } from './email-announce-d1';

interface Limiter {
	limit: (o: { key: string }) => Promise<{ success: boolean }>;
	keys: string[];
}

function limiter(allowed = true): Limiter {
	const keys: string[] = [];
	return {
		keys,
		limit: async ({ key }) => {
			keys.push(key);
			return { success: allowed };
		},
	};
}

function setup(opts: { forms?: Limiter; api?: Limiter; env?: Partial<Env> } = {}) {
	const { D1, db } = sqliteD1();
	const forms = opts.forms ?? limiter();
	const api = opts.api ?? limiter();
	const env = { DB: D1, RL_FORMS: forms, RL_API: api, EMAIL_DAILY_LIMIT: '90', ...opts.env } as unknown as Env;
	const app = new Hono<AppEnv>();
	app.use('*', async (c, next) => {
		c.set('state', { status: 'no', statusChangedAt: '2026-11-01T00:00:00.000Z', dueDate: null } as never);
		await next();
	});
	app.route('/', corporateRoutes);
	const req = (path: string, init: RequestInit = {}) =>
		app.request(`https://iszacka.dad${path}`, { ...init, headers: { 'cf-connecting-ip': '203.0.113.7', ...(init.headers as Record<string, string>) } }, env);
	return { env, db, forms, api, req };
}

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

describe('the corporate pages', () => {
	it('renders /press, /privacy and /terms', async () => {
		const { req } = setup();
		const expectations: Record<string, string> = {
			'/press': 'smaller than 400px',
			'/privacy': 'What we know about you',
			'/terms': 'at most 90 emails go out a day',
		};
		for (const [path, needle] of Object.entries(expectations)) {
			const res = await req(path);
			expect(res.status, path).toBe(200);
			expect(res.headers.get('content-type'), path).toMatch(/^text\/html/);
			const body = await res.text();
			expect(body, path).toContain(needle);
			expect(body, path).toContain('/corporate.css');
			expect(body, path).not.toContain('<meta name="robots" content="noindex');
		}
	});
});

describe('pigeon, smoke signal and fax', () => {
	const SECRET = 'my-house-at-42-secret-street';
	let spies: Array<ReturnType<typeof vi.spyOn>> = [];
	beforeEach(() => {
		spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
	});
	afterEach(() => {
		for (const s of spies) s.mockRestore();
	});

	/** Rows per table, to prove nothing was written. */
	function rowCounts(db: ReturnType<typeof setup>['db']): Record<string, number> {
		const out: Record<string, number> = {};
		for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>) {
			out[name] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n);
		}
		return out;
	}

	/** A form body that counts whether anyone read it. */
	function trackedBody() {
		const read = { pulled: false };
		const bytes = new TextEncoder().encode(`to=${SECRET}&fax=${SECRET}`);
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					read.pulled = true;
					controller.enqueue(bytes);
					controller.close();
				},
			},
			{ highWaterMark: 0 },
		);
		return { read, init: { method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } as RequestInit };
	}

	it.each([
		['/pigeon', 'Pigeon dispatched 🕊️', 'ETA 3–5 business years'],
		['/smoke-signal', 'smoke-puff', 'Signal sent'],
		['/fax', 'Please send your fax number to 1997.', 'FAX TRANSMISSION'],
	])('POST %s renders its result without reading, storing or logging the form', async (path, a, b) => {
		const { req, db, forms } = setup();
		const before = rowCounts(db);
		const { read, init } = trackedBody();
		const res = await req(path, init);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain(a);
		expect(body).toContain(b);
		expect(body).toContain('noindex');
		expect(body).not.toContain(SECRET);
		expect(read.pulled, 'the form body was read').toBe(false);
		for (const s of spies) expect(s).not.toHaveBeenCalled();
		expect(forms.keys).toEqual([`${path.slice(1)}:203.0.113.7`]);
		// Nothing was written anywhere: every table has the rows it started with.
		expect(rowCounts(db)).toEqual(before);
	});

	it('answers JSON when asked, still storing nothing', async () => {
		const { req } = setup();
		const res = await req('/pigeon', { method: 'POST', headers: { Accept: 'application/json' }, body: `to=${SECRET}` });
		expect(res.status).toBe(200);
		const json = (await res.json()) as Record<string, unknown>;
		expect(json).toMatchObject({ ok: true, method: 'pigeon', eta: '3–5 business years', stored: false, carrying: 'NO' });
		expect(String(json.tracking)).toMatch(/^PGN-[0-9A-F]{4}-[0-9A-F]{4}$/);
		expect(JSON.stringify(json)).not.toContain(SECRET);
	});

	it('is rate-limited all the same', async () => {
		const { req } = setup({ forms: limiter(false) });
		const res = await req('/fax', { method: 'POST' });
		expect(res.status).toBe(429);
		expect(await res.text()).toContain('Steady on');
		const json = await req('/smoke-signal', { method: 'POST', headers: { Accept: 'application/json' } });
		expect(json.status).toBe(429);
	});

	it('sends a stray GET back to the method on /everything', async () => {
		const { req } = setup();
		for (const m of ['pigeon', 'smoke-signal', 'fax']) {
			const res = await req(`/${m}`);
			expect(res.status).toBe(303);
			expect(res.headers.get('location')).toBe(`/everything#${m}`);
		}
	});
});

describe('Catch the Stork', () => {
	afterEach(() => vi.useRealTimers());

	async function start(req: ReturnType<typeof setup>['req']) {
		const res = await req('/api/stork/start', { method: 'POST', headers: { Accept: 'application/json' } });
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		return ((await res.json()) as { token: string }).token;
	}

	const lodge = (req: ReturnType<typeof setup>['req'], body: Record<string, unknown>) =>
		req('/api/stork/score', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

	it('renders the game page with an empty leaderboard', async () => {
		const { req, env } = setup();
		clearScoreCache(env);
		const res = await req('/stork');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('data-stork-canvas');
		expect(body).toContain('src="/stork.js"');
		expect(body).toContain('The stork is undefeated');
		expect(body).toContain('action="/api/stork/score"');
	});

	it('issues a token, takes a plausible score once, and ranks it', async () => {
		const { req, db, forms, api } = setup();
		const token = await start(req);
		expect(api.keys).toEqual(['stork-start:203.0.113.7']);
		const res = await lodge(req, { token, initials: 'abc', score: SCORE_SLACK });
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ ok: true, rank: 1, initials: 'ABC', score: SCORE_SLACK, scores: [{ rank: 1, initials: 'ABC', score: SCORE_SLACK }] });
		expect(forms.keys).toEqual(['stork:203.0.113.7']);
		const rows = db.prepare('SELECT initials, score, ip_hash FROM stork_scores').all() as Array<{ initials: string; score: number; ip_hash: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ip_hash).toMatch(/^[0-9a-f]{32}$/);
		expect(rows[0]?.ip_hash).not.toContain('203.0.113.7');

		const again = await lodge(req, { token, initials: 'XYZ', score: 1 });
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ code: 'duplicate' });

		const scores = await req('/api/stork/scores');
		expect(scores.headers.get('cache-control')).toBe('public, max-age=30');
		expect(await scores.json()).toEqual({ scores: [expect.objectContaining({ rank: 1, initials: 'ABC', score: SCORE_SLACK })] });
	});

	it('renders the leaderboard without starting ICU (Intl costs 6-8 ms of CPU cold)', async () => {
		const { req } = setup();
		expect((await lodge(req, { token: await start(req), initials: 'ICU', score: 1 })).status).toBe(201);
		const dtf = vi.spyOn(Intl, 'DateTimeFormat');
		const nf = vi.spyOn(Intl, 'NumberFormat');
		try {
			const body = await (await req('/stork')).text();
			expect(body).toMatch(/<th scope="row" class="mono stork-initials">ICU<\/th><td class="mono">1<\/td><td class="tiny muted"><time datetime="[^"]+">\d{1,2} [A-Z][a-z]{2} \d{4}<\/time>/);
			expect(dtf).not.toHaveBeenCalled();
			expect(nf).not.toHaveBeenCalled();
		} finally {
			dtf.mockRestore();
			nf.mockRestore();
		}
	});

	it('refuses scores faster than the stork can drop things', async () => {
		vi.useFakeTimers({ now: Date.parse('2026-11-07T12:00:00Z'), toFake: ['Date'] });
		const { req } = setup();
		const token = await start(req);
		vi.setSystemTime(Date.parse('2026-11-07T12:00:10Z'));
		const res = await lodge(req, { token, initials: 'ABC', score: SCORE_SLACK + 41 });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: 'implausible' });
		expect((await lodge(req, { token, initials: 'ABC', score: SCORE_SLACK + 40 })).status).toBe(201);
	});

	it('refuses forged and missing tokens, bad initials, rude initials and non-scores', async () => {
		const { req } = setup();
		const other = setup();
		const foreign = (await issueGameToken(other.env)).token;
		const token = await start(req);
		const cases: Array<[Record<string, unknown>, number, string]> = [
			[{ initials: 'ABC', score: 1 }, 400, 'token_malformed'],
			[{ token: foreign, initials: 'ABC', score: 1 }, 400, 'token_forged'],
			[{ token, initials: 'AB', score: 1 }, 400, 'initials'],
			[{ token, initials: 'A1C', score: 1 }, 400, 'initials'],
			[{ token, initials: 'wtf', score: 1 }, 400, 'initials_rude'],
			[{ token, initials: 'ABC', score: 0 }, 400, 'score'],
			[{ token, initials: 'ABC', score: '1.5' }, 400, 'score'],
			[{ token, initials: 'ABC', score: -3 }, 400, 'score'],
		];
		for (const [body, status, code] of cases) {
			const res = await lodge(req, body);
			expect(res.status, JSON.stringify(body)).toBe(status);
			expect(await res.json(), JSON.stringify(body)).toMatchObject({ ok: false, code });
		}
	});

	it(`stops a connection at ${DAILY_SCORE_CAP} scores a day`, async () => {
		const { req } = setup();
		for (let i = 0; i < DAILY_SCORE_CAP; i++) expect((await lodge(req, { token: await start(req), initials: 'ABC', score: 1 })).status).toBe(201);
		const res = await lodge(req, { token: await start(req), initials: 'ABC', score: 1 });
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ code: 'daily_limit' });
	});

	it('checks Turnstile when it is configured', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: false })));
		try {
			const { req } = setup({ env: { TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' } as Partial<Env> });
			const token = await start(req);
			const missing = await lodge(req, { token, initials: 'ABC', score: 1 });
			expect(missing.status).toBe(403);
			expect(await missing.json()).toMatchObject({ code: 'turnstile' });
			expect(fetchSpy).not.toHaveBeenCalled(); // no token: refused without asking
			const wrong = await lodge(req, { token, initials: 'ABC', score: 1, 'cf-turnstile-response': 'nope' });
			expect(wrong.status).toBe(403);
			expect(fetchSpy).toHaveBeenCalledOnce();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it('is rate-limited before anything is read', async () => {
		const { req } = setup({ forms: limiter(false), api: limiter(false) });
		expect((await req('/api/stork/start', { method: 'POST' })).status).toBe(429);
		const res = await lodge(req, { token: 'x', initials: 'ABC', score: 1 });
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ code: 'rate_limited' });
	});

	it('works without JavaScript: a form post renders a result page', async () => {
		const { req } = setup();
		const token = await start(req);
		const ok = await req('/api/stork/score', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token, initials: 'zed', score: '3' }).toString(),
		});
		expect(ok.status).toBe(200);
		const page = await ok.text();
		expect(page).toContain('Score lodged');
		expect(page).toContain('ZED');
		expect(page).toContain('noindex');

		const bad = await req('/api/stork/score', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token, initials: '<b>', score: '3' }).toString(),
		});
		expect(bad.status).toBe(400);
		const badPage = await bad.text();
		expect(badPage).toContain('Score not lodged');
		expect(badPage).toContain('exactly three letters');
		expect(badPage).not.toContain('<b>');
	});

	it('refuses an oversized body', async () => {
		const { req } = setup();
		const res = await req('/api/stork/score', {
			method: 'POST',
			headers: { ...JSON_HEADERS, 'Content-Length': '10000' },
			body: JSON.stringify({ pad: 'x'.repeat(9000) }),
		});
		expect(res.status).toBe(413);
	});
});
