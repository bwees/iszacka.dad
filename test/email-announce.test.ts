import type { WorkflowStep } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, PushSubscriptionRow, SiteState, SubscriberRow, Update, WebhookRow } from '../src/types';

// In-memory stand-ins for D1-backed and other agents' modules.
const h = vi.hoisted(() => {
	const deliveries = new Map<string, { ok: boolean; detail?: string }>();
	return {
		deliveries,
		key: (u: number, c: string, t: number) => `${u}:${c}:${t}`,
		getUpdate: vi.fn(),
		markNotified: vi.fn(async () => {}),
		getState: vi.fn(),
		setSetting: vi.fn(async () => {}),
		renderOgImage: vi.fn(async () => ({ ok: true, detail: 'rendered' })),
		updateAnswerRecord: vi.fn(async () => ({ ok: true, detail: 'TXT updated' })),
		listPushTargets: vi.fn(async (_env: unknown, _after: number, _limit: number): Promise<PushSubscriptionRow[]> => []),
		deliverPush: vi.fn(async () => ({ ok: true })),
		listWebhookTargets: vi.fn(async (_env: unknown, _audience: string, _after: number, _limit: number): Promise<WebhookRow[]> => []),
		deliverWebhook: vi.fn(async () => ({ ok: true })),
		listEmailTargets: vi.fn(),
		deliverEmail: vi.fn(),
	};
});

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));
vi.mock('../src/lib/og', () => ({ renderOgImage: h.renderOgImage }));
vi.mock('../src/lib/state', () => ({ getState: h.getState, setSetting: h.setSetting }));
vi.mock('../src/lib/updates', () => ({ getUpdate: h.getUpdate, markNotified: h.markNotified }));
vi.mock('../src/notify/dns', () => ({ updateAnswerRecord: h.updateAnswerRecord }));
vi.mock('../src/notify/push', () => ({ listPushTargets: h.listPushTargets, deliverPush: h.deliverPush }));
vi.mock('../src/notify/webhooks', () => ({ listWebhookTargets: h.listWebhookTargets, deliverWebhook: h.deliverWebhook }));
vi.mock('../src/notify/email', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/notify/email')>()),
	listEmailTargets: h.listEmailTargets,
	deliverEmail: h.deliverEmail,
}));
vi.mock('../src/lib/deliveries', () => ({
	deliveredTargets: async (_env: unknown, u: number, c: Channel, ids: number[]) =>
		new Set(ids.filter((id) => h.deliveries.has(h.key(u, c, id)))),
	recordDelivery: async (_env: unknown, u: number, c: Channel, t: number, ok: boolean, detail?: string) => {
		h.deliveries.set(h.key(u, c, t), { ok, detail });
	},
	deliverySummary: async (_env: unknown, u: number) => {
		const out = new Map<string, { channel: string; ok: number; failed: number }>();
		for (const [k, v] of h.deliveries) {
			const [uid, channel] = k.split(':');
			if (Number(uid) !== u || !channel) continue;
			const row = out.get(channel) ?? { channel, ok: 0, failed: 0 };
			if (v.ok) row.ok++;
			else row.failed++;
			out.set(channel, row);
		}
		return [...out.values()];
	},
}));

const { BATCH_SIZE, RetryableBatchError, announce, fanOut, isFinalAttempt, judgeSupersession, runBatch, staleReason, toAttempt } = await import(
	'../src/workflows/announce'
);
type BatchDeps<T extends { id: number }> = import('../src/workflows/announce').BatchDeps<T>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

function memoryDeps(targets: Array<{ id: number }>, deliver: (t: { id: number }) => Promise<import('../src/workflows/announce').Attempt>) {
	const records = new Map<number, { ok: boolean; detail: string }>();
	const deps: BatchDeps<{ id: number }> = {
		list: async (after, limit) => targets.filter((t) => t.id > after).slice(0, limit),
		done: async (list) => new Set(list.filter((id) => records.has(id))),
		deliver: vi.fn(deliver),
		record: async (id, ok, detail) => {
			records.set(id, { ok, detail });
		},
	};
	return { deps, records };
}

