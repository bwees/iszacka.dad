// /achievements: the server's only job is an empty shell for delights.js to fill in.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { FOOTER_SECTIONS } from '../src/lib/layout';
import { PUBLIC_PAGES } from '../src/lib/feeds-text';
import { ACHIEVEMENTS_PATH, delightsRoutes } from '../src/routes/delights';
import type { AppEnv, SiteState } from '../src/types';

const STATE: SiteState = { status: 'no', statusChangedAt: '2026-11-06T21:30:00.000Z', dueDate: '2026-11-20' };

async function get(path: string) {
	const app = new Hono<AppEnv>();
	app.use('*', async (c, next) => {
		c.set('state', STATE);
		await next();
	});
	app.route('/', delightsRoutes);
	const res = await app.request(path, {}, { SITE_URL: 'https://iszacka.dad' } as Env);
	return { res, text: await res.text() };
}

describe('GET /achievements', () => {
	it('renders the shell inside the site layout', async () => {
		const { res, text } = await get('/achievements');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(text).toContain('<title>Achievements · Is Zack a Dad?</title>');
		expect(text).toContain('<link rel="canonical" href="https://iszacka.dad/achievements">');
		expect(text).toContain('data-achievements');
		expect(text).toContain('<script type="module" src="/delights.js"></script>');
		expect(text).toContain('<link rel="stylesheet" href="/delights.css">');
		expect(text).toContain('<noscript>');
		expect(text).toContain('data-due-date="2026-11-20"');
	});

	it('has no inline scripts (CSP) and no gendered pronouns', async () => {
		const { text } = await get('/achievements');
		const inline = [...text.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1] ?? '');
		expect(inline.every((attrs) => attrs.includes('application/json'))).toBe(true);
		const main = text.split('<main')[1]?.split('</main>')[0] ?? '';
		expect(main.match(/\b(he|him|his|she|her|hers)\b/gi) ?? []).toEqual([]);
	});

	it('renders the same markup every time (cached per isolate)', async () => {
		const main = (t: string) => t.split('<main')[1]?.split('</main>')[0];
		expect(main((await get('/achievements')).text)).toBe(main((await get('/achievements')).text));
	});

	it('is linked from the footer and listed in the sitemap', () => {
		expect(ACHIEVEMENTS_PATH).toBe('/achievements');
		expect(FOOTER_SECTIONS.flatMap((s) => s.links.map((l) => l.href))).toContain('/achievements');
		expect(PUBLIC_PAGES.map((p) => p.path)).toContain('/achievements');
	});

	it('does not answer anything else', async () => {
		expect((await get('/achievements/extra')).res.status).toBe(404);
	});
});
