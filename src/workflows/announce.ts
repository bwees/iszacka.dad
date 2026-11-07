// OWNER: notify agent.
// Durable fan-out of one update to browsers, the ledger, DNS, push, webhooks and email.
//
// Every step has to fit the Workers Free budget of 10 ms CPU (and 50 external subrequests),
// so the work is cut into small steps, each with its own budget and retries:
//
// 1. Load the update.
// 2. First run only (params.publish, set by whoever created the update): broadcast the fresh
//    state (status updates) and the update to every open browser, and sign a status change
//    into the Dad Ledger. One step each. Status updates then write the DNS TXT answer record
//    from fresh state. All of this used to happen inside the admin's request.
// 3. Status updates: sleep through a 60s grace period, then re-check. If the status has
//    changed again (or was flipped back to what the world was last told), skip notifying and
//    record why (settings `superseded:<id>`, for /updates/:id).
// 4. Push, then webhooks, PUSH_BATCH_SIZE / WEBHOOK_BATCH_SIZE targets per step by id cursor.
//    Each batch skips recipients that already have a delivery row and records every outcome
//    in one D1 batch, so step retries and admin re-runs never contact anyone twice.
// 5. Email, last, because it is the only channel with a quota, EMAIL_BATCH_SIZE per step with
//    one request to Resend's batch endpoint. When the day's quota runs out mid-batch, real
//    news (audience 'all') sleeps until 00:00 UTC and carries on from the same cursor (after
//    checking the update isn't stale by then); anything else stops at DAILY_EMAIL_RESERVE and
//    is dropped, not sent tomorrow. Email waiting on the quota never delays push or webhooks.
// 6. Mark the update notified, and return a serialisable summary.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { type DeliverySummary, deliveredTargets, deliverySummary, recordDeliveries, recordDelivery } from '../lib/deliveries';
import { appendLedger } from '../lib/ledger';
import { waitingRoom } from '../lib/live';
import { STATUS_COPY } from '../lib/site';
import { getState, setSetting } from '../lib/state';
import { londonDate } from '../lib/time';
import { getUpdate, markNotified, type PublishParams } from '../lib/updates';
import { updateAnswerRecord } from '../notify/dns';
import { DAILY_EMAIL_RESERVE, deliverEmailBatch, isQuotaCode, listEmailTargets } from '../notify/email';
import { deliverPushBatch, listPushTargets } from '../notify/push';
import { deliverWebhookBatch, listWebhookTargets } from '../notify/webhooks';
import type { Audience, Channel, DeliveryResult, SiteState, Status, Update, UpdateKind } from '../types';

export interface AnnounceParams extends PublishParams {
	updateId: number;
}

/** Default targets per step (the email channel's size: one Resend request per step). */
export const BATCH_SIZE = 20;
/** Emails per step: rendering and one batch request to Resend, well inside 10 ms. */
export const EMAIL_BATCH_SIZE = BATCH_SIZE;
/** Pushes per step: up to two fetches each (one retry), so at most 20 subrequests. */
export const PUSH_BATCH_SIZE = 10;
/** Webhooks per step: one fetch each. */
export const WEBHOOK_BATCH_SIZE = 10;
/**
 * Batches per channel. Three channels × 300 stays under the 1,024 steps a Workflow instance
 * may take, and 300 × 10 = 3,000 push subscriptions or webhooks per run.
 */
export const MAX_BATCHES = 300;
/**
 * Pages of already-delivered targets one step may walk past before it finds work, so a re-run
 * reaches recipients beyond the first pages without spending a step per skipped batch. Each
 * page costs two D1 queries, so this stays small enough for one step's CPU budget.
 */
export const MAX_SKIP_PAGES = 10;
/** Midnight quota waits per run, so a refusal that never clears can't loop for days. */
export const MAX_QUOTA_WAITS = 3;
export const RETRY_LIMIT = 3;
export const STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: RETRY_LIMIT, delay: '10 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
};
/** The live flip: retried quickly, since browsers are waiting on it. */
export const LIVE_STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: RETRY_LIMIT, delay: '2 seconds', backoff: 'exponential' },
	timeout: '1 minute',
};
export const GRACE_PERIOD = '60 seconds';
/** For channels delivered one target at a time (see perTarget). */
const CONCURRENCY = 5;

