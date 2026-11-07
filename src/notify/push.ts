// Web Push delivery: payload-less pushes signed with auto-generated VAPID keys.
//
// There's no payload, so there's nothing to encrypt (RFC 8291 can stay on the
// shelf). The push wakes the service worker, which fetches /api/status and shows
// the answer. The push service's verdict decides what happens to the row:
//   2xx       delivered; the failure count resets
//   404/410   the subscription is gone; disabled immediately
//   429/5xx   retried once, then a failure
//   other     a failure
// Five consecutive failures disable a subscription. The announce workflow sends a
// batch per step (deliverPushBatch) and keeps all the books in one D1 write.

import { nowIso } from '../lib/time';
import { vapidHeaderForEndpoint } from '../lib/vapid';
import { readBodySnippet } from './webhooks';
import type { DeliveryResult, PushSubscriptionRow, Update } from '../types';

export const PUSH_TTL_SECONDS = 86_400;
/** Real push services answer in milliseconds; a slow endpoint mustn't hold up the fan-out. */
export const PUSH_TIMEOUT_MS = 5_000;
export const MAX_PUSH_FAILURES = 5;
/** Replaces any undelivered push from us still queued for the same device (RFC 8030 §5.4). */
export const PUSH_TOPIC = 'iszackadad-status';
/** Longest we'll honour a Retry-After before the one retry. */
const MAX_RETRY_WAIT_MS = 3_000;
const DEFAULT_RETRY_WAIT_MS = 750;

/** Push services browsers actually use. Exact hosts, plus suffixes matched with a leading dot. */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
	'fcm.googleapis.com', // Chrome, Edge on Android, Opera, Samsung Internet
	'android.googleapis.com', // legacy GCM endpoints
	'updates.push.services.mozilla.com', // Firefox
	'web.push.apple.com', // Safari
];
export const PUSH_SERVICE_SUFFIXES: readonly string[] = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

/**
 * Whether a hostname belongs to a real push service. Anything else is someone using us to POST
 * at a URL of their choosing (or to stall the announcement with a slow server).
 */
export function isPushServiceHost(hostname: string): boolean {
	const host = hostname.trim().toLowerCase().replace(/\.$/, '');
	return PUSH_SERVICE_HOSTS.includes(host) || PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/** An https URL on a real push service. */
export function isPushServiceEndpoint(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && isPushServiceHost(url.hostname);
	} catch {
		return false;
	}
}

/** Active push subscriptions with id > afterId, ascending by id. */
export async function listPushTargets(env: Env, afterId: number, limit: number): Promise<PushSubscriptionRow[]> {
	const max = Math.min(Math.max(Math.floor(limit) || 1, 1), 500);
	const after = Number.isFinite(afterId) ? Math.max(Math.floor(afterId), 0) : 0;
	const { results } = await env.DB.prepare(
		`SELECT id, endpoint, p256dh, auth, failures FROM push_subscriptions
		 WHERE disabled_at IS NULL AND id > ? ORDER BY id ASC LIMIT ?`,
	)
		.bind(after, max)
		.all<PushSubscriptionRow>();
	return results;
}

/** What a push service response means for us. */
export type PushOutcome = 'ok' | 'gone' | 'retry' | 'fail';

export function classifyPushStatus(status: number): PushOutcome {
	if (status >= 200 && status < 300) return 'ok';
	if (status === 404 || status === 410) return 'gone';
	if (status === 429 || status >= 500 || status === 0) return 'retry';
	return 'fail';
}

/** How long to wait before the retry, from a Retry-After header (seconds or HTTP date), capped. */
export function retryDelayMs(retryAfter: string | null, now: number = Date.now()): number {
	if (!retryAfter) return DEFAULT_RETRY_WAIT_MS;
	const seconds = Number(retryAfter);
	const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
	if (!Number.isFinite(ms) || ms < 0) return DEFAULT_RETRY_WAIT_MS;
	return Math.min(ms, MAX_RETRY_WAIT_MS);
}

/** Headers for a payload-less push. */
export function pushHeaders(authorization: string): Record<string, string> {
	return {
		Authorization: authorization,
		TTL: String(PUSH_TTL_SECONDS),
		Urgency: 'high',
		Topic: PUSH_TOPIC,
		'Content-Length': '0',
	};
}

interface Attempt {
	status: number;
	detail: string;
	retryAfter: string | null;
}

