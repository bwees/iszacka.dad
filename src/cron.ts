// OWNER: notify agent.
// Daily cron (09:00 UTC). On Workers Free a cron invocation gets 10 ms of CPU, so it does
// nothing but start the day's DailyWorkflow (src/workflows/daily.ts), which runs each chore
// (the daily post, the DNS re-sync, the purges) as its own step with its own budget.
//
// The instance id is `daily-<Europe/London date>`, so a second trigger on the same day (a
// retry, an overlap, a manual run) finds the instance already there and does nothing.

import { londonDate } from './lib/time';
import type { DailyParams } from './workflows/daily';

/** The DailyWorkflow instance id for a London date. */
export function dailyInstanceId(day: string): string {
	return `daily-${day}`;
}

export type CronResult = { started: string } | { alreadyRan: string };

/** Start today's DailyWorkflow. Throws (so the invocation shows as failed) unless it started or already exists. */
export async function startDaily(env: Pick<Env, 'DAILY'>, now: Date): Promise<CronResult> {
	const day = londonDate(now);
	const id = dailyInstanceId(day);
	const params: DailyParams = { day, at: now.toISOString() };
	try {
		await env.DAILY.create({ id, params });
		return { started: id };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/already.?exists|duplicate/i.test(message)) return { alreadyRan: id };
		throw err;
	}
}

export async function handleScheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
	const result = await startDaily(env, new Date(controller.scheduledTime || Date.now()));
	console.log('cron:', JSON.stringify(result));
}
