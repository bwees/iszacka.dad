// OWNER: email agent.
// Durable fan-out of one update to email, push, webhooks, DNS and the OG image.
//
// 1. Load the update.
// 2. Status updates: sleep through a 60s grace period, then re-check. If the status has
//    changed again (or was flipped back to what the world was last told), skip notifying,
//    record why (settings `superseded:<id>`, for /updates/:id), and for a revert re-sync DNS.
// 3. Push, then webhooks, in batches of 25 by id cursor, one step per batch. Each batch skips
//    recipients that already have a delivery row and records every outcome, so step retries
//    and admin re-runs never contact anyone twice.
// 4. Status updates: update the DNS TXT answer record (from fresh state).
// 5. Re-render the OG image.
// 6. Email, last, because it is the only channel with a quota: when the day's quota runs out
//    mid-batch, real news (audience 'all') sleeps until 00:00 UTC and carries on from the same
//    cursor (after checking the update isn't stale by then); anything else stops at
//    DAILY_EMAIL_RESERVE and is dropped, not sent tomorrow. Email waiting on the quota never
//    delays push, webhooks or DNS.
// 7. Mark the update notified, and return a serialisable summary.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { type DeliverySummary, deliveredTargets, deliverySummary, recordDelivery } from '../lib/deliveries';
import { renderOgImage } from '../lib/og';
import { getState, setSetting } from '../lib/state';
import { londonDate } from '../lib/time';
import { getUpdate, markNotified } from '../lib/updates';
import { updateAnswerRecord } from '../notify/dns';
import { DAILY_EMAIL_RESERVE, deliverEmail, isQuotaCode, listEmailTargets } from '../notify/email';
import { deliverPush, listPushTargets } from '../notify/push';
import { deliverWebhook, listWebhookTargets } from '../notify/webhooks';
import type { Audience, Channel, DeliveryResult, SiteState, Status, Update, UpdateKind } from '../types';

export interface AnnounceParams {
	updateId: number;
}

export const BATCH_SIZE = 25;
/** Per channel. 300 × 25 = 7,500 recipients, comfortably inside the per-instance step limit. */
export const MAX_BATCHES = 300;
/**
 * Pages of already-delivered targets one step may walk past before it finds work, so a re-run
 * reaches the recipients beyond the first 7,500 without spending a step per skipped batch.
 */
export const MAX_SKIP_PAGES = 40;
/** Midnight quota waits per run, so a refusal that never clears can't loop for days. */
export const MAX_QUOTA_WAITS = 3;
export const RETRY_LIMIT = 3;
export const STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: RETRY_LIMIT, delay: '10 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
};
export const GRACE_PERIOD = '60 seconds';
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

export interface BatchDeps<T extends { id: number }> {
	list(afterId: number, limit: number): Promise<T[]>;
	/** Of these ids, which must not be contacted again for this update. */
	done(ids: number[]): Promise<Set<number>>;
	deliver(target: T): Promise<Attempt>;
	record(targetId: number, ok: boolean, detail: string): Promise<void>;
}

