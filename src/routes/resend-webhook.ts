// OWNER: email agent.
// Resend webhook endpoint (POST /api/resend/webhook). Resend signs every delivery with svix:
// the signature is verified before anything is parsed, then the svix-id is recorded in
// `resend_events` so a retried or duplicated delivery is acknowledged but never processed
// twice. For email.received the full email is fetched from Resend before answering (bounded by
// RECEIVE_FETCH_TIMEOUT_MS, well inside Svix's 15s), so a transient failure can hand the retry
// back to Resend; the rest of the work (auto-replying, disabling bounced subscribers) happens in
// waitUntil so the response stays quick.
//
// Responses: 503 if RESEND_WEBHOOK_SECRET isn't set, 401 for a bad signature, 400 for a body
// that isn't JSON, 500 if the dedupe table can't be written (Resend retries later), 503 if the
// received email couldn't be fetched for a transient reason (429, 5xx, network error, timeout:
// the svix-id claim is released so Resend's redelivery is handled, not taken for a duplicate),
// else 200.
//
// Events:
//   email.received    fetch the full email (transient failure: release the claim, 503); once
//                     the claim is kept, count it against the quota and run the inbound handler
//                     in waitUntil. A permanent failure (404 or other 4xx, no email_id, no
//                     RESEND_API_KEY) still counts against the quota and answers 200.
//   email.bounced     disable every recipient subscriber (permanent rejection)
//   email.complained  disable every recipient subscriber (marked as spam)
//   anything else     200, ignored

import { Hono } from 'hono';
import { bareAddress, handleInboundEmail, type InboundEmail } from '../email-handler';
import { timingSafeEqual } from '../lib/security';
import { nowIso } from '../lib/time';
import { RESEND_API_BASE, RESEND_USER_AGENT, disableSubscriberByEmail, recordEmailSend } from '../notify/email';
import type { AppEnv } from '../types';

export const resendWebhookRoutes = new Hono<AppEnv>();

/** Reject deliveries older than this (replay protection). */
export const MAX_SKEW_SECONDS = 300;

export interface SvixHeaders {
	id: string | null;
	timestamp: string | null;
	signature: string | null;
}

function base64ToBytes(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = '';
	for (const b of view) binary += String.fromCharCode(b);
	return btoa(binary);
}

/** The svix signature for a payload: base64(HMAC-SHA256(secret, "<id>.<timestamp>.<body>")). */
export async function signSvixPayload(secret: string, id: string, timestamp: string, body: string): Promise<string> {
	const keyBytes = base64ToBytes(secret.replace(/^whsec_/, ''));
	const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
	return bytesToBase64(signature);
}

/**
 * Verify a Resend (svix) webhook signature. `svix-signature` may carry several space-separated
 * `v1,<base64>` signatures; any match wins. Timestamps outside ±5 minutes are rejected.
 */
export async function verifySvixSignature(
	secret: string,
	headers: SvixHeaders,
	body: string,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	const { id, timestamp, signature } = headers;
	if (!id || !timestamp || !signature) return false;
	const sent = Number(timestamp);
	if (!Number.isFinite(sent) || Math.abs(nowSeconds - sent) > MAX_SKEW_SECONDS) return false;
	let expected: string;
	try {
		expected = await signSvixPayload(secret, id, timestamp, body);
	} catch {
		console.error('resend webhook: RESEND_WEBHOOK_SECRET is not valid base64 (expected whsec_...)');
		return false;
	}
	return signature
		.split(' ')
		.filter(Boolean)
		.some((part) => part.startsWith('v1,') && timingSafeEqual(part.slice(3), expected));
}

export interface ResendEvent {
	type?: string;
	data?: {
		email_id?: string;
		/** Received events: the bare sender address. Sent events: our From, maybe with a name. */
		from?: string;
		to?: string[];
		subject?: string;
		message_id?: string;
		bounce?: { type?: string; subType?: string; message?: string };
	};
}

/** The parsed body of GET /emails/receiving/{id} (fields we care about). */
export interface ReceivedEmail {
	id: string;
	/** May be "Name <addr>"; only the address is ever used. */
	from?: string;
	to?: string[];
	subject?: string;
	text?: string | null;
	html?: string | null;
	headers?: Record<string, string | string[]>;
	message_id?: string;
	/** Resend's own SPF/DKIM/DMARC verdicts (null for emails received before it existed). */
	authentication?: { spf?: string | null; dkim?: string | null; dmarc?: string | null } | null;
}