/**
 * Whether this is the last attempt we'll let a step make. Attempts are documented as
 * 1-indexed; treating attempt RETRY_LIMIT as final also stays safe if a runtime counts from 0,
 * because the step then never throws on its last try.
 */
export function isFinalAttempt(attempt: number): boolean {
	return attempt >= RETRY_LIMIT;
}

// ─── Batching (pure, injectable, unit-tested) ────────────────────────────────

/** One delivery outcome, normalised across channels. */
export interface Attempt {
	ok: boolean;
	/** The target is permanently gone (and has been disabled by its channel). */
	gone?: boolean;
	/** Worth trying again later (rate limit, outage, timeout). */
	retryable?: boolean;
	/** Out of today's email quota: nothing wrong with the recipient, just try after the reset. */
	quota?: boolean;
	detail?: string;
}

export interface BatchOutcome {
	/** Highest target id listed in this batch (the next cursor), or null if the batch was empty. */
	lastId: number | null;
	/** More targets exist after lastId. */
	more?: boolean;
	/** The quota ran out: the batch stopped early, and the unsent are not recorded. */
	quotaHit?: boolean;
	/** ISO time the batch ran (memoised by the step, so replays agree on it). */
	at?: string;
	listed: number;
	/** Already had a delivery row, from an earlier attempt or run. */
	skipped: number;
	sent: number;
	failed: number;
	gone: number;
	/** Retryable failures recorded as such (a later re-run tries them again). */
	deferred: number;
}

/** One delivery row to write. */
export interface DeliveryRecord {
	id: number;
	ok: boolean;
	detail: string;
}

export interface BatchDeps<T extends { id: number }> {
	list(afterId: number, limit: number): Promise<T[]>;
	/** Of these ids, which must not be contacted again for this update. */
	done(ids: number[]): Promise<Set<number>>;
	/** Deliver to every target of the batch: one Attempt per target, in the same order. */
	deliver(targets: T[]): Promise<Attempt[]>;
	/** Write the batch's outcomes, all at once. */
	record(entries: DeliveryRecord[]): Promise<void>;
}

export interface BatchOptions {
	batchSize?: number;
	/** Throw on retryable failures (so the step retries just those) until the final attempt. */
	retryInStep: boolean;
	finalAttempt: boolean;
	/** On a quota attempt, stop the batch and leave the rest unrecorded (else: an ordinary retryable failure). */
	stopOnQuota?: boolean;
	maxSkipPages?: number;
}

/** Thrown inside a step to make the Workflows engine retry it with backoff. */
export class RetryableBatchError extends Error {
	override name = 'RetryableBatchError';
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a one-target delivery function into a batch one, with at most `limit` in flight. A
 * throwing delivery counts as a transient failure.
 */
export function perTarget<T>(fn: (target: T) => Promise<Attempt>, limit = CONCURRENCY): (targets: T[]) => Promise<Attempt[]> {
	return async (targets) => {
		const out: Attempt[] = new Array(targets.length);
		let next = 0;
		const worker = async () => {
			while (next < targets.length) {
				const i = next++;
				try {
					out[i] = await fn(targets[i] as T);
				} catch (err) {
					out[i] = { ok: false, retryable: true, detail: errorMessage(err) };
				}
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, targets.length)) }, worker));
		return out;
	};
}

/**
 * Deliver one batch: list targets after the cursor (one extra, to know whether more follow),
 * walk past pages where everyone is already done, deliver the rest in one go and record every
 * outcome in one write. If retryable failures remain and attempts are left, throw so the step
 * is retried; the retry skips everyone already recorded. If the email quota runs out (and
 * `stopOnQuota`), the unsent are left unrecorded and the outcome reports `quotaHit`.
 */
