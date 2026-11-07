// The single source of truth for "is Zack a dad?", stored in D1 `settings`.

import { isStatus, type SiteState, type Status, type Update } from '../types';
import { appendLedger } from './ledger';
import { broadcast } from './live';
import { STATUS_COPY } from './site';
import { isYmd, nowIso } from './time';
import { createUpdate } from './updates';

// Tiny per-isolate cache so a burst of requests costs one D1 read. Writes in this
// isolate invalidate it; other isolates converge within the TTL.
const CACHE_TTL_MS = 1000;
let cache: { at: number; state: SiteState } | null = null;

export function invalidateStateCache(): void {
	cache = null;
}

export async function getState(env: Env, opts: { fresh?: boolean } = {}): Promise<SiteState> {
	if (!opts.fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.state;
	const { results } = await env.DB.prepare(
		"SELECT key, value FROM settings WHERE key IN ('status', 'status_changed_at', 'due_date')",
	).all<{ key: string; value: string }>();
	const map = new Map(results.map((r) => [r.key, r.value]));
	const status = map.get('status');
	const state: SiteState = {
		status: isStatus(status) ? status : 'no',
		statusChangedAt: map.get('status_changed_at') ?? nowIso(),
		dueDate: isYmd(map.get('due_date')) ? (map.get('due_date') as string) : null,
	};
	cache = { at: Date.now(), state };
	return state;
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
	const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
	return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	)
		.bind(key, value, nowIso())
		.run();
	if (key === 'status' || key === 'status_changed_at' || key === 'due_date') invalidateStateCache();
}

/**
 * Insert a setting only if it doesn't exist yet, and return whichever value won.
 * Use for lazily generated secrets (VAPID keys, ledger keys, IP salt) so two
 * concurrent first requests can't end up with different keys.
 */
export async function getOrCreateSetting(env: Env, key: string, create: () => Promise<string> | string): Promise<string> {
	const existing = await getSetting(env, key);
	if (existing !== null) return existing;
	const value = await create();
	await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').bind(key, value).run();
	return (await getSetting(env, key)) ?? value;
}

export interface StatusChange {
	state: SiteState;
	update: Update;
}

/**
 * Change the answer. Records history, appends to the Dad Ledger, publishes an
 * update (which broadcasts live and starts the announce workflow), and pushes
 * the new state to every open browser. Returns null if the status is unchanged.
 */
export async function setStatus(env: Env, status: Status, opts: { note?: string } = {}): Promise<StatusChange | null> {
	const current = await getState(env, { fresh: true });
	if (current.status === status) return null;

	const at = nowIso();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES ('status', ?1, ?2), ('status_changed_at', ?2, ?2)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		).bind(status, at),
		env.DB.prepare('INSERT INTO status_history (status, at) VALUES (?, ?)').bind(status, at),
	]);
	invalidateStateCache();
	const state: SiteState = { ...current, status, statusChangedAt: at };

	const copy = STATUS_COPY[status];
	await appendLedger(env, { status, note: opts.note?.trim() || copy.ledgerNote });
	await broadcast(env, { type: 'state', state });
	const update = await createUpdate(env, {
		kind: 'status',
		title: copy.headline,
		body: opts.note?.trim() || copy.sentence,
		status,
		audience: 'all',
	});
	return { state, update };
}

/** Set or clear the due date ('YYYY-MM-DD'). Broadcasts the new state. */
export async function setDueDate(env: Env, dueDate: string | null): Promise<SiteState> {
	if (dueDate !== null && !isYmd(dueDate)) throw new Error('Due date must be YYYY-MM-DD');
	if (dueDate === null) {
		await env.DB.prepare("DELETE FROM settings WHERE key = 'due_date'").run();
	} else {
		await setSetting(env, 'due_date', dueDate);
	}
	invalidateStateCache();
	const state = await getState(env, { fresh: true });
	await broadcast(env, { type: 'state', state });
	return state;
}

/** Every status the site has had, oldest first. */
export async function getStatusHistory(env: Env): Promise<Array<{ status: Status; at: string }>> {
	const { results } = await env.DB.prepare('SELECT status, at FROM status_history ORDER BY id ASC').all<{
		status: Status;
		at: string;
	}>();
	return results;
}
