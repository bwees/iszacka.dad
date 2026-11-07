// OWNER: email agent.
// Resend webhook endpoint (POST /api/resend/webhook). Resend signs every delivery with svix:
// the signature is verified before anything is parsed, then the svix-id is recorded in
// `resend_events` so a retried or duplicated delivery is acknowledged but never processed
// twice. On Workers Free the whole invocation gets 10 ms of CPU (waitUntil included), so the
// route does no email work itself: an email.received event starts an InboundWorkflow instance
// (src/workflows/inbound.ts), whose steps each get their own budget and retries.
//
// Responses: 503 if RESEND_WEBHOOK_SECRET isn't set, 401 for a bad signature, 400 for a body
// that isn't JSON, 500 if the dedupe table can't be written (Resend retries later), 503 if the
// workflow instance couldn't be started (the svix-id claim is released, so Resend's redelivery
// is handled, not taken for a duplicate), else 200.
//
// Events:
//   email.received    start INBOUND with id `inbound-<svix-id>` and {emailId, from, svixId};
//                     an instance that already exists counts as started
//   email.bounced     disable every recipient subscriber (permanent rejection), inline
//   email.complained  disable every recipient subscriber (marked as spam), inline
//   anything else     200, ignored

import { Hono } from 'hono';
import { LinearRouter } from 'hono/router/linear-router';
import { bareAddress } from '../email-handler';
import { sha256Hex, timingSafeEqual } from '../lib/security';
import { nowIso } from '../lib/time';
import { disableSubscriberByEmail } from '../notify/email';
import type { AppEnv } from '../types';
import type { InboundParams } from '../workflows/inbound';

export const resendWebhookRoutes = new Hono<AppEnv>({ router: new LinearRouter() });

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

/** Longest Workflow instance id (Workflows allows 100). */
const MAX_INSTANCE_ID = 100;
/** Finished inbound instances (and the sender address in their params) are kept this long. */
export const INBOUND_SUCCESS_RETENTION = '1 day';
/** Recipients a bounce or complaint may unsubscribe (ours go to one address at a time). */
const MAX_BOUNCE_RECIPIENTS = 10;

/**
 * The InboundWorkflow instance id for a delivery: `inbound-<svix-id>`, so a redelivery maps to
 * the same instance. A svix-id that isn't a valid instance id (Workflows allows letters,
 * digits, `-` and `_`, up to 100) is hashed instead.
 */
export async function inboundInstanceId(svixId: string): Promise<string> {
	const id = `inbound-${svixId}`;
	if (id.length <= MAX_INSTANCE_ID && /^[A-Za-z0-9_-]+$/.test(svixId)) return id;
	return `inbound-h${(await sha256Hex(svixId)).slice(0, 40)}`;
}

/**
 * Start the InboundWorkflow instance for an email.received delivery. True if it is running
 * (just created, or created by an earlier delivery of the same event); false if it couldn't be
 * started, and Resend should redeliver. Never throws.
 */
export async function startInbound(env: Pick<Env, 'INBOUND'>, id: string, params: InboundParams): Promise<boolean> {
	try {
		await env.INBOUND.create({ id, params, retention: { successRetention: INBOUND_SUCCESS_RETENTION } });
		return true;
	} catch (createError) {
		// create() throws for an id that already exists: that delivery was already handed off.
		try {
			await env.INBOUND.get(id);
			return true;
		} catch {
			console.error('resend webhook: could not start the inbound workflow:', createError instanceof Error ? createError.message : String(createError));
			return false;
		}
	}
}

/** The InboundWorkflow params for an email.received event. */
export function inboundParams(data: ResendEvent['data'], svixId: string): InboundParams {
	const emailId = typeof data?.email_id === 'string' ? data.email_id.slice(0, 200) : '';
	// Resend sends the bare address here for received mail; reduce it anyway.
	return { emailId, from: bareAddress(typeof data?.from === 'string' ? data.from : ''), svixId: svixId.slice(0, MAX_SVIX_ID) };
}

async function handleBounceOrComplaint(env: Env, type: string, data: ResendEvent['data']): Promise<void> {
	// email.bounced is documented as permanent, but don't unsubscribe anyone over a full inbox.
	const bounceType = (data?.bounce?.type ?? '').toLowerCase();
	if (type === 'email.bounced' && (bounceType === 'temporary' || bounceType === 'transient')) {
		console.log(`inbound: ${type}: ${bounceType} bounce; leaving the subscriber alone`);
		return;
	}
	const recipients = Array.isArray(data?.to) ? data.to.slice(0, MAX_BOUNCE_RECIPIENTS) : [];
	for (const to of recipients) {
		const address = bareAddress(typeof to === 'string' ? to : '');
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
			const params = inboundParams(event.data, svixId);
			if (!params.emailId) console.error('inbound: email.received without an email_id');
			if (await startInbound(c.env, await inboundInstanceId(svixId), params)) return c.json({ ok: true });
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
		case 'email.bounced':
		case 'email.complained':
			// One D1 lookup (and update) per recipient: cheap enough to do before answering.
			await handleBounceOrComplaint(c.env, type, event.data);
			return c.json({ ok: true });
		default:
			return c.json({ ok: true, ignored: type });
	}
});