export async function runBatch<T extends { id: number }>(
	deps: BatchDeps<T>,
	afterId: number,
	opts: BatchOptions,
): Promise<BatchOutcome> {
	const batchSize = opts.batchSize ?? BATCH_SIZE;
	const maxSkipPages = opts.maxSkipPages ?? MAX_SKIP_PAGES;
	const outcome: BatchOutcome = {
		lastId: null,
		more: false,
		at: new Date().toISOString(),
		listed: 0,
		skipped: 0,
		sent: 0,
		failed: 0,
		gone: 0,
		deferred: 0,
	};
	let cursor = afterId;
	let pending: T[] = [];
	for (let page = 0; ; page++) {
		const rows = await deps.list(cursor, batchSize + 1);
		const targets = rows.slice(0, batchSize);
		outcome.more = rows.length > batchSize;
		if (targets.length === 0) return outcome;
		outcome.lastId = Math.max(...targets.map((t) => t.id));
		outcome.listed += targets.length;
		const done = await deps.done(targets.map((t) => t.id));
		pending = targets.filter((t) => !done.has(t.id));
		outcome.skipped += targets.length - pending.length;
		if (pending.length > 0 || !outcome.more || page + 1 >= maxSkipPages) break;
		cursor = outcome.lastId;
	}
	if (pending.length === 0) return outcome;

	let attempts: Attempt[];
	try {
		attempts = await deps.deliver(pending);
	} catch (err) {
		// Delivery functions shouldn't throw, but if one does, treat the batch as transient.
		attempts = pending.map(() => ({ ok: false, retryable: true, detail: errorMessage(err) }));
	}
	const attemptOf = (i: number): Attempt => attempts[i] ?? { ok: false, retryable: true, detail: 'no delivery result' };
	// Not attempted for lack of quota: no record, so the same batch repeated after the reset sends it.
	const quotaHit = opts.stopOnQuota === true && pending.some((_, i) => attemptOf(i).quota === true);

	const records: DeliveryRecord[] = [];
	let toRetry = 0;
	pending.forEach((target, i) => {
		const attempt = attemptOf(i);
		const detail = (attempt.detail ?? '').slice(0, 400);
		if (attempt.ok) {
			records.push({ id: target.id, ok: true, detail: detail || 'ok' });
			outcome.sent++;
		} else if (attempt.gone) {
			records.push({ id: target.id, ok: false, detail: `gone: ${detail}` });
			outcome.failed++;
			outcome.gone++;
		} else if (attempt.retryable || attempt.quota) {
			// Transient failures alongside a quota hit are left unrecorded too: the repeat gets them.
			if (quotaHit) return;
			if (opts.retryInStep && !opts.finalAttempt) {
				toRetry++;
				return;
			}
			records.push({ id: target.id, ok: false, detail: `retryable: ${detail}` });
			outcome.failed++;
			outcome.deferred++;
		} else {
			records.push({ id: target.id, ok: false, detail: `failed: ${detail}` });
			outcome.failed++;
		}
	});
	if (records.length) await deps.record(records);

	if (quotaHit) {
		outcome.quotaHit = true;
		return outcome;
	}
	if (toRetry > 0) throw new RetryableBatchError(`${toRetry} of ${pending.length} deliveries hit transient errors; retrying`);
	return outcome;
}

export interface ChannelTotals {
	batches: number;
	listed: number;
	skipped: number;
	sent: number;
	failed: number;
	gone: number;
	deferred: number;
	/** Hit MAX_BATCHES; a re-run picks up the rest (it walks past the done ones cheaply). */
	truncated: boolean;
	/** Why the channel stopped early, if it did (quota reserve, superseded, too many quota waits). */
	stopped?: string;
	/** Midnight waits for the email quota. */
	quotaWaits?: number;
}

export type RunStep = (name: string, fn: (attempt: number) => Promise<BatchOutcome>) => Promise<BatchOutcome>;

/** The next UTC midnight strictly after `now` (when Resend's daily quota resets). */
export function nextUtcMidnight(now: Date = new Date()): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * What to do when a batch runs out of quota: null to repeat the batch (after sleeping until
 * the reset), or a reason to stop the channel. `wait` counts quota hits in this run, from 1.
 */