/** A WorkflowStep that runs callbacks inline and retries like the real engine (limit 3 → 4 attempts). */
function fakeStep() {
	const names: string[] = [];
	const sleeps: string[] = [];
	const step = {
		async do(name: string, configOrFn: unknown, maybeFn?: unknown) {
			const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as (ctx: { attempt: number }) => Promise<unknown>;
			names.push(name);
			for (let attempt = 1; ; attempt++) {
				try {
					return await fn({ attempt });
				} catch (err) {
					if (attempt >= 4) throw err;
				}
			}
		},
		async sleep(name: string) {
			sleeps.push(name);
		},
		async sleepUntil(name: string, until: Date) {
			sleeps.push(name);
			await onSleepUntil(name, until);
		},
	};
	let onSleepUntil: (name: string, until: Date) => Promise<void> | void = () => {};
	return {
		step: step as unknown as WorkflowStep,
		names,
		sleeps,
		whenSleepingUntil(fn: (name: string, until: Date) => Promise<void> | void) {
			onSleepUntil = fn;
		},
	};
}

const runInline = (names: string[]) => async (name: string, fn: (attempt: number) => Promise<import('../src/workflows/announce').BatchOutcome>) => {
	names.push(name);
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn(attempt);
		} catch (err) {
			if (attempt >= 4) throw err;
		}
	}
};

// ─── runBatch ────────────────────────────────────────────────────────────────

