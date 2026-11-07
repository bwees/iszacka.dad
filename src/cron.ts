// OWNER: email agent.
// Daily cron (09:00 UTC): the "Day N: still no." update (which the announce workflow emails
// to daily subscribers, posts to daily webhooks and uses to refresh the OG image), plus cleanup.
//
// Idempotent per Europe/London day: a run that finds today's daily update already posted
// does nothing, and a settings-row claim stops two overlapping runs from both posting.

import { CONCLUDED_TITLE, type DailyPlan, planDailyPost } from './lib/daily';
import { getCheckTotal } from './lib/counters';
import { renderOgImage } from './lib/og';
import { getSetting, getState } from './lib/state';
import { UNCONFIRMED_TTL_DAYS, UNSUBSCRIBED_TTL_DAYS } from './lib/retention';
import { londonDate } from './lib/time';
import { createUpdate } from './lib/updates';
import { updateAnswerRecord } from './notify/dns';
import { DAILY_EMAIL_RESERVE, emailQuotaRemaining } from './notify/email';
import { purgeResendEvents } from './routes/resend-webhook';

export { DAILY_EMAIL_RESERVE, UNCONFIRMED_TTL_DAYS, UNSUBSCRIBED_TTL_DAYS };

/** settings key holding the London date of the last claimed daily post. */
export const DAILY_CLAIM_KEY = 'daily_posted_for';

const DAY_MS = 86_400_000;

export type DailyResult =
	| { action: 'posted'; updateId: number; title: string; phase: string }
	| { action: 'skipped'; reason: string; ogRefreshed?: boolean };

async function lastDailyDate(env: Env): Promise<string | null> {
	const row = await env.DB.prepare("SELECT created_at FROM updates WHERE kind = 'daily' ORDER BY id DESC LIMIT 1").first<{
		created_at: string;
	}>();
	if (!row) return null;
	const t = Date.parse(row.created_at);
	return Number.isNaN(t) ? null : londonDate(new Date(t));
}

async function launchDate(env: Env, fallback: string): Promise<string> {
	const row = await env.DB.prepare('SELECT MIN(at) AS at FROM status_history').first<{ at: string | null }>();
	const t = row?.at ? Date.parse(row.at) : Number.NaN;
	return Number.isNaN(t) ? fallback : londonDate(new Date(t));
}

/** Has the farewell post gone out since Zack became a dad? */
async function hasConcluded(env: Env, since: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT 1 AS hit FROM updates WHERE kind = 'daily' AND title = ? AND created_at >= ? LIMIT 1")
		.bind(CONCLUDED_TITLE, since)
		.first<{ hit: number }>();
	return Boolean(row);
}

/** Atomically claim today's post. Returns false if another run already claimed it. */
async function claimDay(env: Env, today: string, at: string): Promise<boolean> {
	const res = await env.DB.prepare(
		`INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
		 WHERE settings.value <> excluded.value`,
	)
		.bind(DAILY_CLAIM_KEY, today, at)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

async function releaseDay(env: Env, today: string, previous: string | null): Promise<void> {
	try {
		if (previous === null) {
			await env.DB.prepare('DELETE FROM settings WHERE key = ? AND value = ?').bind(DAILY_CLAIM_KEY, today).run();
		} else {
			await env.DB.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?').bind(previous, DAILY_CLAIM_KEY, today).run();
		}
	} catch (err) {
		console.error('cron: could not release the daily claim:', err instanceof Error ? err.message : String(err));
	}
}

/** Post today's daily update, unless there's nothing to say or it's already been said. */
export async function postDaily(env: Env, now: Date): Promise<DailyResult> {
	const today = londonDate(now);
	if ((await lastDailyDate(env)) === today) return { action: 'skipped', reason: `already posted for ${today}` };

	const state = await getState(env, { fresh: true });
	const [launch, concluded, checks] = await Promise.all([
		launchDate(env, today),
		state.status === 'yes' ? hasConcluded(env, state.statusChangedAt) : Promise.resolve(false),
		getCheckTotal(env).catch(() => null),
	]);
	const plan: DailyPlan = planDailyPost({ today, launchDate: launch, state, checks, concluded });

	if (plan.action === 'skip') {
		// No update means no workflow, so refresh the social card here instead. Never throws.
		const og = await renderOgImage(env);
		return { action: 'skipped', reason: plan.reason, ogRefreshed: og.ok };
	}

	const previous = await getSetting(env, DAILY_CLAIM_KEY);
	if (!(await claimDay(env, today, now.toISOString()))) {
		return { action: 'skipped', reason: `another run already claimed ${today}` };
	}
	if ((await emailQuotaRemaining(env, now)) <= DAILY_EMAIL_RESERVE) {
		await releaseDay(env, today, previous);
		console.log('cron: skipping the daily email; the send quota is nearly exhausted');
		return { action: 'skipped', reason: `email quota reserve (${DAILY_EMAIL_RESERVE}) reached` };
	}
	try {
		const update = await createUpdate(env, {
			kind: 'daily',
			title: plan.title,
			body: plan.body,
			status: plan.status,
			audience: 'daily',
		});
		return { action: 'posted', updateId: update.id, title: update.title, phase: plan.phase };
	} catch (err) {
		await releaseDay(env, today, previous);
		throw err;
	}
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

export async function handleScheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
	const now = new Date(controller.scheduledTime || Date.now());
	const failures: unknown[] = [];

	try {
		const daily = await postDaily(env, now);
		console.log('cron: daily', JSON.stringify(daily));
	} catch (err) {
		failures.push(err);
		console.error('cron: daily post failed:', err instanceof Error ? err.message : String(err));
	}

	// The DNS TXT answer record is otherwise only written when a status change is announced, so
	// re-sync it daily: that creates it after the first deploy and follows due-date changes. Its
	// own try block, so a DNS problem never gets in the way of the daily post.
	try {
		const dns = await updateAnswerRecord(env, await getState(env, { fresh: true }));
		console.log('cron: dns', JSON.stringify(dns));
		if (!dns.ok) failures.push(new Error(`DNS sync failed: ${dns.detail ?? 'unknown'}`));
	} catch (err) {
		failures.push(err);
		console.error('cron: dns sync failed:', err instanceof Error ? err.message : String(err));
	}

	try {
		const purged = await purgeSubscribers(env, now);
		console.log('cron: purge', JSON.stringify(purged));
	} catch (err) {
		failures.push(err);
		console.error('cron: purge failed:', err instanceof Error ? err.message : String(err));
	}

	try {
		const events = await purgeResendEvents(env, now);
		console.log('cron: purge resend events', JSON.stringify({ events }));
	} catch (err) {
		failures.push(err);
		console.error('cron: resend event purge failed:', err instanceof Error ? err.message : String(err));
	}

	// Every task got its chance; now make sure the invocation shows up as failed if any didn't.
	if (failures.length) throw new AggregateError(failures, `cron: ${failures.length} task(s) failed`);
}
