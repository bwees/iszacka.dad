// The public update stream (feeds, /updates, live pushes, notifications).

import type { Audience, Status, Update, UpdateKind } from '../types';
import { broadcast } from './live';

export interface UpdateRow {
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

/** The INSERT for a new update, RETURNING the row (so callers can put it in a D1 batch). */
export function insertUpdateStatement(env: Env, input: NewUpdate): D1PreparedStatement {
	return env.DB.prepare(
		`INSERT INTO updates (kind, title, body, status, audience) VALUES (?, ?, ?, ?, ?)
		 RETURNING id, kind, title, body, status, audience, created_at, notified_at`,
	).bind(input.kind, input.title, input.body ?? '', input.status, input.audience);
}

/**
 * What the first run of the announce workflow does before it notifies anyone. Set only by the
 * code that creates an update (re-runs leave it out), so the live broadcasts and the ledger
 * entry happen once per update.
 */
export interface PublishParams {
	/** Broadcast the update (and, for status updates, the fresh state) to every open browser. */
	publish?: boolean;
	/** Status updates: the note to sign into the Dad Ledger. */
	ledgerNote?: string;
}

/**
 * Publish an update: store it, then (unless the audience is 'none') start the announce
 * workflow, whose first steps push it to every open browser and whose later ones email /
 * push / ping. Each of those steps has its own CPU budget, so this request stays tiny.
 */
export async function createUpdate(env: Env, input: NewUpdate): Promise<Update> {
	const row = await insertUpdateStatement(env, input).first<UpdateRow>();
	if (!row) throw new Error('Failed to insert update');
	const update = rowToUpdate(row);
	// No workflow for audience 'none' (or if it couldn't start): broadcast here instead.
	if (update.audience === 'none' || !(await launchAnnouncement(env, update.id, { publish: true }))) {
		await broadcast(env, { type: 'update', update });
	}
	return update;
}

function instanceIdFor(updateId: number, attempt: number): string {
	return attempt > 0 ? `update-${updateId}-r${attempt}` : `update-${updateId}`;
}

/**
 * Create the announce workflow instance. True if it started (or already exists, for a
 * duplicate start); false if Workflows refused for any other reason. Never throws.
 */
export async function launchAnnouncement(env: Env, updateId: number, publish: PublishParams = {}, attempt = 0): Promise<boolean> {
	const id = instanceIdFor(updateId, attempt);
	try {
		await env.ANNOUNCE.create({ id, params: { updateId, ...publish } });
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/already.?exists|duplicate/i.test(message)) return true;
		console.warn(`announce workflow ${id} not started:`, message);
		return false;
	}
}

/**
 * Start (or re-run, with a new `attempt`) the announce workflow for an update.
 * Instance ids are deterministic so a duplicate start is a no-op. Delivery is
 * idempotent per recipient (see lib/deliveries.ts), so re-runs only fill gaps.
 */
export async function startAnnouncement(env: Env, updateId: number, attempt = 0): Promise<string> {
	await launchAnnouncement(env, updateId, {}, attempt);
	return instanceIdFor(updateId, attempt);
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
