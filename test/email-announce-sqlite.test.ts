// End to end on the real schema: setStatus → the announce workflow's steps → D1 rows, with only
// the network (fetch), the Durable Object and the Workflows engine faked. Also checks the D1
// round trips per step, which is what keeps each step inside Workers Free's 10 ms of CPU.

import type { WorkflowStep } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from './email-announce-d1';

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));

const { setStatus } = await import('../src/lib/state');
const { getLedger } = await import('../src/lib/ledger');
const { announce, EMAIL_BATCH_SIZE } = await import('../src/workflows/announce');

function setup(opts: { subscribers?: number; push?: number; hooks?: number; limit?: number } = {}) {
	const { D1, db, counts } = sqliteD1();
	const now = '2026-11-01T00:00:00.000Z';
	for (let i = 1; i <= (opts.subscribers ?? 0); i++) {
		db.prepare('INSERT INTO subscribers (email, frequency, token, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?)').run(
			`person${i}@example.com`,
			i % 2 ? 'big' : 'daily',
			`tok_${i}_aaaaaaaaaaaaaaaaaaaa`,
			now,
			now,
		);
	}
	for (let i = 1; i <= (opts.push ?? 0); i++) {
		db.prepare('INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)').run(`https://fcm.googleapis.com/fcm/send/${i}`, 'k', 'a');
	}
	for (let i = 1; i <= (opts.hooks ?? 0); i++) {
		db.prepare('INSERT INTO webhooks (url, kind, token) VALUES (?, ?, ?)').run(`https://example.com/hook/${i}`, 'generic', `hooktoken_${i}_bbbbbbbbbbbbbbbb`);
	}
	const broadcasts: unknown[] = [];
	const created: Array<{ id: string; params: Record<string, unknown> }> = [];
	const env = {
		DB: D1,
		SITE_URL: 'https://iszacka.dad',
		RESEND_API_KEY: 're_test',
		EMAIL_FROM: 'stork@iszacka.dad',
		EMAIL_FROM_NAME: 'The Stork',
		EMAIL_DAILY_LIMIT: String(opts.limit ?? 1000),
		WAITING_ROOM: { idFromName: () => 'global', get: () => ({ broadcast: async (msg: unknown) => void broadcasts.push(msg) }) },
		ANNOUNCE: {
			create: async (o: { id: string; params: Record<string, unknown> }) => {
				created.push(o);
				return { id: o.id };
			},
		},
	} as unknown as Env;

	const requests: Array<{ url: string; init: RequestInit }> = [];
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = String(input);
		requests.push({ url, init });
		if (url.endsWith('/emails/batch')) {
			const body = JSON.parse(String(init.body)) as unknown[];
			return Response.json({ data: body.map((_, i) => ({ id: `email-${requests.length}-${i}` })), errors: [] });
		}
		if (url.startsWith('https://fcm.googleapis.com/')) return new Response(null, { status: 201 });
		return new Response(null, { status: 204 });
	});
	return { env, db, counts, broadcasts, created, requests };
}

/** Runs steps inline, recording D1 round trips and fetches per step. */
function recordingStep(counts: { roundTrips: number }, requests: unknown[], hooks: { onSleep?: () => Promise<void> | void; onSleepUntil?: () => void } = {}) {
	const perStep: Array<{ name: string; d1: number; fetches: number }> = [];
	const step = {
		async do(name: string, a: unknown, b?: unknown) {
			const fn = (typeof a === 'function' ? a : b) as (ctx: { attempt: number }) => Promise<unknown>;
			const d0 = counts.roundTrips;
			const f0 = requests.length;
			const out = await fn({ attempt: 1 });
			perStep.push({ name, d1: counts.roundTrips - d0, fetches: requests.length - f0 });
			return out;
		},
		async sleep() {
			await hooks.onSleep?.();
		},
		async sleepUntil() {
			hooks.onSleepUntil?.();
		},
	};
	return { step: step as unknown as WorkflowStep, perStep };
}

afterEach(() => vi.unstubAllGlobals());

