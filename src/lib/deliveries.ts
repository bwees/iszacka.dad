// Delivery log. Makes notification fan-out idempotent: a recipient that already
// has a row for (update, channel) is never contacted again for that update, even
// if a workflow step is retried or the announcement is re-run.

import type { Channel } from '../types';

/** Which of `targetIds` already have a delivery row (successful or permanently failed). */
export async function deliveredTargets(
	env: Env,
	updateId: number,
	channel: Channel,
	targetIds: number[],
): Promise<Set<number>> {
	if (targetIds.length === 0) return new Set();
	const { results } = await env.DB.prepare(
		`SELECT target_id FROM deliveries WHERE update_id = ? AND channel = ?
		 AND target_id IN (${targetIds.map(() => '?').join(', ')})`,
	)
		.bind(updateId, channel, ...targetIds)
		.all<{ target_id: number }>();
	return new Set(results.map((r) => r.target_id));
}

export async function recordDelivery(
	env: Env,
	updateId: number,
	channel: Channel,
	targetId: number,
	ok: boolean,
	detail?: string,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO deliveries (update_id, channel, target_id, ok, detail) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (update_id, channel, target_id) DO UPDATE SET ok = excluded.ok, detail = excluded.detail, at = excluded.at`,
	)
		.bind(updateId, channel, targetId, ok ? 1 : 0, detail?.slice(0, 500) ?? null)
		.run();
}

export interface DeliverySummary {
	channel: Channel;
	ok: number;
	failed: number;
}

export async function deliverySummary(env: Env, updateId: number): Promise<DeliverySummary[]> {
	const { results } = await env.DB.prepare(
		`SELECT channel, SUM(ok) AS ok, SUM(1 - ok) AS failed FROM deliveries WHERE update_id = ? GROUP BY channel`,
	)
		.bind(updateId)
		.all<DeliverySummary>();
	return results;
}
