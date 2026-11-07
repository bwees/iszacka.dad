import { describe, expect, it, vi } from 'vitest';
import type { SiteState } from '../src/types';

// The root middleware (src/index.ts): which requests read the state, which count as checks,
// and that the headers still work without state.

vi.mock('cloudflare:workers', () => {
	class Base {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	}
	return { DurableObject: Base, WorkflowEntrypoint: Base, WorkerEntrypoint: Base };
});
const getState = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/state', async (importOriginal) => ({ ...(await importOriginal<object>()), getState }));

const { default: worker } = await import('../src/index');

const STATE: SiteState = { status: 'no', statusChangedAt: '2026-11-01T09:00:00.000Z', dueDate: '2026-11-20' };
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

function harness() {
	getState.mockReset();
	getState.mockResolvedValue(STATE);
	const room = {
		recordCheck: vi.fn(async (_check: unknown) => {}),
		fetch: vi.fn(async () => new Response('The waiting room is full.', { status: 503 })),
	};
	const allow = { limit: async () => ({ success: true }) };
	const env = {
		ENVIRONMENT: 'production',
		SITE_URL: 'https://iszacka.dad',
		DB: {
			prepare: () => {
				throw new Error('no D1 in this test');
			},
		},
		WAITING_ROOM: { idFromName: () => ({}), get: () => room },
		RL_API: allow,
		RL_FORMS: { limit: async () => ({ success: false }) },
		RL_EMAIL: allow,
	} as unknown as Env;
	const waits: Array<Promise<unknown>> = [];
	const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
	const fetch = async (path: string, init: RequestInit = {}, cf: Record<string, unknown> = { country: 'GB', colo: 'LHR' }) => {
		const req = new Request(`https://iszacka.dad${path}`, { ...init, headers: { 'user-agent': BROWSER, ...init.headers } });
		Object.defineProperty(req, 'cf', { value: cf });
		const res = await worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
		await Promise.all(waits);
		return res;
	};
	return { env, room, fetch };
}

describe('root middleware', () => {
	it('reads the state, sets the answer headers and counts a check on a counted path', async () => {
		const { room, fetch } = harness();
		const res = await fetch('/api/status.txt');
		expect(res.status).toBe(200);
		expect(getState).toHaveBeenCalledTimes(1);
		expect(res.headers.get('x-is-zack-a-dad')).toBeTruthy();
		expect(res.headers.get('x-days-until-due')).toMatch(/^-?\d+$/);
		expect(res.headers.get('server-timing')).toContain('gestation;dur=');
		expect(room.recordCheck).toHaveBeenCalledTimes(1);
		expect(room.recordCheck.mock.calls[0]?.[0]).toMatchObject({ country: 'GB', colo: 'LHR' });
	});

	it("doesn't count refresh polls or bots", async () => {
		const { room, fetch } = harness();
		await fetch('/api/status.txt?poll=1');
		await fetch('/api/status.txt', { headers: { 'user-agent': 'Twitterbot/1.0' } });
		expect(room.recordCheck).not.toHaveBeenCalled();
	});

	it('skips the state read on routes that never use it, and still sets the security headers', async () => {
		const { room, fetch } = harness();
		const robots = await fetch('/robots.txt');
		expect(robots.status).toBe(200);
		const security = await fetch('/.well-known/security.txt');
		expect(security.status).toBe(200);
		const webhook = await fetch('/api/resend/webhook', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
		expect([401, 503]).toContain(webhook.status);
		const push = await fetch('/api/push/subscribe', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
		expect(push.status).toBe(429);
		expect(getState).not.toHaveBeenCalled();
		for (const res of [robots, security, webhook, push]) {
			expect(res.headers.get('x-is-zack-a-dad')).toBeNull();
			expect(res.headers.get('x-days-until-due')).toBeNull();
			expect(res.headers.get('x-content-type-options')).toBe('nosniff');
			expect(res.headers.get('strict-transport-security')).toMatch(/max-age=/);
			expect(res.headers.get('server-timing')).toMatch(/^app;dur=\d+/);
			expect(res.headers.get('server-timing')).not.toContain('gestation');
		}
		expect(room.recordCheck).not.toHaveBeenCalled();
	});

	it('skips it for WebSocket upgrades, but not for a plain GET /ws', async () => {
		const { room, fetch } = harness();
		const upgrade = await fetch('/ws', { headers: { Upgrade: 'websocket' } });
		expect(room.fetch).toHaveBeenCalledTimes(1);
		expect(upgrade.status).toBe(503); // the fake room says no
		expect(getState).not.toHaveBeenCalled();
		const plain = await fetch('/ws');
		expect(plain.status).toBe(426);
		expect(getState).toHaveBeenCalledTimes(1);
		expect(plain.headers.get('x-is-zack-a-dad')).toBeTruthy();
	});

	it('still reads the state for unknown paths (the 404 page shows the answer)', async () => {
		const { fetch } = harness();
		const res = await fetch('/api/push/nope');
		expect(res.status).toBe(404);
		expect(getState).toHaveBeenCalledTimes(1);
		expect(res.headers.get('x-is-zack-a-dad')).toBeTruthy();
	});
});