describe('setStatus → announce, on the real schema', () => {
	it('setStatus is one read and one batch write, then hands everything else to the workflow', async () => {
		const { env, db, counts, broadcasts, created } = setup();
		const before = counts.roundTrips;
		const change = await setStatus(env, 'yes', { note: 'The baby is here.' });
		expect(counts.roundTrips - before).toBe(2);
		expect(change?.update).toMatchObject({ id: 1, kind: 'status', status: 'yes', body: 'The baby is here.', audience: 'all' });
		expect(created).toEqual([{ id: 'update-1', params: { updateId: 1, publish: true, ledgerNote: 'The baby is here.' } }]);
		expect(broadcasts).toEqual([]); // the workflow's first steps do that
		expect(db.prepare("SELECT value FROM settings WHERE key = 'status'").get()).toEqual({ value: 'yes' });
		expect(db.prepare('SELECT status FROM status_history ORDER BY id DESC LIMIT 1').get()).toEqual({ status: 'yes' });
		expect(await setStatus(env, 'yes')).toBeNull();
	});

	it('broadcasts inline if the workflow cannot start, so open browsers still flip', async () => {
		const { env, broadcasts } = setup();
		(env.ANNOUNCE as unknown as { create: () => Promise<never> }).create = async () => {
			throw new Error('Workflows unavailable');
		};
		await setStatus(env, 'soon');
		expect(broadcasts.map((m) => (m as { type: string }).type)).toEqual(['state', 'update']);
	});

	it('announces a YES in small steps: browsers and ledger first, then batches of push, webhooks and email', async () => {
		const { env, db, counts, broadcasts, created, requests } = setup({ subscribers: 45, push: 12, hooks: 12 });
		await getLedger(env); // production already has its signing keys and genesis entry
		await setStatus(env, 'yes', { note: 'The baby is here.' });
		const params = created[0]?.params as { updateId: number; publish: boolean; ledgerNote: string };
		const { step, perStep } = recordingStep(counts, requests);
		const summary = await announce(env, params.updateId, 'update-1', step, params);

		expect(broadcasts).toEqual([
			{ type: 'state', state: expect.objectContaining({ status: 'yes' }) },
			{ type: 'update', update: expect.objectContaining({ id: 1, status: 'yes' }) },
		]);
		const ledger = db.prepare('SELECT seq, status, note FROM ledger ORDER BY seq').all();
		expect(ledger).toEqual([
			expect.objectContaining({ seq: 0, status: 'no' }),
			expect.objectContaining({ seq: 1, status: 'yes', note: 'The baby is here.' }),
		]);
		expect(summary).toMatchObject({ push: { sent: 12 }, webhook: { sent: 12 }, email: { sent: 45 }, ledger: { seq: 1 } });

		const sent = db.prepare("SELECT channel, COUNT(*) AS n FROM deliveries WHERE update_id = 1 AND ok = 1 GROUP BY channel ORDER BY channel").all();
		expect(sent).toEqual([
			{ channel: 'dns', n: 1 },
			{ channel: 'email', n: 45 },
			{ channel: 'push', n: 12 },
			{ channel: 'webhook', n: 12 },
		]);
		// One Resend request per email step, all permissive, all with the User-Agent Resend requires.
		const resend = requests.filter((r) => r.url.endsWith('/emails/batch'));
		expect(resend).toHaveLength(Math.ceil(45 / EMAIL_BATCH_SIZE));
		for (const r of resend) {
			const headers = r.init.headers as Record<string, string>;
			expect(headers['x-batch-validation']).toBe('permissive');
			expect(headers['User-Agent']).toMatch(/iszacka\.dad/);
			expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(db.prepare('SELECT n FROM email_sends').get()).toEqual({ n: 45 });

		// The budget: a handful of D1 round trips and well under 50 subrequests per step.
		for (const s of perStep) {
			expect(s.fetches, s.name).toBeLessThanOrEqual(20);
			expect(s.d1, s.name).toBeLessThanOrEqual(6);
		}
		const emailSteps = perStep.filter((s) => s.name.startsWith('email after'));
		expect(emailSteps.map((s) => s.fetches)).toEqual([1, 1, 1]);
	});

	it('a re-run sends nothing twice and costs no Resend request', async () => {
		const { env, counts, created, requests } = setup({ subscribers: 25, push: 3, hooks: 3 });
		await setStatus(env, 'yes');
		const params = created[0]?.params as { updateId: number };
		await announce(env, params.updateId, 'update-1', recordingStep(counts, requests).step, created[0]?.params);
		const before = requests.length;
		const again = await announce(env, params.updateId, 'update-1-r1', recordingStep(counts, requests).step);
		expect(again).toMatchObject({ email: { sent: 0, skipped: 25 }, push: { sent: 0 }, webhook: { sent: 0 } });
		expect(requests.length - before).toBe(0);
	});

	it('an undo inside the grace period stays quiet, even though DNS was already written', async () => {
		const { env, db, counts, created, requests } = setup({ subscribers: 5, push: 2, hooks: 2 });
		await setStatus(env, 'soon');
		const first = created[0]?.params as { updateId: number };
		// The admin flips back while the first update sits in its undo window.
		const soon = await announce(env, first.updateId, 'update-1', recordingStep(counts, requests, { onSleep: () => void setStatus(env, 'no') }).step, created[0]?.params);
		await vi.waitFor(() => expect(created).toHaveLength(2));
		expect(soon).toMatchObject({ superseded: true, reason: 'changed' });

		const second = created[1]?.params as { updateId: number };
		const no = await announce(env, second.updateId, 'update-2', recordingStep(counts, requests).step, created[1]?.params);
		// "soon" reached nobody (its DNS write doesn't count), so "no" is not news either.
		expect(no).toMatchObject({ superseded: true, reason: 'reverted' });
		expect(db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE channel IN ('email', 'push', 'webhook')").get()).toEqual({ n: 0 });
		expect(requests.filter((r) => !r.url.includes('api.cloudflare.com'))).toEqual([]);
		// Both changes are in the ledger, in order.
		expect(db.prepare('SELECT status FROM ledger ORDER BY seq').all()).toEqual([{ status: 'no' }, { status: 'soon' }, { status: 'no' }]);
	});

	it('reads the quota once per step, sends only what it allows, and finishes after the reset', async () => {
		const { env, db, counts, created, requests } = setup({ subscribers: 30, limit: 25 });
		await setStatus(env, 'yes');
		const params = created[0]?.params as { updateId: number };
		let resets = 0;
		const { step, perStep } = recordingStep(counts, requests, {
			onSleepUntil: () => {
				resets++;
				db.exec('DELETE FROM email_sends'); // midnight UTC
			},
		});
		const summary = await announce(env, params.updateId, 'update-1', step, created[0]?.params);
		expect(resets).toBe(1);
		expect(summary.email).toMatchObject({ sent: 30, quotaWaits: 1, deferred: 0 });
		const sizes = requests.filter((r) => r.url.endsWith('/emails/batch')).map((r) => (JSON.parse(String(r.init.body)) as unknown[]).length);
		expect(sizes).toEqual([20, 5, 5]);
		expect(perStep.filter((s) => s.name.startsWith('email')).map((s) => s.name)).toEqual(['email after 0', 'email after 20', 'email after 20 #2']);
		expect(db.prepare('SELECT n FROM email_sends').get()).toEqual({ n: 5 });
	});
});