async function attemptPush(env: Env, endpoint: string): Promise<Attempt> {
	try {
		// One JWT per push service per hour or so (lib/vapid.ts caches it by origin).
		const authorization = await vapidHeaderForEndpoint(env, endpoint);
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: pushHeaders(authorization),
			redirect: 'manual',
			signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
		});
		let detail = `HTTP ${res.status}`;
		if (res.ok) {
			await res.body?.cancel();
		} else {
			const text = await readBodySnippet(res);
			if (text) detail += `: ${text.slice(0, 160)}`;
		}
		return { status: res.status, detail, retryAfter: res.headers.get('retry-after') };
	} catch (err) {
		const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
		const detail = timedOut
			? `no response within ${PUSH_TIMEOUT_MS / 1000}s`
			: `request failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
		return { status: 0, detail, retryAfter: null };
	}
}

/** What one push came to, before the bookkeeping. */
type Sent =
	| { outcome: 'ok'; detail: string }
	| { outcome: 'gone'; detail: string }
	| { outcome: 'fail'; detail: string }
	/** Never contacted: not an https URL on a known push service. */
	| { outcome: 'invalid'; detail: string };

async function pushOnce(env: Env, sub: PushSubscriptionRow): Promise<Sent> {
	if (!isHttpsUrl(sub.endpoint)) return { outcome: 'invalid', detail: 'endpoint is not an https URL; disabled' };
	// Rows stored before the allowlist, or slipped in some other way, are retired unsent.
	if (!isPushServiceEndpoint(sub.endpoint)) return { outcome: 'invalid', detail: 'endpoint is not a known push service; disabled' };

	let attempt = await attemptPush(env, sub.endpoint);
	let outcome = classifyPushStatus(attempt.status);
	if (outcome === 'retry') {
		await sleep(retryDelayMs(attempt.retryAfter));
		attempt = await attemptPush(env, sub.endpoint);
		outcome = classifyPushStatus(attempt.status);
		if (outcome === 'retry') outcome = 'fail';
	}
	return { outcome, detail: attempt.detail } as Sent;
}

/** Simultaneous pushes per batch: Workers allows six open connections per invocation. */
const PUSH_CONCURRENCY = 6;

/**
 * Send one push to each subscription (at most PUSH_CONCURRENCY at a time), then keep the books
 * for all of them in a single D1 batch: reset failure counts that need it, count failures,
 * disable the gone. Never throws; one result per subscription, in order.
 */
export async function deliverPushBatch(env: Env, subs: readonly PushSubscriptionRow[]): Promise<DeliveryResult[]> {
	const sent: Sent[] = new Array(subs.length);
	let next = 0;
	const worker = async () => {
		while (next < subs.length) {
			const i = next++;
			const sub = subs[i] as PushSubscriptionRow;
			try {
				sent[i] = await pushOnce(env, sub);
			} catch (err) {
				// Belt and braces: nothing above should throw, but a delivery function never does.
				console.error('push delivery failed unexpectedly:', err);
				sent[i] = { outcome: 'fail', detail: `unexpected error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, subs.length) }, worker));

	// Bookkeeping: one statement per push that changes anything, all in one round trip.
	const at = nowIso();
	const statements: D1PreparedStatement[] = [];
	const failureIndex = new Map<number, number>();
	sent.forEach((s, i) => {
		const sub = subs[i] as PushSubscriptionRow;
		if (s.outcome === 'ok') {
			// The row carries its count, so a healthy subscription costs no write at all.
			if (sub.failures !== 0) statements.push(env.DB.prepare('UPDATE push_subscriptions SET failures = 0 WHERE id = ? AND failures != 0').bind(sub.id));
		} else if (s.outcome === 'gone' || s.outcome === 'invalid') {
			statements.push(env.DB.prepare('UPDATE push_subscriptions SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ?').bind(at, sub.id));
		} else {
			failureIndex.set(i, statements.length);
			statements.push(
				env.DB.prepare(
					`UPDATE push_subscriptions SET failures = failures + 1,
					 disabled_at = CASE WHEN failures + 1 >= ? THEN COALESCE(disabled_at, ?) ELSE disabled_at END
					 WHERE id = ? RETURNING failures`,
				).bind(MAX_PUSH_FAILURES, at, sub.id),
			);
		}
	});
	let written: D1Result<{ failures: number }>[] | null = null;
	if (statements.length) {
		try {
			written = await env.DB.batch<{ failures: number }>(statements);
		} catch (err) {
			console.error('push bookkeeping failed:', err);
		}
	}

	return sent.map((s, i): DeliveryResult => {
		switch (s.outcome) {
			case 'ok':
				return { ok: true, detail: s.detail };
			case 'invalid':
				return { ok: false, gone: true, detail: s.detail };
			case 'gone':
				return { ok: false, gone: true, detail: `${s.detail}: subscription gone, disabled` };
			default: {
				const slot = failureIndex.get(i);
				const failures = written && slot !== undefined ? (written[slot]?.results[0]?.failures ?? null) : null;
				if (failures !== null && failures >= MAX_PUSH_FAILURES) {
					return { ok: false, detail: `${s.detail} (failure ${failures}; disabled after ${MAX_PUSH_FAILURES} in a row)` };
				}
				return { ok: false, detail: failures === null ? s.detail : `${s.detail} (failure ${failures} of ${MAX_PUSH_FAILURES})` };
			}
		}
	});
}

/** Send one push. Never throws; disables the subscription when the push service says it's gone. */
export async function deliverPush(env: Env, sub: PushSubscriptionRow, _update: Update): Promise<DeliveryResult> {
	const [result] = await deliverPushBatch(env, [sub]);
	return result ?? { ok: false, detail: 'unexpected error: no result' };
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
