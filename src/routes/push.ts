// Web Push endpoints: the VAPID public key, subscribe, unsubscribe, and a test
// buzz. The browser side lives in /push.js (opt-in widget) and /sw.js (service
// worker, also the offline page and PWA cache).

import type { Context } from 'hono';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { allow, base64UrlDecode, clientIp, clientKey, turnstileEnabled, verifyTurnstile } from '../lib/security';
import { getVapidPublicKey, isUncompressedP256Point } from '../lib/vapid';
import { deliverPush, isPushServiceHost } from '../notify/push';
import { checkPublicHttpsUrl, ownHosts, systemUpdate } from '../notify/webhooks';
import type { AppEnv, PushSubscriptionRow } from '../types';

export const pushRoutes = new Hono<AppEnv>();

export const MAX_PUSH_ENDPOINT_LENGTH = 2048;
/**
 * A ceiling on active subscriptions, so nobody can fill D1 with fake browsers. No more than one
 * announcement run reaches (AnnounceWorkflow's MAX_BATCHES × BATCH_SIZE = 300 × 25).
 */
export const MAX_PUSH_SUBSCRIPTIONS = 7_500;
const MAX_JSON_BYTES = 8 * 1024;

export interface PushSubscriptionInput {
	endpoint: string;
	p256dh: string;
	auth: string;
}

export type ParsedSubscription = { ok: true; value: PushSubscriptionInput } | { ok: false; error: string };

/** Validate a browser's PushSubscription JSON ({endpoint, keys: {p256dh, auth}}). */
export function parsePushSubscription(input: unknown, hosts: readonly string[] = []): ParsedSubscription {
	const fail = (error: string): ParsedSubscription => ({ ok: false, error });
	if (typeof input !== 'object' || input === null) return fail('Expected a PushSubscription object.');
	const { endpoint, keys } = input as { endpoint?: unknown; keys?: unknown };
	const url = checkPublicHttpsUrl(endpoint, { maxLength: MAX_PUSH_ENDPOINT_LENGTH, ownHosts: hosts });
	if (!url.ok) return fail(`endpoint: ${url.error}`);
	if (!isPushServiceHost(url.url.hostname)) {
		return fail("endpoint: that isn't a push service this site knows. Turn notifications on from the page, in a browser that supports them.");
	}
	if (typeof keys !== 'object' || keys === null) return fail('keys: expected {p256dh, auth}.');
	const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
	const cleanP256dh = typeof p256dh === 'string' ? p256dh.trim().replace(/=+$/, '') : '';
	const cleanAuth = typeof auth === 'string' ? auth.trim().replace(/=+$/, '') : '';
	if (!isUncompressedP256Point(cleanP256dh)) return fail('keys.p256dh: expected a base64url P-256 public key.');
	if (!isAuthSecret(cleanAuth)) return fail('keys.auth: expected a base64url 16-byte secret.');
	return { ok: true, value: { endpoint: url.url.href, p256dh: cleanP256dh, auth: cleanAuth } };
}

function isAuthSecret(value: string): boolean {
	if (!/^[A-Za-z0-9_-]{16,32}$/.test(value)) return false;
	try {
		return base64UrlDecode(value).length === 16;
	} catch {
		return false;
	}
}

type JsonBody = { ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415; error: string };

async function readJsonBody(c: Context<AppEnv>): Promise<JsonBody> {
	if (!(c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
		return { ok: false, status: 415, error: 'Send JSON (Content-Type: application/json).' };
	}
	const declared = Number(c.req.header('content-length') ?? '0');
	if (declared > MAX_JSON_BYTES) return { ok: false, status: 413, error: 'That is a lot of JSON for a push subscription.' };
	const text = await c.req.text();
	if (text.length > MAX_JSON_BYTES) return { ok: false, status: 413, error: 'That is a lot of JSON for a push subscription.' };
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false, status: 400, error: "That isn't valid JSON." };
	}
}

/** `{endpoint}` from a request body, normalised the same way subscribe stores it. */
export function endpointFrom(value: unknown): string | null {
	const raw = typeof value === 'object' && value !== null ? (value as { endpoint?: unknown }).endpoint : undefined;
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed || trimmed.length > MAX_PUSH_ENDPOINT_LENGTH) return null;
	try {
		return new URL(trimmed).href;
	} catch {
		return null;
	}
}

const noStore = (c: Context<AppEnv>) => c.header('Cache-Control', 'no-store');

pushRoutes.get('/api/push/key', async (c) => {
	const publicKey = await getVapidPublicKey(c.env);
	c.header('Cache-Control', 'public, max-age=3600');
	return c.json({ publicKey });
});

/** The Turnstile token, if the subscribe JSON carries one. */
function turnstileToken(value: unknown): string | undefined {
	const token = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['cf-turnstile-response'] : undefined;
	return typeof token === 'string' && token ? token : undefined;
}

