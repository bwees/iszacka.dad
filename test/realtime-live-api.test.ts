import { describe, expect, it, vi } from 'vitest';

const room = vi.hoisted(() => ({ liveSnapshot: vi.fn() }));
vi.mock('../src/lib/layout', () => ({ renderPage: vi.fn() }));

const { liveRoutes } = await import('../src/routes/live');

// The real lib/live helpers, talking to a fake WaitingRoom stub (no checkTotal RPC, so the
// check total falls back to D1).
const env = {
	DB: { prepare: () => ({ first: async () => ({ total: 41 }) }) },
	WAITING_ROOM: { idFromName: () => 'global', get: () => room },
} as unknown as Env;

describe('/api/live', () => {
	it('carries the reload nonce, so polling tabs obey "reload every browser"', async () => {
		room.liveSnapshot.mockResolvedValueOnce({ viewers: 2, vibes: 3, reloadNonce: 'nonce-1' });
		const res = await liveRoutes.request('https://iszacka.dad/api/live', {}, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ viewers: 2, vibes: 3, checks: 41, reloadNonce: 'nonce-1' });
	});

	it('takes the check total from the same snapshot when the room has it', async () => {
		room.liveSnapshot.mockResolvedValueOnce({ viewers: 1, vibes: 0, checks: 1234, reloadNonce: 'nonce-2' });
		const res = await liveRoutes.request('https://iszacka.dad/api/live', {}, env);
		expect(await res.json()).toMatchObject({ viewers: 1, checks: 1234, reloadNonce: 'nonce-2' });
	});

	it('leaves the nonce out (rather than sending an empty one) when the waiting room is down', async () => {
		room.liveSnapshot.mockRejectedValueOnce(new Error('DO unavailable'));
		const res = await liveRoutes.request('https://iszacka.dad/api/live', {}, env);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ viewers: 0, vibes: 0 });
		expect('reloadNonce' in body).toBe(false);
	});
});
