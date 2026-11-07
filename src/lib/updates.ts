// The public update stream (feeds, /updates, live pushes, notifications).

import type { Audience, Status, Update, UpdateKind } from '../types';
import { broadcast } from './live';

interface UpdateRow {
	id: number;
	kind: UpdateKind;
	title: string;
	body: string;
	status: Status;
	audience: Audience;
	created_at: string;
	notified_at: string | null;
}

export function rowToUpdate(row: UpdateRow): Update {
	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		body: row.body,
		status: row.status,
		audience: row.audience,
		createdAt: row.created_at,
		notifiedAt: row.notified_at,
	};
}

export interface NewUpdate {
	kind: UpdateKind;
	title: string;
	body?: string;
	status: Status;
	audience: Audience;
}

/**
 * Publish an update: store it, push it to every open browser, and (unless the
 * audience is 'none') start the announce workflow that emails / pushes / pings.
 */
export async function createUpdate(env: Env, input: NewUpdate): Promise<Update> {
	const row = await env.DB.prepare(
		`INSERT INTO updates (kind, title, body, status, audience) VALUES (?, ?, ?, ?, ?)
		 RETURNING id, kind, title, body, status, audience, created_at, notified_at`,
	)
		.bind(input.kind, input.title, input.body ?? '', input.status, input.audience)
		.first<UpdateRow>();
	if (!row) throw new Error('Failed to insert update');
	const update = rowToUpdate(row);
	await broadcast(env, { type: 'update', update });
	if (update.audience !== 'none') await startAnnouncement(env, update.id);
	return update;
}

/**
 * Start (or re-run, with a new `attempt`) the announce workflow for an update.
 * Instance ids are deterministic so a duplicate start is a no-op. Delivery is
 * idempotent per recipient (see lib/deliveries.ts), so re-runs only fill gaps.
 */
export async function startAnnouncement(env: Env, updateId: number, attempt = 0): Promise<string> {
	const id = attempt > 0 ? `update-${updateId}-r${attempt}` : `update-${updateId}`;
	try {
		await env.ANNOUNCE.create({ id, params: { updateId } });
	} catch (err) {
		// Already exists (duplicate start) is fine; anything else is logged, not fatal.
		console.warn(`announce workflow ${id} not started:`, err);
	}
	return id;
}

export async function getUpdate(env: Env, id: number): Promise<Update | null> {
	const row = await env.DB.prepare(
		'SELECT id, kind, title, body, status, audience, created_at, notified_at FROM updates WHERE id = ?',
	)
		.bind(id)
		.first<UpdateRow>();
	return row ? rowToUpdate(row) : null;
}

/** Newest first. `beforeId` paginates. `kinds` filters. */
export async function listUpdates(
	env: Env,
	opts: { limit?: number; beforeId?: number; kinds?: UpdateKind[] } = {},
): Promise<Update[]> {
	const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
	const where: string[] = [];
	const binds: unknown[] = [];
	if (opts.beforeId) {
		where.push('id < ?');
		binds.push(opts.beforeId);
	}
	if (opts.kinds?.length) {
		where.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`);
		binds.push(...opts.kinds);
	}
	const sql = `SELECT id, kind, title, body, status, audience, created_at, notified_at FROM updates
		${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
	const { results } = await env.DB.prepare(sql)
		.bind(...binds, limit)
		.all<UpdateRow>();
	return results.map(rowToUpdate);
}

export async function markNotified(env: Env, id: number): Promise<void> {
	await env.DB.prepare("UPDATE updates SET notified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
		.bind(id)
		.run();
}