export type QuotaHandler = (hit: { wait: number; at: string }) => Promise<string | null>;

export interface FanOutOptions {
	retryInStep: boolean;
	batchSize?: number;
	maxBatches?: number;
	/** Without one, quota attempts are ordinary retryable failures. */
	onQuota?: QuotaHandler;
	maxQuotaWaits?: number;
}

/** Walk a channel's targets by id cursor, one step per batch ("email after 0", "email after 20"...). */
export async function fanOut<T extends { id: number }>(label: string, runStep: RunStep, deps: BatchDeps<T>, opts: FanOutOptions): Promise<ChannelTotals> {
	const batchSize = opts.batchSize ?? BATCH_SIZE;
	const maxBatches = opts.maxBatches ?? MAX_BATCHES;
	const maxQuotaWaits = opts.maxQuotaWaits ?? MAX_QUOTA_WAITS;
	const totals: ChannelTotals = { batches: 0, listed: 0, skipped: 0, sent: 0, failed: 0, gone: 0, deferred: 0, truncated: false };
	let cursor = 0;
	let repeats = 0;
	let quotaWaits = 0;
	for (let i = 0; i < maxBatches; i++) {
		const after = cursor;
		// A batch repeated after a quota wait needs its own (deterministic) step name.
		const name = repeats ? `${label} after ${after} #${repeats + 1}` : `${label} after ${after}`;
		const stopOnQuota = opts.onQuota !== undefined && quotaWaits <= maxQuotaWaits;
		const outcome = await runStep(name, (attempt) =>
			runBatch(deps, after, { batchSize, retryInStep: opts.retryInStep, finalAttempt: isFinalAttempt(attempt), stopOnQuota }),
		);
		totals.batches++;
		totals.listed += outcome.listed;
		totals.skipped += outcome.skipped;
		totals.sent += outcome.sent;
		totals.failed += outcome.failed;
		totals.gone += outcome.gone;
		totals.deferred += outcome.deferred;
		if (outcome.quotaHit && opts.onQuota) {
			quotaWaits++;
			totals.quotaWaits = quotaWaits;
			if (quotaWaits > maxQuotaWaits) {
				// The next repeat records the rest as retryable failures instead of waiting again.
				repeats++;
				continue;
			}
			const stop = await opts.onQuota({ wait: quotaWaits, at: outcome.at ?? new Date().toISOString() });
			if (stop) {
				totals.stopped = stop;
				return totals;
			}
			repeats++;
			continue;
		}
		if (outcome.lastId === null || !outcome.more) return totals;
		cursor = outcome.lastId;
		repeats = 0;
	}
	totals.truncated = true;
	return totals;
}

/** Map a channel's DeliveryResult: failures that aren't "gone" are worth retrying later. */
export function toAttempt(result: DeliveryResult & { transient?: boolean; code?: string }): Attempt {
	if (result.ok) return { ok: true, detail: result.detail };
	if (result.gone) return { ok: false, gone: true, detail: result.detail };
	const attempt: Attempt = { ok: false, retryable: result.transient ?? true, detail: result.detail };
	if (isQuotaCode(result.code)) attempt.quota = true;
	return attempt;
}

/**
 * Whether an update has gone stale by `now` (after a quota wait): a status update once the
 * answer has moved on (a newer update announces that), a daily post once the answer has moved
 * on or its Europe/London day is over. Null if it's still worth sending.
 */
export function staleReason(update: Pick<Update, 'kind' | 'status' | 'createdAt'>, current: Status, now: Date): string | null {
	if (current !== update.status) return `superseded: the answer is now '${current}'`;
	if (update.kind === 'daily') {
		const created = Date.parse(update.createdAt);
		if (!Number.isNaN(created) && londonDate(now) !== londonDate(new Date(created))) return "stale: the daily post's day is over";
	}
	return null;
}

// ─── Supersession (the undo window) ──────────────────────────────────────────

