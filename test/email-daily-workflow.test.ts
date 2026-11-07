// The DailyWorkflow the cron starts: one step per chore, on the real schema.

import type { WorkflowStep } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from './email-announce-d1';

const h = vi.hoisted(() => ({
	updateAnswerRecord: vi.fn(async (_env: unknown, _state: unknown) => ({ ok: true, detail: 'answer.iszacka.dad already says it' })),
}));
vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));
vi.mock('../src/notify/dns', () => ({ updateAnswerRecord: h.updateAnswerRecord }));
vi.mock('../src/lib/counters', () => ({ getCheckTotal: async () => 1234 }));

const { postDaily, runDaily } = await import('../src/workflows/daily');

const NOW = new Date('2026-11-07T09:00:05.000Z');
const TODAY = '2026-11-07';

function setup(opts: { status?: 'no' | 'soon' | 'yes'; changedAt?: string; sentToday?: number } = {}) {
	const { D1, db } = sqliteD1();
	db.prepare("UPDATE status_history SET at = '2026-09-21T10:00:00.000Z'").run();
	db.prepare("INSERT INTO settings (key, value) VALUES ('status', ?), ('status_changed_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
		opts.status ?? 'no',
		opts.changedAt ?? '2026-09-21T10:00:00.000Z',
	);
	if (opts.sentToday) db.prepare('INSERT INTO email_sends (day, n) VALUES (?, ?)').run(TODAY, opts.sentToday);
	const created: Array<{ id: string; params: unknown }> = [];
	const env = {
		DB: D1,
		EMAIL_DAILY_LIMIT: '90',
		WAITING_ROOM: { idFromName: () => 'global', get: () => ({ broadcast: async () => {} }) },
		ANNOUNCE: { create: async (o: { id: string; params: unknown }) => void created.push(o) },
	} as unknown as Env;
	return { env, db, created };
}

function inlineStep() {
	const names: string[] = [];
	const step = {
		async do(name: string, _config: unknown, fn: () => Promise<unknown>) {
			names.push(name);
			for (let attempt = 1; ; attempt++) {
				try {
					return await fn();
				} catch (err) {
					if (attempt >= 4) throw err;
				}
			}
		},
	};
	return { step: step as unknown as WorkflowStep, names };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	h.updateAnswerRecord.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('DailyWorkflow', () => {
	it('does each chore as its own step: post, DNS, purge subscribers, purge Resend events', async () => {
		const { env, db, created } = setup();
		const { step, names } = inlineStep();
		const summary = await runDaily(env, { day: TODAY, at: NOW.toISOString() }, step, NOW);

		expect(names).toEqual(['post daily update', 'sync DNS answer record', 'purge subscribers', 'purge resend events']);
		expect(summary.daily).toMatchObject({ action: 'posted', title: 'Day 48: still no.', phase: 'waiting' });
		const update = db.prepare('SELECT kind, title, body, status, audience FROM updates').get() as Record<string, string>;
		expect(update).toMatchObject({ kind: 'daily', title: 'Day 48: still no.', status: 'no', audience: 'daily' });
		expect(update.body).toContain('The answer has been checked 1,234 times.');
		// The announce workflow publishes it (live broadcast included) and fans it out.
		expect(created).toEqual([{ id: 'update-1', params: { updateId: 1, publish: true } }]);
		expect(h.updateAnswerRecord).toHaveBeenCalledWith(env, expect.objectContaining({ status: 'no' }));
		expect(summary).toMatchObject({ dns: { ok: true }, purge: { unconfirmed: 0, unsubscribed: 0 }, resendEvents: { purged: 0 } });
	});

	it('never posts twice in a day (a retried step, or a second instance)', async () => {
		const { env, db } = setup();
		expect(await postDaily(env, TODAY, NOW)).toMatchObject({ action: 'posted' });
		expect(await postDaily(env, TODAY, NOW)).toEqual({ action: 'skipped', reason: `already posted for ${TODAY}` });
		expect(db.prepare('SELECT COUNT(*) AS n FROM updates').get()).toEqual({ n: 1 });
	});

	it("doesn't post a day late", async () => {
		const { env } = setup();
		expect(await postDaily(env, '2026-11-06', NOW)).toMatchObject({ action: 'skipped', reason: expect.stringMatching(/the day is over/) });
	});

	it('leaves the last emails of the day to real news', async () => {
		const { env, created } = setup({ sentToday: 80 });
		expect(await postDaily(env, TODAY, NOW)).toEqual({ action: 'skipped', reason: 'email quota reserve (10) reached' });
		expect(created).toEqual([]);
	});

	it('runs the dad days after YES, the farewell once, then nothing (and never renders a social card)', async () => {
		const { env, db } = setup({ status: 'yes', changedAt: '2026-10-20T14:00:00.000Z' });
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		expect(await postDaily(env, TODAY, NOW)).toMatchObject({ action: 'posted', phase: 'concluded', title: 'Daily service concluded.' });
		db.prepare("UPDATE updates SET created_at = '2026-11-06T09:00:00.000Z'").run(); // as if yesterday
		expect(await postDaily(env, TODAY, NOW)).toEqual({ action: 'skipped', reason: 'daily service has concluded' });
		expect(fetch).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('forgets stale sign-ups, long-gone subscribers and old Resend deliveries', async () => {
		const { env, db } = setup();
		const insert = db.prepare('INSERT INTO subscribers (email, token, created_at, confirm_sent_at, confirmed_at, unsubscribed_at) VALUES (?, ?, ?, ?, ?, ?)');
		insert.run('stale@example.com', 't1', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', null, null);
		insert.run('fresh@example.com', 't2', '2026-11-06T00:00:00.000Z', '2026-11-06T00:00:00.000Z', null, null);
		insert.run('gone@example.com', 't3', '2026-01-01T00:00:00.000Z', null, '2026-01-02T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		insert.run('here@example.com', 't4', '2026-01-01T00:00:00.000Z', null, '2026-01-02T00:00:00.000Z', null);
		db.prepare('INSERT INTO resend_events (svix_id, type, at) VALUES (?, ?, ?), (?, ?, ?)').run(
			'old',
			'email.received',
			'2026-09-01T00:00:00.000Z',
			'new',
			'email.received',
			'2026-11-06T00:00:00.000Z',
		);
		const summary = await runDaily(env, { day: TODAY, at: NOW.toISOString() }, inlineStep().step, NOW);
		expect(summary).toMatchObject({ purge: { unconfirmed: 1, unsubscribed: 1 }, resendEvents: { purged: 1 } });
		expect(db.prepare('SELECT email FROM subscribers ORDER BY id').all()).toEqual([{ email: 'fresh@example.com' }, { email: 'here@example.com' }]);
	});

	it('keeps going when a chore fails for good, then fails the instance so it shows up', async () => {
		const { env, created } = setup();
		h.updateAnswerRecord.mockResolvedValue({ ok: false, detail: 'Cloudflare API timed out' });
		const { step, names } = inlineStep();
		await expect(runDaily(env, { day: TODAY }, step, NOW)).rejects.toThrow(/1 chore\(s\) failed: sync DNS answer record: DNS sync failed: Cloudflare API timed out/);
		expect(names).toEqual(['post daily update', 'sync DNS answer record', 'purge subscribers', 'purge resend events']);
		expect(h.updateAnswerRecord).toHaveBeenCalledTimes(4); // retried by the step
		expect(created).toHaveLength(1);
		h.updateAnswerRecord.mockResolvedValue({ ok: true, detail: 'ok' });
	});
});
