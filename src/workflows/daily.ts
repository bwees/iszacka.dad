// OWNER: notify agent.
// The daily 09:00 UTC job, one instance per Europe/London day (id `daily-YYYY-MM-DD`, created by
// the cron in src/cron.ts). Each chore is its own step, so each gets its own 10 ms CPU budget
// and its own retries, and one failing chore never stops the others:
//
// 1. Post the "Day N: still no." update (which the announce workflow emails to daily
//    subscribers and posts to daily webhooks).
// 2. Re-sync the DNS TXT answer record (it's otherwise only written on status changes, so
//    this creates it after the first deploy and follows due-date changes).
// 3. Forget unconfirmed sign-ups and long-unsubscribed addresses.
// 4. Forget old Resend webhook deliveries.
//
// The instance id makes the job idempotent per day; the post step also checks that today's
// post isn't already out, so a retry after a write that did land posts nothing twice.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { getCheckTotal } from '../lib/counters';
import { CONCLUDED_TITLE, type DailyPlan, planDailyPost } from '../lib/daily';
import { UNCONFIRMED_TTL_DAYS, UNSUBSCRIBED_TTL_DAYS } from '../lib/retention';
import { getState } from '../lib/state';
import { isYmd, londonDate } from '../lib/time';
import { createUpdate } from '../lib/updates';
import { updateAnswerRecord } from '../notify/dns';
import { DAILY_EMAIL_RESERVE, emailDailyLimit, utcDay } from '../notify/email';
import { purgeResendEvents } from '../routes/resend-webhook';
import { isStatus, type SiteState } from '../types';

export interface DailyParams {
	/** London date this run is for, 'YYYY-MM-DD'. */
	day: string;
	/** When the cron fired (ISO). Defaults to the instance's creation time. */
	at?: string;
}

const DAY_MS = 86_400_000;

export const DAILY_STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
};

export type DailyResult =
	| { action: 'posted'; updateId: number; title: string; phase: string }
	| { action: 'skipped'; reason: string };

interface DailyFacts {
	/** London date of the newest daily post, if any. */
	lastPosted: string | null;
	state: SiteState;
	/** London date of the first status_history row (Day 1), if any. */
	launch: string | null;
	/** The farewell post for the current YES is already out. */
	concluded: boolean;
	/** Emails sent today (UTC). */
	sentToday: number;
}

function londonDateOf(iso: string | null | undefined): string | null {
	const t = iso ? Date.parse(iso) : Number.NaN;
	return Number.isNaN(t) ? null : londonDate(new Date(t));
}

/** Everything postDaily needs to decide, in one D1 round trip. */
async function readDailyFacts(env: Env, now: Date): Promise<DailyFacts> {
	const [last, settings, launch, concluded, sends] = await env.DB.batch<Record<string, unknown>>([
		env.DB.prepare("SELECT created_at FROM updates WHERE kind = 'daily' ORDER BY id DESC LIMIT 1"),
		env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('status', 'status_changed_at', 'due_date')"),
		env.DB.prepare('SELECT MIN(at) AS at FROM status_history'),
		env.DB.prepare(
			`SELECT 1 AS hit FROM updates WHERE kind = 'daily' AND title = ?
			 AND created_at >= (SELECT value FROM settings WHERE key = 'status_changed_at') LIMIT 1`,
		).bind(CONCLUDED_TITLE),
		env.DB.prepare('SELECT n FROM email_sends WHERE day = ?').bind(utcDay(now)),
	]);
	const map = new Map((settings?.results ?? []).map((r) => [String(r.key), String(r.value)]));
	const status = map.get('status');
	const dueDate = map.get('due_date');
	return {
		lastPosted: londonDateOf(last?.results[0]?.created_at as string | undefined),
		state: {
			status: isStatus(status) ? status : 'no',
			statusChangedAt: map.get('status_changed_at') ?? now.toISOString(),
			dueDate: isYmd(dueDate) ? dueDate : null,
		},
		launch: londonDateOf(launch?.results[0]?.at as string | null | undefined),
		concluded: Boolean(concluded?.results[0]),
		sentToday: Number(sends?.results[0]?.n ?? 0) || 0,
	};
}

/**
 * Post today's daily update, unless there's nothing to say, it's already been said, the day is
 * over, or the email quota is down to the reserve kept for real news. The announce workflow it
 * starts does the live broadcast and the fan-out. No social-card render here: the cards are
 * static.
 */