/** Longest svix-id we'll store (real ones are ~30 characters). */
const MAX_SVIX_ID = 200;
/** resend_events rows older than this are purged by the daily cron. */
export const RESEND_EVENT_TTL_DAYS = 30;

/**
 * Record a delivery by svix-id. True if it's new (process it), false if we've seen it before.
 * Throws if the table can't be written: the caller answers 500 so Resend retries later,
 * rather than risk handling an event twice or not at all.
 */
export async function claimResendEvent(env: Pick<Env, 'DB'>, svixId: string, type: string, at: string = nowIso()): Promise<boolean> {
	const res = await env.DB.prepare('INSERT INTO resend_events (svix_id, type, at) VALUES (?, ?, ?) ON CONFLICT (svix_id) DO NOTHING')
		.bind(svixId.slice(0, MAX_SVIX_ID), type.slice(0, 100), at)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/**
 * Undo claimResendEvent, so a redelivery of the same svix-id is processed instead of being
 * acknowledged as a duplicate. Used when the route answers non-2xx after claiming. Throws if
 * the row can't be deleted.
 */
export async function releaseResendEvent(env: Pick<Env, 'DB'>, svixId: string): Promise<void> {
	await env.DB.prepare('DELETE FROM resend_events WHERE svix_id = ?').bind(svixId.slice(0, MAX_SVIX_ID)).run();
}

/** Forget handled deliveries older than RESEND_EVENT_TTL_DAYS. Returns how many went. */
export async function purgeResendEvents(env: Pick<Env, 'DB'>, now: Date = new Date()): Promise<number> {
	const cutoff = new Date(now.getTime() - RESEND_EVENT_TTL_DAYS * 86_400_000).toISOString();
	const res = await env.DB.prepare('DELETE FROM resend_events WHERE at < ?').bind(cutoff).run();
	return res.meta.changes ?? 0;
}

/**
 * How long the route waits for GET /emails/receiving/{id}. Svix gives up on a delivery after
 * 15 seconds, so this leaves room for the D1 writes either side and still answers in time.
 */
export const RECEIVE_FETCH_TIMEOUT_MS = 8_000;

/** The outcome of fetching a received email. `transient` failures are worth Resend redelivering. */
export type FetchReceivedResult = { ok: true; email: ReceivedEmail } | { ok: false; transient: boolean };

/**
 * Fetch the full received email (the webhook only carries metadata). Never throws. 429, 5xx,
 * network errors and timeouts are transient; 404, other 4xx and a missing API key are not.
 */
async function fetchReceivedEmail(env: Env, emailId: string): Promise<FetchReceivedResult> {
	if (!env.RESEND_API_KEY) {
		console.error('inbound: RESEND_API_KEY is not set; cannot fetch the received email');
		return { ok: false, transient: false };
	}
	const base = (env.RESEND_API_BASE || RESEND_API_BASE).replace(/\/+$/, '');
	try {
		const res = await fetch(`${base}/emails/receiving/${encodeURIComponent(emailId)}`, {
			headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'User-Agent': RESEND_USER_AGENT },
			signal: AbortSignal.timeout(RECEIVE_FETCH_TIMEOUT_MS),
		});
		if (!res.ok) {
			const transient = res.status === 429 || res.status >= 500;
			console.error(`inbound: fetching the received email failed: HTTP ${res.status}${transient ? ' (asking Resend to redeliver)' : ''}`);
			return { ok: false, transient };
		}
		return { ok: true, email: (await res.json()) as ReceivedEmail };
	} catch (err) {
		console.error('inbound: fetching the received email failed (asking Resend to redeliver):', err instanceof Error ? err.message : String(err));
		return { ok: false, transient: true };
	}
}

/**
 * The InboundEmail for the handler. The sender is the webhook's `data.from` (Resend sends the
 * bare address there for received mail) in preference to the retrieved email's `from`, which
 * can carry a display name; either way it's reduced to the bare, lower-cased address.
 */