export type SupersededReason = 'changed' | 'reverted';

/**
 * After the grace period: 'changed' if the status has moved on since this update (a newer
 * update will announce it); 'reverted' if this update merely restores what the world was last
 * told (e.g. soon → no within a minute: nobody heard about "soon", so "no" is not news).
 */
export function judgeSupersession(updateStatus: Status, currentStatus: Status, lastAnnounced: Status | null): SupersededReason | null {
	if (currentStatus !== updateStatus) return 'changed';
	if ((lastAnnounced ?? 'no') === updateStatus) return 'reverted';
	return null;
}

/**
 * Status of the most recent earlier status update that actually reached anyone. Only the
 * channels that reach people count: every status update writes DNS straight away.
 */
async function lastAnnouncedStatus(env: Env, beforeId: number): Promise<Status | null> {
	const row = await env.DB.prepare(
		`SELECT u.status FROM updates u
		 WHERE u.kind = 'status' AND u.id < ?
		   AND (u.notified_at IS NOT NULL OR EXISTS (
		     SELECT 1 FROM deliveries d WHERE d.update_id = u.id AND d.channel IN ('email', 'push', 'webhook')))
		 ORDER BY u.id DESC LIMIT 1`,
	)
		.bind(beforeId)
		.first<{ status: Status }>();
	return row?.status ?? null;
}

// ─── Publishing (the first steps) ────────────────────────────────────────────

export type LedgerReport = { seq: number } | { skipped: string };

/**
 * Sign a status change into the Dad Ledger, once. Skipped if a newer status change already
 * exists (its own run records it, and the ledger must stay in order) or if the ledger's newest
 * entry already says this status (a retry after a write that did land). Throws on failure, so
 * the step retries.
 */
export async function ledgerStatusChange(env: Env, update: Pick<Update, 'id' | 'status'>, note: string): Promise<LedgerReport> {
	const [head, newer] = await env.DB.batch<{ status?: Status; hit?: number }>([
		env.DB.prepare('SELECT status FROM ledger ORDER BY seq DESC LIMIT 1'),
		env.DB.prepare("SELECT 1 AS hit FROM updates WHERE kind = 'status' AND id > ? LIMIT 1").bind(update.id),
	]);
	if (newer?.results[0]) return { skipped: 'a newer status change has been made since' };
	if (head?.results[0]?.status === update.status) return { skipped: `the ledger already says '${update.status}'` };
	const entry = await appendLedger(env, { status: update.status, note });
	if (!entry) throw new RetryableBatchError('the ledger append failed');
	return { seq: entry.seq };
}

// ─── Idempotency helpers ─────────────────────────────────────────────────────

export interface SingleReport {
	ok: boolean;
	detail: string | null;
}

/** A one-off delivery (DNS) inside a step: retried via the step until the final attempt. */
async function singleDelivery(
	run: () => Promise<DeliveryResult>,
	record: (ok: boolean, detail: string) => Promise<void>,
	finalAttempt: boolean,
): Promise<SingleReport> {
	let result: DeliveryResult;
	try {
		result = await run();
	} catch (err) {
		result = { ok: false, detail: errorMessage(err) };
	}
	if (!result.ok && !result.gone && !finalAttempt) throw new RetryableBatchError(result.detail ?? 'delivery failed');
	const detail = (result.detail ?? (result.ok ? 'ok' : 'failed')).slice(0, 400);
	await record(result.ok, result.ok ? detail : `failed: ${detail}`);
	return { ok: result.ok, detail: result.detail ?? null };
}

// ─── The workflow ────────────────────────────────────────────────────────────

export type ChannelReport = ChannelTotals | { skipped: string } | { error: string };

export interface AnnounceSummary {
	updateId: number;
	kind?: UpdateKind;
	audience?: Audience;
	status?: Status;
	skipped?: string;
	superseded?: true;
	reason?: SupersededReason;
	currentStatus?: Status;
	live?: { state?: true | { error: string }; update?: true | { error: string } };
	ledger?: LedgerReport | { error: string };
	email?: ChannelReport;
	push?: ChannelReport;
	webhook?: ChannelReport;
	dns?: SingleReport | { skipped: string } | { error: string };
	deliveries?: DeliverySummary[];
}