describe('runBatch', () => {
	it('skips targets that already have a delivery row and records the rest', async () => {
		const { deps, records } = memoryDeps(ids(5), async (t) =>
			t.id === 4 ? { ok: false, gone: true, detail: '410' } : t.id === 5 ? { ok: false, detail: 'bad request' } : { ok: true, detail: 'sent' },
		);
		records.set(1, { ok: true, detail: 'earlier run' });
		const outcome = await runBatch(deps, 0, { retryInStep: true, finalAttempt: false });
		expect(outcome).toMatchObject({ lastId: 5, more: false, listed: 5, skipped: 1, sent: 2, failed: 2, gone: 1, deferred: 0 });
		expect(outcome.quotaHit).toBeUndefined();
		expect(deps.deliver).toHaveBeenCalledTimes(4);
		expect(records.get(4)?.detail).toBe('gone: 410');
		expect(records.get(5)?.detail).toBe('failed: bad request');
	});

	it('throws on transient failures so the step retries only those', async () => {
		let flaky = true;
		const { deps, records } = memoryDeps(ids(3), async (t) => {
			if (t.id === 2 && flaky) {
				flaky = false;
				return { ok: false, retryable: true, detail: 'E_RATE_LIMIT_EXCEEDED' };
			}
			return { ok: true };
		});
		await expect(runBatch(deps, 0, { retryInStep: true, finalAttempt: false })).rejects.toBeInstanceOf(RetryableBatchError);
		expect([...records.keys()]).toEqual([1, 3]);

		const retry = await runBatch(deps, 0, { retryInStep: true, finalAttempt: false });
		expect(retry).toMatchObject({ skipped: 2, sent: 1 });
		expect(deps.deliver).toHaveBeenCalledTimes(4); // 3 + just the one retry
	});

	it('records transient failures on the final attempt instead of throwing', async () => {
		const { deps, records } = memoryDeps(ids(2), async () => ({ ok: false, retryable: true, detail: 'E_INTERNAL_SERVER_ERROR' }));
		const outcome = await runBatch(deps, 0, { retryInStep: true, finalAttempt: true });
		expect(outcome).toMatchObject({ failed: 2, deferred: 2 });
		expect(records.get(1)?.detail).toBe('retryable: E_INTERNAL_SERVER_ERROR');
	});

	it('records transient failures straight away for channels that do not retry in-step', async () => {
		const { deps } = memoryDeps(ids(1), async () => ({ ok: false, retryable: true }));
		await expect(runBatch(deps, 0, { retryInStep: false, finalAttempt: false })).resolves.toMatchObject({ deferred: 1 });
	});

	it('treats a throwing deliver function as transient', async () => {
		const { deps } = memoryDeps(ids(1), async () => {
			throw new Error('boom');
		});
		await expect(runBatch(deps, 0, { retryInStep: true, finalAttempt: false })).rejects.toBeInstanceOf(RetryableBatchError);
	});

	it('reports an empty batch', async () => {
		const { deps } = memoryDeps([], async () => ({ ok: true }));
		expect(await runBatch(deps, 0, { retryInStep: true, finalAttempt: false })).toMatchObject({ lastId: null, listed: 0 });
	});

	it('peeks one past the batch to know whether more follow', async () => {
		const { deps } = memoryDeps(ids(BATCH_SIZE + 1), async () => ({ ok: true }));
		expect(await runBatch(deps, 0, { retryInStep: true, finalAttempt: false })).toMatchObject({ lastId: BATCH_SIZE, more: true, sent: BATCH_SIZE });
		expect(await runBatch(deps, BATCH_SIZE, { retryInStep: true, finalAttempt: false })).toMatchObject({ more: false, sent: 1 });
	});

	it('walks past pages that are already done, so a re-run reaches recipients beyond the first pages', async () => {
		const { deps, records } = memoryDeps(ids(100), async () => ({ ok: true }));
		for (let id = 1; id <= 60; id++) records.set(id, { ok: true, detail: 'earlier run' });
		const outcome = await runBatch(deps, 0, { retryInStep: true, finalAttempt: false, batchSize: 10 });
		expect(outcome).toMatchObject({ skipped: 60, sent: 10, lastId: 70, more: true });
	});

	it('stops at a quota hit without recording the unsent, and never throws for it', async () => {
		let left = 3;
		const { deps, records } = memoryDeps(ids(10), async () =>
			left-- > 0 ? { ok: true } : { ok: false, retryable: true, quota: true, detail: 'daily_quota_exceeded' },
		);
		const outcome = await runBatch(deps, 0, { retryInStep: true, finalAttempt: false, stopOnQuota: true, concurrency: 1 });
		expect(outcome).toMatchObject({ quotaHit: true, sent: 3, deferred: 0 });
		expect([...records.keys()]).toEqual([1, 2, 3]);
		expect(deps.deliver).toHaveBeenCalledTimes(4);
	});
});

// ─── fanOut ──────────────────────────────────────────────────────────────────

