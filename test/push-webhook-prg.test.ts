import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/layout', () => ({ renderPage: vi.fn(async () => new Response('page')) }));
const notify = vi.hoisted(() => ({ sendWebhook: vi.fn(async () => ({ ok: true, status: 204, detail: 'HTTP 204' })) }));
vi.mock('../src/notify/webhooks', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/notify/webhooks')>()),
	sendWebhook: notify.sendWebhook,
}));

const { webhookRoutes } = await import('../src/routes/webhooks');

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const HOOK = {
	id: 1,
	url: 'https://discord.com/api/webhooks/1/x',
	kind: 'discord',
	frequency: 'big',
	token: TOKEN,
	failures: 0,
	last_status: 204,
	last_sent_at: null,
	created_at: '2026-11-01T00:00:00.000Z',
	disabled_at: null,
};

function app() {
	const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => HOOK, run: async () => ({ meta: { changes: 1 } }) }) }) } } as unknown as Env;
	// The root middleware normally sets the state.
	const wrapped = new (webhookRoutes.constructor as typeof import('hono').Hono)();
	wrapped.use('*', async (c, next) => {
		c.set('state' as never, { status: 'no', statusChangedAt: '2026-11-01T00:00:00.000Z', dueDate: null } as never);
		await next();
	});
	wrapped.route('/', webhookRoutes);
	return { req: (path: string, init: RequestInit = {}) => wrapped.request(`https://iszacka.dad${path}`, init, env) };
}

describe('webhook management after a test (no JS)', () => {
	it('redirects back to the bookmarkable page with a fixed outcome key', async () => {
		const res = await app().req(`/webhooks/${TOKEN}/test`, { method: 'POST' });
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe(`/webhooks/${TOKEN}?test=ok`);
		expect(res.headers.get('referrer-policy')).toBe('no-referrer');
	});

	it('sends a stray GET on the action URLs to the management page, not a 404', async () => {
		for (const action of ['test', 'delete']) {
			const res = await app().req(`/webhooks/${TOKEN}/${action}`);
			expect(res.status).toBe(303);
			expect(res.headers.get('location')).toBe(`/webhooks/${TOKEN}`);
		}
		expect(notify.sendWebhook).not.toHaveBeenCalled(); // a GET never sends anything
	});

	it('asks for the confirmation box with a redirect, not a page at the POST URL', async () => {
		const res = await app().req(`/webhooks/${TOKEN}/delete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: '',
		});
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe(`/webhooks/${TOKEN}?error=confirm`);
	});
});
