import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ogImageUrl } from '../src/lib/layout';
import { ogCardPath, ogVersionStatus } from '../src/lib/og';
import { ledgerRoutes } from '../src/routes/ledger';
import { STATUSES, type AppEnv, type Status } from '../src/types';

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('pre-rendered cards', () => {
	it.each(STATUSES)('public/og/%s.png exists and is a PNG', (status) => {
		const file = join(__dirname, '..', 'public', ogCardPath(status));
		expect(existsSync(file)).toBe(true);
		expect([...readFileSync(file).subarray(0, 8)]).toEqual(PNG_HEADER);
	});
});

describe('ogVersionStatus', () => {
	it('reads the status back out of every og:image URL the layout writes', () => {
		for (const status of STATUSES) {
			for (const statusChangedAt of ['2026-11-20T03:14:00.000Z', '', 'nope']) {
				const v = new URL(ogImageUrl('https://iszacka.dad', { status, statusChangedAt })).searchParams.get('v');
				expect(ogVersionStatus(v), `${status} ${statusChangedAt}`).toBe(status);
			}
		}
	});

	it('ignores anything else', () => {
		for (const v of [undefined, null, '', 'yes', 'yes-', 'maybe-1', 'YES-1', 'yes-1x', ' yes-1', 'yes-1-2', `yes-${'9'.repeat(17)}`]) {
			expect(ogVersionStatus(v), String(v)).toBeNull();
		}
	});
});

function ogApp(state: Status, assets: (url: URL, init?: RequestInit) => Promise<Response>) {
	const fetched: Array<{ path: string; headers: Headers }> = [];
	// No DB binding at all: serving the card must not touch D1.
	const env = {
		ASSETS: {
			fetch: async (url: URL, init?: RequestInit) => {
				fetched.push({ path: url.pathname, headers: new Headers(init?.headers) });
				return assets(url, init);
			},
		},
	} as unknown as Env;
	const app = new Hono<AppEnv>();
	app.use('*', async (c, next) => {
		c.set('state', { status: state, statusChangedAt: '2026-11-20T03:14:00.000Z', dueDate: null });
		await next();
	});
	app.route('/', ledgerRoutes);
	return { fetched, request: (path: string, init?: RequestInit) => app.request(path, init, env) };
}

const png = async () =>
	new Response(new Uint8Array(PNG_HEADER), {
		headers: { 'Content-Type': 'image/png', ETag: '"card"', 'Cache-Control': 'public, max-age=0, must-revalidate' },
	});

describe('GET /og.png', () => {
	it('serves the card a versioned og:image URL names, cached for good', async () => {
		const { fetched, request } = ogApp('yes', png);
		const res = await request('/og.png?v=yes-1795144440000');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(res.headers.get('x-og-source')).toBe('static');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG_HEADER));
		expect(fetched.map((f) => f.path)).toEqual(['/og/yes.png']);
	});

	it('keeps a version pinned to its card even if this isolate has another status', async () => {
		// The page was rendered by an isolate that already saw the flip; this one lags a moment.
		const { fetched, request } = ogApp('no', png);
		const res = await request('/og.png?v=yes-1795144440000');
		expect(res.status).toBe(200);
		expect(fetched.map((f) => f.path)).toEqual(['/og/yes.png']);
	});

	it('serves the current status for a bare or unrecognised URL, briefly cached', async () => {
		for (const path of ['/og.png', '/og.png?v=maybe-1', '/og.png?v=<script>']) {
			const { fetched, request } = ogApp('soon', png);
			const res = await request(path);
			expect(res.status, path).toBe(200);
			expect(res.headers.get('cache-control'), path).toBe('public, max-age=300');
			expect(fetched.map((f) => f.path), path).toEqual(['/og/soon.png']);
		}
	});

	it('passes conditional headers through and keeps a 304', async () => {
		const { fetched, request } = ogApp('no', async (_url, init) => {
			const etag = new Headers(init?.headers).get('if-none-match');
			return etag === '"card"' ? new Response(null, { status: 304, headers: { ETag: '"card"' } }) : png();
		});
		const res = await request('/og.png?v=no-0', { headers: { 'If-None-Match': '"card"', 'If-Modified-Since': 'Fri, 06 Nov 2026 22:03:00 GMT' } });
		expect(res.status).toBe(304);
		expect(res.headers.get('etag')).toBe('"card"');
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(fetched[0]?.headers.get('if-none-match')).toBe('"card"');
		expect(fetched[0]?.headers.get('if-modified-since')).toBe('Fri, 06 Nov 2026 22:03:00 GMT');
	});

	it('says so, uncached, when the card is missing', async () => {
		const { request } = ogApp('no', async () => new Response('Not found', { status: 404 }));
		const res = await request('/og.png');
		expect(res.status).toBe(404);
		expect(res.headers.get('cache-control')).toBe('no-store');
	});
});