describe('fanOut', () => {
	it('walks the id cursor in batches of 25 with unique step names', async () => {
		const targets = [...ids(30, 1), ...ids(30, 101)]; // gaps in ids are fine
		const { deps } = memoryDeps(targets, async () => ({ ok: true }));
		const names: string[] = [];
		const totals = await fanOut('email', runInline(names), deps, { retryInStep: true });
		expect(names).toEqual(['email after 0', 'email after 25', 'email after 120']);
		expect(totals).toMatchObject({ batches: 3, listed: 60, sent: 60, failed: 0, truncated: false });
	});

	it('stops after the last full batch when the count is an exact multiple', async () => {
		const { deps } = memoryDeps(ids(2 * BATCH_SIZE), async () => ({ ok: true }));
		const names: string[] = [];
		const totals = await fanOut('push', runInline(names), deps, { retryInStep: false });
		expect(names).toEqual(['push after 0', 'push after 25']);
		expect(totals.sent).toBe(50);
	});

	it('repeats a quota-hit batch from the same cursor after the wait, under a new step name', async () => {
		let quota = 30;
		const { deps, records } = memoryDeps(ids(60), async () =>
			quota-- > 0 ? { ok: true } : { ok: false, retryable: true, quota: true, detail: 'daily_quota_exceeded' },
		);
		const names: string[] = [];
		const waits: number[] = [];
		const totals = await fanOut('email', runInline(names), deps, {
			retryInStep: true,
			onQuota: async ({ wait }) => {
				waits.push(wait);
				quota = 90; // midnight
				return null;
			},
		});
		expect(waits).toEqual([1]);
		expect(names).toEqual(['email after 0', 'email after 25', 'email after 25 #2', 'email after 50']);
		expect(totals).toMatchObject({ sent: 60, deferred: 0, quotaWaits: 1 });
		expect([...records.values()].every((r) => r.ok)).toBe(true);
	});

	it('stops the channel when the quota handler says so', async () => {
		const { deps, records } = memoryDeps(ids(10), async () => ({ ok: false, retryable: true, quota: true }));
		const totals = await fanOut('email', runInline([]), deps, { retryInStep: true, onQuota: async () => 'quota reserve reached' });
		expect(totals).toMatchObject({ stopped: 'quota reserve reached', sent: 0 });
		expect(records.size).toBe(0);
	});

	it('gives up waiting after the cap, recording the rest as retryable', async () => {
		const { deps, records } = memoryDeps(ids(2), async () => ({ ok: false, retryable: true, quota: true, detail: 'daily_quota_exceeded' }));
		const onQuota = vi.fn(async () => null);
		const totals = await fanOut('email', runInline([]), deps, { retryInStep: true, onQuota, maxQuotaWaits: 2 });
		expect(onQuota).toHaveBeenCalledTimes(2);
		expect(totals.deferred).toBe(2);
		expect(records.get(1)?.detail).toBe('retryable: daily_quota_exceeded');
	});

	it('is idempotent: a second run contacts nobody', async () => {
		const { deps } = memoryDeps(ids(40), async () => ({ ok: true }));
		await fanOut('email', runInline([]), deps, { retryInStep: true });
		const again = await fanOut('email', runInline([]), deps, { retryInStep: true });
		expect(again).toMatchObject({ sent: 0, skipped: 40 });
		expect(deps.deliver).toHaveBeenCalledTimes(40);
	});

	it('marks a run truncated at the batch cap', async () => {
		const { deps } = memoryDeps(ids(10), async () => ({ ok: true }));
		const totals = await fanOut('email', runInline([]), deps, { retryInStep: true, batchSize: 2, maxBatches: 3 });
		expect(totals).toMatchObject({ batches: 3, sent: 6, truncated: true });
	});

	it('survives a flaky batch via step retries without double-sending', async () => {
		const failures = new Map<number, number>([[3, 2]]); // id 3 fails twice, then works
		const { deps } = memoryDeps(ids(5), async (t) => {
			const left = failures.get(t.id) ?? 0;
			if (left > 0) {
				failures.set(t.id, left - 1);
				return { ok: false, retryable: true };
			}
			return { ok: true };
		});
		const totals = await fanOut('email', runInline([]), deps, { retryInStep: true });
		expect(deps.deliver).toHaveBeenCalledTimes(7); // 5, then id 3 twice more
		expect(totals.failed).toBe(0);
	});
});

