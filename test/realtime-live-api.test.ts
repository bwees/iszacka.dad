import { describe, expect, it, vi } from 'vitest';

const room = vi.hoisted(() => ({ liveSnapshot: vi.fn() }));
vi.mock('../src/lib/live', () => ({ waitingRoom: () => room, liveStats: vi.fn(), broadcast: vi.fn() }));
vi.mock('../src/lib/layout', () => ({ renderPage: vi.fn() }));

const { liveRoutes } = await import('../src/routes/live');

const env = {
	DB: { prepare: () => ({ first: async () => ({ total: 41 }) }) },
} as unknown as Env;

describe('/api/live', () => {
	it('carries the reload nonce, so polling tabs obey "reload every browser"', async () => {
		room.liveSnapshot.mockResolvedValueOnce({ viewers: 2, vibes: 3, reloadNonce: 'nonce-1' });
		const res = await liveRoutes.request('https://iszacka.dad/api/live', {}, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ viewers: 2, vibes: 3, checks: 41, reloadNonce: 'nonce-1' });
	});

	it('leaves the nonce out (rather than sending an empty one) when the waiting room is down', async () => {
		room.liveSnapshot.mockRejectedValueOnce(new Error('DO unavailable'));
		const res = await liveRoutes.request('https://iszacka.dad/api/live', {}, env);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ viewers: 0, vibes: 0 });
		expect('reloadNonce' in body).toBe(false);
	});
});
