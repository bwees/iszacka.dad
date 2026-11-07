import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { adminCookieName, adminFlashCookieName, SESSION_TTL_SECONDS, signSession } from '../src/lib/admin';
import { adminRoutes, OG_RENDER_GONE } from '../src/routes/admin';
import type { AppEnv } from '../src/types';

// The live OG render is gone; /admin/og/render only sends stale tabs and bookmarks home.

const ORIGIN = 'https://iszacka.dad';
const PASSWORD = 'correct horse battery staple';
const SALT = 'test-salt-0001';

const env = {
	ADMIN_PASSWORD: PASSWORD,
	DB: {
		prepare: (sql: string) => {
			const stmt = {
				bind: () => stmt,
				first: async () => (sql.includes('FROM settings') ? { value: SALT } : null),
				run: async () => ({}),
			};
			return stmt;
		},
	},
} as unknown as Env;

function app() {
	const a = new Hono<AppEnv>();
	a.use('*', async (c, next) => {
		c.set('state', { status: 'no', statusChangedAt: '2026-11-01T09:00:00.000Z', dueDate: null });
		await next();
	});
	a.route('/admin', adminRoutes);
	return { request: (url: string, init?: RequestInit) => a.request(url, init, env) };
}

async function session(): Promise<string> {
	const value = await signSession({ password: PASSWORD, salt: SALT }, Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);
	return `${adminCookieName(ORIGIN)}=${value}`;
}

function flashFrom(res: Response): string {
	const cookie = res.headers.get('set-cookie') ?? '';
	const prefix = `${adminFlashCookieName(ORIGIN)}=`;
	const start = cookie.indexOf(prefix);
	if (start < 0) return '';
	return decodeURIComponent(cookie.slice(start + prefix.length).split(';')[0] ?? '');
}

describe('/admin/og/render', () => {
	for (const method of ['GET', 'POST']) {
		it(`${method} sends an admin back to /admin with a fixed notice`, async () => {
			const res = await app().request(`${ORIGIN}/admin/og/render`, {
				method,
				headers: { cookie: await session(), origin: ORIGIN },
			});
			expect(res.status).toBe(303);
			expect(res.headers.get('location')).toBe('/admin');
			expect(flashFrom(res)).toBe(`ok:${OG_RENDER_GONE}`);
		});
	}

	it('answers JSON clients with 410 Gone', async () => {
		const res = await app().request(`${ORIGIN}/admin/og/render`, {
			method: 'POST',
			headers: { cookie: await session(), origin: ORIGIN, accept: 'application/json' },
		});
		expect(res.status).toBe(410);
		expect(await res.json()).toEqual({ ok: false, message: OG_RENDER_GONE });
	});

	it('still sends anonymous visitors to the login page', async () => {
		const post = await app().request(`${ORIGIN}/admin/og/render`, { method: 'POST', headers: { origin: ORIGIN } });
		expect(post.status).toBe(303);
		expect(post.headers.get('location')).toBe('/admin/login');
		expect(flashFrom(post)).toBe('');

		const get = await app().request(`${ORIGIN}/admin/og/render`);
		expect(get.status).toBe(303);
		expect(get.headers.get('location')).toBe('/admin/login?next=%2Fadmin%2Fog%2Frender');
	});

	it('is no longer offered on the dashboard', () => {
		const source = readFileSync(join(__dirname, '..', 'src', 'routes', 'admin.ts'), 'utf8');
		expect(source).not.toMatch(/action="\/admin\/og\/render"/);
		expect(source).not.toMatch(/renderOgImage|Browser Rendering/);
	});

	it('fits in a flash cookie untruncated', () => {
		expect(OG_RENDER_GONE.length).toBeLessThan(300);
	});
});