/** A step (or channel) that fails after all retries is reported, not fatal: other channels still go out. */
async function isolate<T>(label: string, fn: () => Promise<T>): Promise<T | { error: string }> {
	try {
		return await fn();
	} catch (err) {
		console.error(`announce: ${label} failed after retries:`, errorMessage(err));
		return { error: errorMessage(err).slice(0, 300) };
	}
}

export async function announce(env: Env, updateId: number, instanceId: string, step: WorkflowStep, params: PublishParams = {}): Promise<AnnounceSummary> {
	const rerun = /-r\d+$/.test(instanceId);

	const update: Update | null = await step.do('load update', STEP_CONFIG, () => getUpdate(env, updateId));
	if (!update) return { updateId, skipped: 'update not found' };
	const base = { updateId, kind: update.kind, audience: update.audience, status: update.status };
	const summary: AnnounceSummary = { ...base };

	// Publishing: what the admin's request used to do inline, now one budgeted step each.
	if (params.publish) {
		const live: NonNullable<AnnounceSummary['live']> = {};
		if (update.kind === 'status') {
			// Fresh state, not this update's: if steps of two quick flips interleave, browsers still end on the truth.
			const sent = await isolate('live state', () =>
				step.do('broadcast state', LIVE_STEP_CONFIG, async () => {
					await waitingRoom(env).broadcast({ type: 'state', state: await getState(env, { fresh: true }) });
					return true as const;
				}),
			);
			live.state = sent;
		}
		live.update = await isolate('live update', () =>
			step.do('broadcast update', LIVE_STEP_CONFIG, async () => {
				await waitingRoom(env).broadcast({ type: 'update', update });
				return true as const;
			}),
		);
		summary.live = live;
		if (update.kind === 'status') {
			const note = params.ledgerNote ?? STATUS_COPY[update.status].ledgerNote;
			summary.ledger = await isolate('ledger', () =>
				step.do('append to ledger', STEP_CONFIG, () => ledgerStatusChange(env, update, note)),
			);
		}
	}

	// The DNS answer mirrors the site, which has already flipped: write it now, from fresh state
	// read inside the step (whichever run writes last writes the truth).
	if (update.kind === 'status') {
		summary.dns = await isolate('dns', () =>
			step.do('update DNS answer record', STEP_CONFIG, async (ctx) =>
				singleDelivery(
					async () => updateAnswerRecord(env, await getState(env, { fresh: true })),
					(ok, detail) => recordDelivery(env, update.id, 'dns', 0, ok, detail),
					isFinalAttempt(ctx.attempt),
				),
			),
		);
	} else {
		summary.dns = { skipped: 'only status updates touch DNS' };
	}

	if (update.audience === 'none') return { ...summary, skipped: "audience is 'none'" };

	let state: SiteState;
	if (update.kind === 'status') {
		await step.sleep('grace period', GRACE_PERIOD);
		const check = await step.do('re-check status after grace period', STEP_CONFIG, async () => {
			const current = await getState(env, { fresh: true });
			const reason = judgeSupersession(update.status, current.status, await lastAnnouncedStatus(env, update.id));
			return { reason, state: current };
		});
		if (check.reason) {
			console.log(`announce: update ${updateId} superseded (${check.reason}); not notifying`);
			// Remembered outside notified_at/deliveries (which lastAnnouncedStatus reads), so
			// /updates/:id can say "not announced" instead of "in progress" for ever.
			await isolate('record supersession', () =>
				step.do('record supersession', STEP_CONFIG, async () => {
					await setSetting(env, `superseded:${update.id}`, check.reason as string);
					return true;
				}),
			);
			return { ...summary, superseded: true, reason: check.reason, currentStatus: check.state.status };
		}
		state = check.state;
	} else {
		state = await step.do('load state', STEP_CONFIG, () => getState(env, { fresh: true }));
	}

	const runStep: RunStep = (name, fn) => step.do(name, STEP_CONFIG, (ctx) => fn(ctx.attempt));
	const record = (channel: Channel) => (entries: DeliveryRecord[]) =>
		recordDeliveries(
			env,
			update.id,
			channel,
			entries.map((e) => ({ targetId: e.id, ok: e.ok, detail: e.detail })),
		);
	// On a re-run (instance id "update-N-rK"), targets whose delivery failed transiently get another go.
	const done = (channel: Channel) => (ids: number[]) => deliveredTargets(env, update.id, channel, ids, { retryRetryable: rerun });

	// The channels without a quota go first, so email waiting for its quota never holds them up.

	// Push is for real news only ('all'); the daily "still no" never buzzes a phone.
	const push: ChannelReport =
		update.audience === 'all'
			? await isolate('push', () =>
					fanOut(
						'push',
						runStep,
						{
							list: (after, limit) => listPushTargets(env, after, limit),
							done: done('push'),
							deliver: async (subs) => (await deliverPushBatch(env, subs)).map(toAttempt),
							record: record('push'),
						},
						// Push/webhook delivery keeps its own failure counters, so no in-step retries:
						// one attempt per run, with transient failures left for a re-run.
						{ retryInStep: false, batchSize: PUSH_BATCH_SIZE },
					),
				)
			: { skipped: `audience is '${update.audience}'` };

	const webhook = await isolate('webhooks', () =>
		fanOut(
			'webhooks',
			runStep,
			{
				list: (after, limit) => listWebhookTargets(env, update.audience, after, limit),
				done: done('webhook'),
				deliver: async (hooks) => (await deliverWebhookBatch(env, hooks, update, state)).map(toAttempt),
				record: record('webhook'),
			},
			{ retryInStep: false, batchSize: WEBHOOK_BATCH_SIZE },
		),
	);

	// Only real news may spend the last DAILY_EMAIL_RESERVE emails, and only real news waits for
	// tomorrow's quota: a daily post that can't finish today is dropped, not sent late.
	const realNews = update.audience === 'all';
	const onQuota: QuotaHandler = async ({ wait, at }) => {
		if (!realNews) return 'quota reserve reached; the rest of this post is dropped';
		const reset = nextUtcMidnight(new Date(at));
		console.log(`announce: daily email quota exhausted; sleeping until ${reset.toISOString()}`);
		await step.sleepUntil(`wait for email quota reset #${wait}`, reset);
		// Hours may have passed: don't send news that has since been overtaken.
		return step.do(`re-check after quota reset #${wait}`, STEP_CONFIG, async () =>
			staleReason(update, (await getState(env, { fresh: true })).status, new Date()),
		);
	};

	const email = await isolate('email', () =>
		fanOut(
			'email',
			runStep,
			{
				list: (after, limit) => listEmailTargets(env, update.audience, after, limit),
				done: done('email'),
				deliver: async (subs) =>
					(await deliverEmailBatch(env, subs, update, { reserve: realNews ? 0 : DAILY_EMAIL_RESERVE })).map(toAttempt),
				record: record('email'),
			},
			{ retryInStep: true, onQuota, batchSize: EMAIL_BATCH_SIZE },
		),
	);

	await step.do('mark notified', STEP_CONFIG, async () => {
		await markNotified(env, update.id);
		return true;
	});

	const deliveries = await isolate('summary', () => step.do('summarise deliveries', STEP_CONFIG, () => deliverySummary(env, update.id)));

	return {
		...summary,
		email,
		push,
		webhook,
		...(Array.isArray(deliveries) ? { deliveries } : {}),
	};
}

export class AnnounceWorkflow extends WorkflowEntrypoint<Env, AnnounceParams> {
	async run(event: WorkflowEvent<AnnounceParams>, step: WorkflowStep): Promise<unknown> {
		const { updateId, publish, ledgerNote } = event.payload;
		return announce(this.env, updateId, event.instanceId, step, { publish, ledgerNote });
	}
}