export function toInboundEmail(data: ResendEvent['data'], received: ReceivedEmail): InboundEmail {
	const headers = received.headers ?? {};
	const references = headers.references;
	return {
		from: bareAddress(data?.from) || bareAddress(received.from),
		subject: received.subject ?? data?.subject ?? '',
		text: received.text,
		html: received.html,
		headers,
		messageId: received.message_id ?? data?.message_id ?? null,
		references: Array.isArray(references) ? references.join(' ') : (references ?? null),
		id: received.id ?? data?.email_id ?? null,
		// The structured verdicts only; never the Authentication-Results headers the sender wrote.
		authentication: received.authentication ?? null,
	};
}

/**
 * Runs once the claim on an email.received delivery is kept (so a released, redelivered event
 * is counted once). `received` is null after a permanent fetch failure: nothing to reply to.
 */
async function handleReceived(env: Env, data: ResendEvent['data'], received: ReceivedEmail | null): Promise<void> {
	// Resend counts received emails against the same daily quota as sends.
	await recordEmailSend(env);
	if (!received) return;
	await handleInboundEmail(toInboundEmail(data, received), env);
}

async function handleBounceOrComplaint(env: Env, type: string, data: ResendEvent['data']): Promise<void> {
	// email.bounced is documented as permanent, but don't unsubscribe anyone over a full inbox.
	const bounceType = (data?.bounce?.type ?? '').toLowerCase();
	if (type === 'email.bounced' && (bounceType === 'temporary' || bounceType === 'transient')) {
		console.log(`inbound: ${type}: ${bounceType} bounce; leaving the subscriber alone`);
		return;
	}
	for (const to of data?.to ?? []) {
		const address = bareAddress(to);
		if (!address) continue;
		const disabled = await disableSubscriberByEmail(env, address);
		console.log(`inbound: ${type}: ${disabled ? 'unsubscribed a subscriber' : 'no matching subscriber'}`);
	}
}

resendWebhookRoutes.post('/api/resend/webhook', async (c) => {
	const secret = c.env.RESEND_WEBHOOK_SECRET;
	if (!secret) return c.json({ ok: false, error: 'webhook not configured' }, 503);

	const body = await c.req.text();
	const svixId = c.req.header('svix-id') ?? null;
	const verified = await verifySvixSignature(
		secret,
		{ id: svixId, timestamp: c.req.header('svix-timestamp') ?? null, signature: c.req.header('svix-signature') ?? null },
		body,
	);
	if (!verified || !svixId) return c.json({ ok: false, error: 'invalid signature' }, 401);

	let event: ResendEvent;
	try {
		event = JSON.parse(body) as ResendEvent;
	} catch {
		return c.json({ ok: false, error: 'invalid payload' }, 400);
	}
	const type = typeof event.type === 'string' ? event.type : 'unknown';

	try {
		if (!(await claimResendEvent(c.env, svixId, type))) return c.json({ ok: true, duplicate: true });
	} catch (err) {
		console.error('resend webhook: could not record the event:', err instanceof Error ? err.message : String(err));
		return c.json({ ok: false, error: 'try again later' }, 500);
	}

	switch (type) {
		case 'email.received': {
			const emailId = event.data?.email_id;
			let fetched: FetchReceivedResult;
			if (emailId) {
				fetched = await fetchReceivedEmail(c.env, emailId);
			} else {
				console.error('inbound: email.received without an email_id');
				fetched = { ok: false, transient: false };
			}
			if (!fetched.ok && fetched.transient) {
				// Give the svix-id back so Resend's redelivery is processed, not taken for a duplicate.
				try {
					await releaseResendEvent(c.env, svixId);
				} catch (err) {
					console.error(
						'resend webhook: could not release the event, so its redelivery will be ignored:',
						err instanceof Error ? err.message : String(err),
					);
				}
				return c.json({ ok: false, error: 'try again later' }, 503);
			}
			c.executionCtx.waitUntil(handleReceived(c.env, event.data, fetched.ok ? fetched.email : null));
			return c.json({ ok: true });
		}
		case 'email.bounced':
		case 'email.complained':
			c.executionCtx.waitUntil(handleBounceOrComplaint(c.env, type, event.data));
			return c.json({ ok: true });
		default:
			return c.json({ ok: true, ignored: type });
	}
});
