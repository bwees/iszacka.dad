// Delivery log. Makes notification fan-out idempotent: a recipient that already
// has a row for (update, channel) is never contacted again for that update, even
// if a workflow step is retried or the announcement is re-run.

import type { Channel } from '../types';

/**
 * Which of `targetIds` already have a delivery row (successful or permanently failed). With
 * `retryRetryable`, rows recorded as transient failures ('retryable: …') don't count, so a
 * re-run gives those targets another go. One query either way.
 */
export async function deliveredTargets(
	env: Env,
	updateId: number,
	channel: Channel,
	targetIds: number[],
	opts: { retryRetryable?: boolean } = {},
): Promise<Set<number>> {
	if (targetIds.length === 0) return new Set();
	const skipRetryable = opts.retryRetryable ? " AND NOT (ok = 0 AND detail LIKE 'retryable:%')" : '';
	const { results } = await env.DB.prepare(
		`SELECT target_id FROM deliveries WHERE update_id = ? AND channel = ?
		 AND target_id IN (${targetIds.map(() => '?').join(', ')})${skipRetryable}`,
	)
		.bind(updateId, channel, ...targetIds)
		.all<{ target_id: number }>();
	return new Set(results.map((r) => r.target_id));
}

const UPSERT_DELIVERY = `INSERT INTO deliveries (update_id, channel, target_id, ok, detail) VALUES (?, ?, ?, ?, ?)
	 ON CONFLICT (update_id, channel, target_id) DO UPDATE SET ok = excluded.ok, detail = excluded.detail, at = excluded.at`;

export async function recordDelivery(
	env: Env,
	updateId: number,
	channel: Channel,
	targetId: number,
	ok: boolean,
	detail?: string,
): Promise<void> {
	await env.DB.prepare(UPSERT_DELIVERY)
		.bind(updateId, channel, targetId, ok ? 1 : 0, detail?.slice(0, 500) ?? null)
		.run();
}

export interface DeliveryEntry {
	targetId: number;
	ok: boolean;
	detail?: string;
}

/** Record a whole batch of outcomes in one D1 round trip (a single implicit transaction). */
export async function recordDeliveries(env: Env, updateId: number, channel: Channel, entries: readonly DeliveryEntry[]): Promise<void> {
	if (entries.length === 0) return;
	await env.DB.batch(
		entries.map((e) =>
			env.DB.prepare(UPSERT_DELIVERY).bind(updateId, channel, e.targetId, e.ok ? 1 : 0, e.detail?.slice(0, 500) ?? null),
		),
	);
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