export async function postDaily(env: Env, day: string, now: Date = new Date()): Promise<DailyResult> {
	const today = londonDate(now);
	if (today !== day) return { action: 'skipped', reason: `the day is over (this run was for ${day}; it is now ${today})` };

	const facts = await readDailyFacts(env, now);
	if (facts.lastPosted === today) return { action: 'skipped', reason: `already posted for ${today}` };
	const checks = await getCheckTotal(env).catch(() => null);
	const plan: DailyPlan = planDailyPost({
		today,
		launchDate: facts.launch ?? today,
		state: facts.state,
		checks,
		concluded: facts.state.status === 'yes' && facts.concluded,
	});
	if (plan.action === 'skip') return { action: 'skipped', reason: plan.reason };

	if (emailDailyLimit(env) - facts.sentToday <= DAILY_EMAIL_RESERVE) {
		console.log('daily: skipping the daily post; the email quota is down to the reserve');
		return { action: 'skipped', reason: `email quota reserve (${DAILY_EMAIL_RESERVE}) reached` };
	}
	const update = await createUpdate(env, { kind: 'daily', title: plan.title, body: plan.body, status: plan.status, audience: 'daily' });
	return { action: 'posted', updateId: update.id, title: update.title, phase: plan.phase };
}

export interface PurgeResult {
	unconfirmed: number;
	unsubscribed: number;
}

/** Forget sign-ups that were never confirmed, and addresses that left a while ago. */
export async function purgeSubscribers(env: Env, now: Date): Promise<PurgeResult> {
	const unconfirmedCutoff = new Date(now.getTime() - UNCONFIRMED_TTL_DAYS * DAY_MS).toISOString();
	const unsubscribedCutoff = new Date(now.getTime() - UNSUBSCRIBED_TTL_DAYS * DAY_MS).toISOString();
	const [unconfirmed, unsubscribed] = await env.DB.batch([
		env.DB.prepare('DELETE FROM subscribers WHERE confirmed_at IS NULL AND COALESCE(confirm_sent_at, created_at) < ?').bind(
			unconfirmedCutoff,
		),
		env.DB.prepare('DELETE FROM subscribers WHERE unsubscribed_at IS NOT NULL AND unsubscribed_at < ?').bind(unsubscribedCutoff),
	]);
	return { unconfirmed: unconfirmed?.meta.changes ?? 0, unsubscribed: unsubscribed?.meta.changes ?? 0 };
}

export interface DailySummary {
	day: string;
	daily: DailyResult | { error: string };
	dns: { ok: boolean; detail: string | null } | { error: string };
	purge: PurgeResult | { error: string };
	resendEvents: { purged: number } | { error: string };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function runDaily(env: Env, params: DailyParams, step: WorkflowStep, startedAt: Date): Promise<DailySummary> {
	const day = isYmd(params.day) ? params.day : londonDate(startedAt);
	const parsed = params.at ? new Date(params.at) : startedAt;
	const firedAt = Number.isNaN(parsed.getTime()) ? startedAt : parsed;
	const failures: string[] = [];
	// Each chore that fails after its retries is reported, and the next one still runs.
	const chore = async <T extends Rpc.Serializable<T>>(label: string, fn: () => Promise<T>): Promise<T | { error: string }> => {
		try {
			return await step.do(label, DAILY_STEP_CONFIG, fn);
		} catch (err) {
			const message = errorMessage(err).slice(0, 300);
			console.error(`daily: ${label} failed after retries:`, message);
			failures.push(`${label}: ${message}`);
			return { error: message };
		}
	};

	// `new Date()` inside the step: a retry hours later must see that the day is over.
	const daily = await chore('post daily update', () => postDaily(env, day, new Date()));
	const dns = await chore('sync DNS answer record', async () => {
		const result = await updateAnswerRecord(env, await getState(env, { fresh: true }));
		if (!result.ok) throw new Error(`DNS sync failed: ${result.detail ?? 'unknown'}`);
		return { ok: true, detail: result.detail ?? null };
	});
	const purge = await chore('purge subscribers', () => purgeSubscribers(env, firedAt));
	const resendEvents = await chore('purge resend events', async () => ({ purged: await purgeResendEvents(env, firedAt) }));

	const summary: DailySummary = { day, daily, dns, purge, resendEvents };
	console.log('daily:', JSON.stringify(summary));
	// Every chore got its chance; now make sure the instance shows up as errored if any didn't.
	if (failures.length) throw new Error(`daily ${day}: ${failures.length} chore(s) failed: ${failures.join('; ')}`.slice(0, 1000));
	return summary;
}

export class DailyWorkflow extends WorkflowEntrypoint<Env, DailyParams> {
	async run(event: WorkflowEvent<DailyParams>, step: WorkflowStep): Promise<unknown> {
		return runDaily(this.env, event.payload, step, event.timestamp);
	}
}