export interface BatchOptions {
	batchSize?: number;
	/** Throw on retryable failures (so the step retries just those) until the final attempt. */
	retryInStep: boolean;
	finalAttempt: boolean;
	concurrency?: number;
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
 * Run `fn` over `items` with at most `limit` in flight. Stops picking up work after an error
 * (then rethrows it) or once `stop()` says so (in-flight work still finishes).
 */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>, stop: () => boolean = () => false): Promise<void> {
	let next = 0;
	let failure: { error: unknown } | null = null;
	const worker = async () => {
		while (!failure && !stop() && next < items.length) {
			const item = items[next++] as T;
			try {
				await fn(item);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	if (failure) throw (failure as { error: unknown }).error;
}

/**
 * Deliver one batch: list targets after the cursor (one extra, to know whether more follow),
 * walk past pages where everyone is already done, deliver the rest and record each outcome as
 * it happens. If retryable failures remain and attempts are left, throw so the step is
 * retried; the retry skips everyone already recorded. If the email quota runs out (and
 * `stopOnQuota`), stop early without recording the unsent and report `quotaHit`.
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
	let toRetry = 0;
	let quotaHit = false;

	await eachLimit(
		pending,
		opts.concurrency ?? CONCURRENCY,
		async (target) => {
			let attempt: Attempt;
			try {
				attempt = await deps.deliver(target);
			} catch (err) {
				// Delivery functions shouldn't throw, but if one does, treat it as transient.
				attempt = { ok: false, retryable: true, detail: errorMessage(err) };
			}
			if (attempt.quota && opts.stopOnQuota) {
				// Not attempted: no record, so the same batch repeated after the reset sends it.
				quotaHit = true;
				return;
			}
			await settle(target, attempt);
		},
		() => quotaHit,
	);

	if (quotaHit) {
		// Transient failures alongside a quota hit are left unrecorded too: the repeat gets them.
		outcome.quotaHit = true;
		return outcome;
	}
	if (toRetry > 0) throw new RetryableBatchError(`${toRetry} of ${pending.length} deliveries hit transient errors; retrying`);
	return outcome;

	async function settle(target: T, attempt: Attempt): Promise<void> {
		const detail = (attempt.detail ?? '').slice(0, 400);
		if (attempt.ok) {
			await deps.record(target.id, true, detail || 'ok');
			outcome.sent++;
		} else if (attempt.gone) {
			await deps.record(target.id, false, `gone: ${detail}`);
			outcome.failed++;
			outcome.gone++;
		} else if (attempt.retryable) {
			if (opts.retryInStep && !opts.finalAttempt) {
				toRetry++;
				return;
			}
			await deps.record(target.id, false, `retryable: ${detail}`);
			outcome.failed++;
			outcome.deferred++;
		} else {
			await deps.record(target.id, false, `failed: ${detail}`);
			outcome.failed++;
		}
	}
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

/** Walk a channel's targets by id cursor, one step per batch ("email after 0", "email after 25"...). */
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

/** Status of the most recent earlier status update that actually reached anyone. */
async function lastAnnouncedStatus(env: Env, beforeId: number): Promise<Status | null> {
	const row = await env.DB.prepare(
		`SELECT u.status FROM updates u
		 WHERE u.kind = 'status' AND u.id < ?
		   AND (u.notified_at IS NOT NULL OR EXISTS (SELECT 1 FROM deliveries d WHERE d.update_id = u.id))
		 ORDER BY u.id DESC LIMIT 1`,
	)
		.bind(beforeId)
		.first<{ status: Status }>();
	return row?.status ?? null;
}

// ─── Idempotency helpers ─────────────────────────────────────────────────────

/**
 * Targets that must not be contacted again. On a re-run (instance id "update-N-rK"), targets
 * whose earlier delivery failed transiently are given another go.
 */
async function doneTargets(env: Env, updateId: number, channel: Channel, ids: number[], rerun: boolean): Promise<Set<number>> {
	const done = await deliveredTargets(env, updateId, channel, ids);
	if (!rerun || done.size === 0) return done;
	const doneIds = [...done];
	const { results } = await env.DB.prepare(
		`SELECT target_id FROM deliveries WHERE update_id = ? AND channel = ? AND ok = 0 AND detail LIKE 'retryable:%'
		 AND target_id IN (${doneIds.map(() => '?').join(', ')})`,
	)
		.bind(updateId, channel, ...doneIds)
		.all<{ target_id: number }>();
	for (const r of results) done.delete(r.target_id);
	return done;
}

export interface SingleReport {
	ok: boolean;
	detail: string | null;
}

/** A one-off delivery (DNS, OG) inside a step: retried via the step until the final attempt. */
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
	email?: ChannelReport;
	push?: ChannelReport;
	webhook?: ChannelReport;
	dns?: SingleReport | { skipped: string } | { error: string };
	og?: SingleReport | { error: string };
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

export async function announce(env: Env, updateId: number, instanceId: string, step: WorkflowStep): Promise<AnnounceSummary> {
	const rerun = /-r\d+$/.test(instanceId);

	const update: Update | null = await step.do('load update', STEP_CONFIG, () => getUpdate(env, updateId));
	if (!update) return { updateId, skipped: 'update not found' };
	const base = { updateId, kind: update.kind, audience: update.audience, status: update.status };
	if (update.audience === 'none') return { ...base, skipped: "audience is 'none'" };

	const syncDns = () =>
		isolate('dns', () =>
			step.do('update DNS answer record', STEP_CONFIG, (ctx) =>
				singleDelivery(
					// Fresh state, read inside the step: whichever run writes last writes the truth.
					async () => updateAnswerRecord(env, await getState(env, { fresh: true })),
					(ok, detail) => recordDelivery(env, update.id, 'dns', 0, ok, detail),
					isFinalAttempt(ctx.attempt),
				),
			),
		);

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
			// A revert has no newer update to rewrite the DNS record (and refresh `since=`).
			const dns = check.reason === 'reverted' ? await syncDns() : undefined;
			return { ...base, superseded: true, reason: check.reason, currentStatus: check.state.status, ...(dns ? { dns } : {}) };
		}
		state = check.state;
	} else {
		state = await step.do('load state', STEP_CONFIG, () => getState(env, { fresh: true }));
	}

	const runStep: RunStep = (name, fn) => step.do(name, STEP_CONFIG, (ctx) => fn(ctx.attempt));
	const record = (channel: Channel) => (id: number, ok: boolean, detail: string) => recordDelivery(env, update.id, channel, id, ok, detail);
	const done = (channel: Channel) => (ids: number[]) => doneTargets(env, update.id, channel, ids, rerun);

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
							deliver: async (sub) => toAttempt(await deliverPush(env, sub, update)),
							record: record('push'),
						},
						// Push/webhook delivery keeps its own failure counters, so no in-step retries:
						// one attempt per run, with transient failures left for a re-run.
						{ retryInStep: false },
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
				deliver: async (hook) => toAttempt(await deliverWebhook(env, hook, update, state)),
				record: record('webhook'),
			},
			{ retryInStep: false },
		),
	);

	const dns = update.kind === 'status' ? await syncDns() : { skipped: 'only status updates touch DNS' };

	const og = await isolate('og', () =>
		step.do('render OG image', STEP_CONFIG, (ctx) =>
			singleDelivery(
				() => renderOgImage(env),
				(ok, detail) => recordDelivery(env, update.id, 'og', 0, ok, detail),
				isFinalAttempt(ctx.attempt),
			),
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
				deliver: async (sub) => toAttempt(await deliverEmail(env, sub, update, { reserve: realNews ? 0 : DAILY_EMAIL_RESERVE })),
				record: record('email'),
			},
			{ retryInStep: true, onQuota },
		),
	);

	await step.do('mark notified', STEP_CONFIG, async () => {
		await markNotified(env, update.id);
		return true;
	});

	const deliveries = await isolate('summary', () => step.do('summarise deliveries', STEP_CONFIG, () => deliverySummary(env, update.id)));

	return {
		...base,
		email,
		push,
		webhook,
		dns,
		og,
		...(Array.isArray(deliveries) ? { deliveries } : {}),
	};
}

export class AnnounceWorkflow extends WorkflowEntrypoint<Env, AnnounceParams> {
	async run(event: WorkflowEvent<AnnounceParams>, step: WorkflowStep): Promise<unknown> {
		return announce(this.env, event.payload.updateId, event.instanceId, step);
	}
}
