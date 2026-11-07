import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { blobToBytes, describeLaunchFailure, isOgImageUsable, isPng, OG_MAX_AGE_MS } from '../src/lib/og';
import { ledgerRoutes } from '../src/routes/ledger';
import type { AppEnv } from '../src/types';

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('blobToBytes', () => {
	it('accepts the number[] D1 returns for BLOBs', () => {
		expect(blobToBytes([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('accepts ArrayBuffer and Uint8Array', () => {
		expect(blobToBytes(new Uint8Array([4, 5]).buffer)).toEqual(new Uint8Array([4, 5]));
		const bytes = new Uint8Array([6]);
		expect(blobToBytes(bytes)).toBe(bytes);
	});

	it('rejects anything else', () => {
		expect(blobToBytes('png')).toBeNull();
		expect(blobToBytes(null)).toBeNull();
		expect(blobToBytes([1, 'two'])).toBeNull();
	});
});

describe('isPng', () => {
	it('recognises the PNG signature', () => {
		expect(isPng(new Uint8Array([...PNG_HEADER, 0, 0, 0, 13]))).toBe(true);
	});

	it('rejects other bytes and bare signatures', () => {
		expect(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]))).toBe(false);
		expect(isPng(new Uint8Array(PNG_HEADER))).toBe(false);
	});
});

describe('isOgImageUsable', () => {
	const now = Date.parse('2026-11-06T12:00:00.000Z');

	it('serves a fresh render of the current status', () => {
		expect(isOgImageUsable({ status: 'no', createdAt: '2026-11-06T11:00:00.000Z' }, 'no', now)).toBe(true);
	});

	it('refuses a render of a different status', () => {
		expect(isOgImageUsable({ status: 'no', createdAt: '2026-11-06T11:59:00.000Z' }, 'yes', now)).toBe(false);
	});

	it('refuses a render 48 hours old or older', () => {
		const justInside = new Date(now - OG_MAX_AGE_MS + 1000).toISOString();
		const justOutside = new Date(now - OG_MAX_AGE_MS).toISOString();
		expect(isOgImageUsable({ status: 'soon', createdAt: justInside }, 'soon', now)).toBe(true);
		expect(isOgImageUsable({ status: 'soon', createdAt: justOutside }, 'soon', now)).toBe(false);
	});

	it('refuses unparseable or far-future timestamps', () => {
		expect(isOgImageUsable({ status: 'no', createdAt: 'yesterday-ish' }, 'no', now)).toBe(false);
		expect(isOgImageUsable({ status: 'no', createdAt: '2026-11-07T12:00:00.000Z' }, 'no', now)).toBe(false);
	});
});

describe('describeLaunchFailure', () => {
	it('labels quota and rate-limit errors', () => {
		expect(describeLaunchFailure(new Error('Unable to create new browser: code: 429: message: Too many browsers'))).toMatch(
			/quota or rate limit/,
		);
		expect(describeLaunchFailure(new Error('Browser time limit exceeded for today'))).toMatch(/quota or rate limit/);
	});

	it('passes other failures through, truncated', () => {
		const detail = describeLaunchFailure(new Error(`boom ${'x'.repeat(1000)}`));
		expect(detail).toMatch(/^Could not launch a browser: boom/);
		expect(detail.length).toBeLessThan(400);
		expect(describeLaunchFailure('plain string')).toBe('Could not launch a browser: plain string');
	});
});

describe('GET /og.png', () => {
	it('ignores the ?v= cache-buster the layout adds to og:image', async () => {
		const fetched: string[] = [];
		const env = {
			DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
			ASSETS: {
				fetch: async (url: URL) => {
					fetched.push(url.pathname);
					return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/png' } });
				},
			},
		} as unknown as Env;
		const app = new Hono<AppEnv>();
		app.use('*', async (c, next) => {
			c.set('state', { status: 'yes', statusChangedAt: '2026-11-20T03:14:00.000Z', dueDate: null });
			await next();
		});
		app.route('/', ledgerRoutes);
		const res = await app.request('/og.png?v=yes-1795144440000', {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('x-og-source')).toBe('static');
		expect(fetched).toEqual(['/og/yes.png']);
	});
});