pushRoutes.post('/api/push/subscribe', async (c) => {
	noStore(c);
	if (!(await allow(c.env.RL_FORMS, `push:${clientKey(c)}`))) {
		return c.json({ ok: false, error: 'Too many attempts. Have a sit down and try again in a minute.' }, 429);
	}
	const body = await readJsonBody(c);
	if (!body.ok) return c.json({ ok: false, error: body.error }, body.status);
	const parsed = parsePushSubscription(body.value, ownHosts(c.env, c.req.url));
	if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
	const { endpoint, p256dh, auth } = parsed.value;

	const existing = await c.env.DB.prepare('SELECT id, disabled_at FROM push_subscriptions WHERE endpoint = ?')
		.bind(endpoint)
		.first<{ id: number; disabled_at: string | null }>();
	const token = turnstileToken(body.value);
	if (existing && !token && turnstileEnabled(c.env)) {
		// The widget's quiet re-sync on page load, which has no robot check. Knowing an endpoint
		// we already hold only refreshes its keys: it can't revive a disabled row or reset its
		// failure count (turning notifications on again, with the check, does that).
		await c.env.DB.prepare('UPDATE push_subscriptions SET p256dh = ?, auth = ? WHERE id = ?').bind(p256dh, auth, existing.id).run();
		const active = existing.disabled_at === null;
		return c.json({
			ok: true,
			created: false,
			active,
			message: active
				? "Notifications are on. You'll hear when labour starts and when Zack is a dad."
				: 'Notifications stopped reaching this device. Turn them on again to resume.',
		});
	}
	if (!(await verifyTurnstile(c.env, token, clientIp(c)))) {
		return c.json({ ok: false, error: "The robot check didn't pass. Please try again.", needsCheck: true }, 403);
	}

	if (!existing) {
		const active = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE disabled_at IS NULL').first<{ n: number }>();
		if ((active?.n ?? 0) >= MAX_PUSH_SUBSCRIPTIONS) {
			return c.json({ ok: false, error: "The stork's address book is full. Email, feeds and webhooks still have room." }, 503);
		}
	}
	await c.env.DB.prepare(
		`INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
		 ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, failures = 0, disabled_at = NULL`,
	)
		.bind(endpoint, p256dh, auth)
		.run();
	return c.json(
		{
			ok: true,
			created: !existing,
			active: true,
			message: "Notifications are on. You'll hear when labour starts and when Zack is a dad.",
		},
		existing ? 200 : 201,
	);
});

pushRoutes.post('/api/push/unsubscribe', async (c) => {
	noStore(c);
	if (!(await allow(c.env.RL_FORMS, `push:${clientKey(c)}`))) {
		return c.json({ ok: false, error: 'Too many attempts. Try again in a minute.' }, 429);
	}
	const body = await readJsonBody(c);
	if (!body.ok) return c.json({ ok: false, error: body.error }, body.status);
	const endpoint = endpointFrom(body.value);
	if (!endpoint) return c.json({ ok: false, error: 'Expected {"endpoint": "https://…"}.' }, 400);
	const result = await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
	const removed = (result.meta.changes ?? 0) > 0;
	return c.json({
		ok: true,
		removed,
		message: removed ? 'Notifications are off. You will have to keep refreshing, like an animal.' : 'That subscription was not on file. Nothing to do.',
	});
});

/** Send one real push to your own subscription, to prove the whole pipe works. */
pushRoutes.post('/api/push/test', async (c) => {
	noStore(c);
	if (!(await allow(c.env.RL_FORMS, `push-test:${clientKey(c)}`))) {
		return c.json({ ok: false, error: 'Too many tests. The stork needs a breather.' }, 429);
	}
	const body = await readJsonBody(c);
	if (!body.ok) return c.json({ ok: false, error: body.error }, body.status);
	const endpoint = endpointFrom(body.value);
	if (!endpoint) return c.json({ ok: false, error: 'Expected {"endpoint": "https://…"}.' }, 400);
	const sub = await c.env.DB.prepare(
		'SELECT id, endpoint, p256dh, auth, failures FROM push_subscriptions WHERE endpoint = ? AND disabled_at IS NULL',
	)
		.bind(endpoint)
		.first<PushSubscriptionRow>();
	if (!sub) return c.json({ ok: false, error: "That subscription isn't on file. Turn notifications off and on again." }, 404);
	const state = c.get('state');
	const result = await deliverPush(c.env, sub, systemUpdate(state, 'Test notification', 'Testing, testing.'));
	return c.json(
		result.ok
			? { ok: true, message: 'Sent. A notification with the current answer should appear in a moment.', detail: result.detail }
			: { ok: false, error: `The push service said no: ${result.detail ?? 'no reason given'}.`, gone: result.gone === true },
		result.ok ? 200 : 502,
	);
});

/**
 * Push opt-in widget fragment. Pages embedding it must load '/push.js' via renderPage({scripts})
 * and pass `turnstile: true`: push.js renders the robot check explicitly into
 * [data-push-turnstile] before turning notifications on.
 */
export function pushWidget(c: Context<AppEnv>) {
	return html`<div class="push-widget stack" data-push-widget>
	<p class="muted tiny">One buzz when labour starts, one when Zack is a dad. No daily nagging, and nothing in the notification but the answer itself.</p>
	<p class="push-status" data-push-status role="status" aria-live="polite">Push notifications need JavaScript and a browser that supports them. Email, feeds and webhooks work without either.</p>
	<div class="cluster" data-push-actions></div>
	${turnstileEnabled(c.env) ? html`<div class="push-turnstile" data-push-turnstile data-sitekey="${c.env.TURNSTILE_SITE_KEY}" hidden></div>` : ''}
	<p class="hint" data-push-hint></p>
</div>`;
}