describe('small pure helpers', () => {
	it('judges supersession', () => {
		expect(judgeSupersession('yes', 'yes', 'soon')).toBeNull();
		expect(judgeSupersession('soon', 'yes', null)).toBe('changed');
		expect(judgeSupersession('no', 'no', null)).toBe('reverted'); // soon → no inside the undo window
		expect(judgeSupersession('no', 'no', 'soon')).toBeNull(); // a real false alarm
		expect(judgeSupersession('soon', 'soon', 'no')).toBeNull();
	});

	it('maps delivery results', () => {
		expect(toAttempt({ ok: true, detail: 'x' })).toEqual({ ok: true, detail: 'x' });
		expect(toAttempt({ ok: false, gone: true })).toMatchObject({ gone: true });
		expect(toAttempt({ ok: false })).toMatchObject({ retryable: true });
		expect(toAttempt({ ok: false, transient: false })).toMatchObject({ retryable: false });
		expect(toAttempt({ ok: false, transient: true, code: 'daily_quota_exceeded' })).toMatchObject({ quota: true });
		expect(toAttempt({ ok: false, transient: true, code: 'quota_reserve' })).toMatchObject({ quota: true });
		expect(toAttempt({ ok: false, transient: true, code: 'rate_limit_exceeded' }).quota).toBeUndefined();
	});

	it('judges staleness after a quota wait', () => {
		const at = '2026-11-10T09:00:00.000Z';
		expect(staleReason({ kind: 'status', status: 'soon', createdAt: at }, 'soon', new Date('2026-11-11T00:00:01Z'))).toBeNull();
		expect(staleReason({ kind: 'status', status: 'soon', createdAt: at }, 'yes', new Date('2026-11-11T00:00:01Z'))).toMatch(/superseded/);
		expect(staleReason({ kind: 'daily', status: 'no', createdAt: at }, 'no', new Date('2026-11-10T20:00:00Z'))).toBeNull();
		expect(staleReason({ kind: 'daily', status: 'no', createdAt: at }, 'no', new Date('2026-11-11T00:00:01Z'))).toMatch(/day is over/);
	});

	it('never lets the last attempt throw', () => {
		expect(isFinalAttempt(1)).toBe(false);
		expect(isFinalAttempt(3)).toBe(true);
		expect(isFinalAttempt(4)).toBe(true);
	});
});

// ─── announce(), the whole flow ──────────────────────────────────────────────

const env = {
	DB: {
		prepare: () => ({
			bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }),
		}),
	},
} as unknown as Env;

function makeUpdate(extra: Partial<Update>): Update {
	return {
		id: 1,
		kind: 'status',
		title: 'Zack is a dad!',
		body: '',
		status: 'yes',
		audience: 'all',
		createdAt: '2026-11-10T14:00:00.000Z',
		notifiedAt: null,
		...extra,
	};
}

function subscribers(n: number): SubscriberRow[] {
	return Array.from({ length: n }, (_, i) => ({
		id: i + 1,
		email: `person${i + 1}@example.com`,
		frequency: 'big',
		token: `token-${i + 1}-xxxxxxxxxxxxxxxx`,
		created_at: '2026-11-01T00:00:00.000Z',
		confirm_sent_at: null,
		confirmed_at: '2026-11-01T00:00:00.000Z',
		unsubscribed_at: null,
	}));
}

describe('announce', () => {
	const yesState: SiteState = { status: 'yes', statusChangedAt: '2026-11-10T14:00:00.000Z', dueDate: null };

	beforeEach(() => {
		vi.clearAllMocks();
		h.deliveries.clear();
		const subs = subscribers(30);
		h.listEmailTargets.mockImplementation(async (_e: unknown, _a: unknown, after: number, limit: number) =>
			subs.filter((s) => s.id > after).slice(0, limit),
		);
		h.deliverEmail.mockResolvedValue({ ok: true, detail: 'sent' });
		h.listPushTargets.mockImplementation(async (_e: unknown, after: number) =>
			after === 0 ? [{ id: 1, endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a', failures: 0 }] : [],
		);
		h.getState.mockResolvedValue(yesState);
	});

	it('announces a YES: grace period, every channel, DNS, OG, notified', async () => {
		h.getUpdate.mockResolvedValue(makeUpdate({}));
		const { step, names, sleeps } = fakeStep();
		const summary = await announce(env, 1, 'update-1', step);

		expect(sleeps).toEqual(['grace period']);
		expect(names).toEqual([
			'load update',
			're-check status after grace period',
			'push after 0',
			'webhooks after 0',
			'update DNS answer record',
			'render OG image',
			'email after 0',
			'email after 25',
			'mark notified',
			'summarise deliveries',
		]);
		expect(new Set(names).size).toBe(names.length);
		expect(h.deliverEmail).toHaveBeenCalledTimes(30);
		expect(h.deliverPush).toHaveBeenCalledTimes(1);
		expect(h.updateAnswerRecord).toHaveBeenCalledTimes(1);
		expect(h.markNotified).toHaveBeenCalledWith(env, 1);
		expect(summary.email).toMatchObject({ sent: 30 });
		expect(summary.deliveries).toEqual(
			expect.arrayContaining([
				{ channel: 'email', ok: 30, failed: 0 },
				{ channel: 'dns', ok: 1, failed: 0 },
			]),
		);
		// The summary must survive structured cloning (Workflows persists it).
		expect(structuredClone(summary)).toEqual(summary);
	});

	it('re-running contacts nobody twice', async () => {
		h.getUpdate.mockResolvedValue(makeUpdate({}));
		await announce(env, 1, 'update-1', fakeStep().step);
		const again = await announce(env, 1, 'update-1-r1', fakeStep().step);
		expect(h.deliverEmail).toHaveBeenCalledTimes(30);
		expect(again.email).toMatchObject({ sent: 0, skipped: 30 });
	});

	it('stays quiet when the status changed during the grace period', async () => {
		h.getUpdate.mockResolvedValue(makeUpdate({ status: 'soon', title: "It's happening." }));
		const { step, names } = fakeStep();
		const summary = await announce(env, 1, 'update-1', step);
		expect(summary).toMatchObject({ superseded: true, reason: 'changed', currentStatus: 'yes' });
		expect(names).not.toContain('email after 0');
		expect(h.deliverEmail).not.toHaveBeenCalled();
		expect(h.markNotified).not.toHaveBeenCalled();
		expect(h.deliveries.size).toBe(0);
		expect(h.setSetting).toHaveBeenCalledWith(env, 'superseded:1', 'changed');
		// A newer update will write DNS; this one leaves it alone.
		expect(h.updateAnswerRecord).not.toHaveBeenCalled();
	});

	it('re-syncs DNS when an update is reverted inside the undo window', async () => {
		const noState: SiteState = { status: 'no', statusChangedAt: '2026-11-10T14:00:30.000Z', dueDate: null };
		h.getState.mockResolvedValue(noState);
		h.getUpdate.mockResolvedValue(makeUpdate({ status: 'no', title: 'Update: Zack is not a dad.' }));
		const summary = await announce(env, 1, 'update-1', fakeStep().step);
		expect(summary).toMatchObject({ superseded: true, reason: 'reverted' });
		expect(h.setSetting).toHaveBeenCalledWith(env, 'superseded:1', 'reverted');
		expect(h.updateAnswerRecord).toHaveBeenCalledWith(env, noState);
		expect(h.deliverEmail).not.toHaveBeenCalled();
		expect(h.markNotified).not.toHaveBeenCalled();
	});

	it('sends push, webhooks and DNS before email waits for the quota, then finishes email after midnight', async () => {
		h.getUpdate.mockResolvedValue(makeUpdate({}));
		let quota = 10;
		h.deliverEmail.mockImplementation(async () =>
			quota-- > 0 ? { ok: true, detail: 'sent' } : { ok: false, transient: true, code: 'daily_quota_exceeded', detail: 'daily_quota_exceeded' },
		);
		const { step, names, sleeps, whenSleepingUntil } = fakeStep();
		whenSleepingUntil(() => {
			// By the time the sleep starts, every other channel has already gone out.
			expect(h.deliverPush).toHaveBeenCalled();
			expect(h.updateAnswerRecord).toHaveBeenCalled();
			quota = 90;
		});
		const summary = await announce(env, 1, 'update-1', step);
		expect(sleeps).toEqual(['grace period', 'wait for email quota reset #1']);
		expect(names).toContain('re-check after quota reset #1');
		expect(summary.email).toMatchObject({ sent: 30, deferred: 0, quotaWaits: 1 });
		expect([...h.deliveries.entries()].filter(([k]) => k.includes(':email:')).every(([, v]) => v.ok)).toBe(true);
		expect(h.markNotified).toHaveBeenCalled();
	});

	it('stops emailing when the answer moved on while waiting for the quota', async () => {
		h.getUpdate.mockResolvedValue(makeUpdate({ status: 'soon', title: "It's happening." }));
		h.getState.mockResolvedValue({ ...yesState, status: 'soon' });
		let quota = 5;
		h.deliverEmail.mockImplementation(async () =>
			quota-- > 0 ? { ok: true } : { ok: false, transient: true, code: 'daily_quota_exceeded' },
		);
		const { step, whenSleepingUntil } = fakeStep();
		whenSleepingUntil(() => {
			h.getState.mockResolvedValue(yesState);
			quota = 90;
		});
		const summary = await announce(env, 1, 'update-1', step);
		expect(summary.email).toMatchObject({ sent: 5, stopped: expect.stringMatching(/superseded/) });
		// Only the in-flight sends of the quota-hit batch; nobody after the wait.
		expect(h.deliverEmail.mock.calls.length).toBeLessThanOrEqual(10);
	});

	it('daily posts stop at the reserve instead of sleeping into tomorrow', async () => {
		h.getUpdate.mockResolvedValue(makeUpdate({ kind: 'daily', title: 'Day 40: still no.', status: 'no', audience: 'daily' }));
		h.getState.mockResolvedValue({ ...yesState, status: 'no' });
		let quota = 3;
		h.deliverEmail.mockImplementation(async (_env: unknown, _sub: unknown, _update: unknown, opts: { reserve?: number }) => {
			expect(opts.reserve).toBe(10);
			return quota-- > 0 ? { ok: true } : { ok: false, transient: true, code: 'quota_reserve' };
		});
		const { step, sleeps } = fakeStep();
		const summary = await announce(env, 1, 'update-1', step);
		expect(sleeps).toEqual([]);
		expect(summary.email).toMatchObject({ sent: 3, stopped: expect.stringMatching(/reserve/) });
	});

	it('daily updates: no grace period, no push, no DNS', async () => {
		h.getUpdate.mockResolvedValue(makeUpdate({ kind: 'daily', title: 'Dad day 1: still yes.', audience: 'daily' }));
		const { step, names, sleeps } = fakeStep();
		const summary = await announce(env, 1, 'update-1', step);
		expect(sleeps).toEqual([]);
		expect(h.listEmailTargets.mock.calls[0]?.[1]).toBe('daily');
		expect(h.listWebhookTargets.mock.calls[0]?.[1]).toBe('daily');
		expect(h.deliverPush).not.toHaveBeenCalled();
		expect(h.updateAnswerRecord).not.toHaveBeenCalled();
		expect(names).toContain('render OG image');
		expect(summary.push).toEqual({ skipped: "audience is 'daily'" });
	});

	it('keeps going when one channel fails outright', async () => {
		h.getUpdate.mockResolvedValue(makeUpdate({}));
		h.listPushTargets.mockRejectedValue(new Error('push table on fire'));
		const summary = await announce(env, 1, 'update-1', fakeStep().step);
		expect(summary.push).toEqual({ error: 'push table on fire' });
		expect(h.updateAnswerRecord).toHaveBeenCalled();
		expect(h.markNotified).toHaveBeenCalled();
	});

	it('skips missing updates and audience none', async () => {
		h.getUpdate.mockResolvedValueOnce(null);
		expect(await announce(env, 9, 'update-9', fakeStep().step)).toEqual({ updateId: 9, skipped: 'update not found' });
		h.getUpdate.mockResolvedValueOnce(makeUpdate({ audience: 'none' }));
		expect(await announce(env, 1, 'update-1', fakeStep().step)).toMatchObject({ skipped: "audience is 'none'" });
	});
});
