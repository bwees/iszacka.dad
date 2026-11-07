// OWNER: email agent.
// GET/POST /subscribe, GET/POST /confirm/:token, GET/POST /unsubscribe/:token.
//
// Double opt-in email subscriptions with RFC 8058 one-click unsubscribe. POST /subscribe
// always gives the same "check your inbox" answer whatever the address's history, so the
// form can't be used to find out who has subscribed. Token routes are authenticated by the
// 192-bit token in the URL, so they need no Turnstile (mail providers can't solve one) and are
// rate-limited per subscriber; unknown tokens are rate-limited per IP. No GET changes anything:
// mail security scanners open every link in an email, so GET /confirm only shows a button, and
// the confirmation itself is a POST.

import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { html } from 'hono/html';
import { LinearRouter } from 'hono/router/linear-router';
import { dailyLine } from '../lib/daily';
import { type Html, renderPage } from '../lib/layout';
import { allow, clientIp, clientKey, isValidEmail, randomToken, turnstileWidget, verifyTurnstile, wantsJson } from '../lib/security';
import { UNCONFIRMED_TTL_DAYS, UNSUBSCRIBED_TTL_DAYS } from '../lib/retention';
import { DAD, DOMAIN, STATUS_COPY } from '../lib/site';
import { nowIso } from '../lib/time';
import {
	ASK_ADDRESS,
	FREQUENCY_COPY,
	SUBSCRIBER_COLUMNS,
	isFrequency,
	sendAlreadySubscribed,
	sendConfirmation,
} from '../notify/email';
import type { AppEnv, Frequency, Status, SubscriberRow } from '../types';

type Ctx = Context<AppEnv>;

export const subscribeRoutes = new Hono<AppEnv>({ router: new LinearRouter() });

/** One confirmation (or "already subscribed") email per address per this window. */
export const CONFIRM_RESEND_MS = 10 * 60 * 1000;
export const EMAIL_MAX = 254;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const FREQUENCIES: readonly Frequency[] = ['big', 'daily'];

export const CHECK_INBOX_MESSAGE = `Check your inbox. If that address can receive email, a message from the stork is on its way: click the link inside within ${UNCONFIRMED_TTL_DAYS} days to confirm.`;

// Built on first use: only form posts need it, and module scope runs on every cold isolate.
let bodyLimiter: MiddlewareHandler | undefined;
const limitBody: MiddlewareHandler = (c, next) =>
	(bodyLimiter ??= bodyLimit({
		maxSize: 16 * 1024,
		onError: (c) => c.text('That is a lot of form. Please send less of it.', 413),
	}))(c, next);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Trimmed, with the domain lower-cased (local parts are technically case-sensitive). */
export function normaliseEmail(value: string): string {
	const trimmed = value.trim();
	const at = trimmed.lastIndexOf('@');
	if (at <= 0) return trimmed;
	return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

/** "a•••@example.com": enough to recognise your own address, not enough to harvest one. */
export function maskEmail(email: string): string {
	const at = email.lastIndexOf('@');
	if (at <= 0) return '•••';
	return `${email.slice(0, 1)}•••@${email.slice(at + 1)}`;
}

function isOwnDomain(email: string): boolean {
	const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
	return domain === DOMAIN || domain.endsWith(`.${DOMAIN}`);
}

/** Form fields as strings, whatever the encoding. An empty or unparseable body is `{}`. */
async function readBody(c: Ctx): Promise<Record<string, string>> {
	const type = (c.req.header('content-type') ?? '').toLowerCase();
	try {
		if (type.includes('application/json')) return stringFields(await c.req.json());
		if (type.includes('multipart/form-data')) return stringFields(await c.req.parseBody());
		// application/x-www-form-urlencoded, text/plain, or no body at all (RFC 8058 one-click).
		return Object.fromEntries(new URLSearchParams(await c.req.text()));
	} catch {
		return {};
	}
}

function stringFields(data: unknown): Record<string, string> {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
	return Object.fromEntries(Object.entries(data).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** Token pages: never cached, never indexed, never leaked via Referer. */
function privateHeaders(c: Ctx): void {
	c.header('Cache-Control', 'no-store');
	c.header('Referrer-Policy', 'no-referrer');
	c.header('X-Robots-Tag', 'noindex');
}

function subscriptionState(sub: SubscriberRow): 'pending' | 'active' | 'unsubscribed' {
	if (sub.unsubscribed_at) return 'unsubscribed';
	return sub.confirmed_at ? 'active' : 'pending';
}

// ─── Fragments ───────────────────────────────────────────────────────────────

function frequencyFieldset(idPrefix: string, current: Frequency): Html {
	return html`<fieldset class="field" style="border:0;padding:0;margin:0;min-width:0;">
<legend>How often?</legend>
${FREQUENCIES.map(
	(f) => html`<label for="${idPrefix}-freq-${f}" style="display:flex;gap:0.6rem;align-items:flex-start;margin-top:0.5rem;cursor:pointer;">
<input type="radio" id="${idPrefix}-freq-${f}" name="frequency" value="${f}" ${f === current ? 'checked' : ''} aria-describedby="${idPrefix}-freq-${f}-hint" style="margin-top:0.3rem;">
<span><strong>${FREQUENCY_COPY[f].label}</strong><span class="hint" id="${idPrefix}-freq-${f}-hint" style="display:block;">${FREQUENCY_COPY[f].hint}</span></span>
</label>`,
)}
</fieldset>`;
}

export interface SignupFormOptions {
	/** Prefix for element ids, if the form appears more than once on a page. */
	idPrefix?: string;
	/** Pre-fill (after a validation error). */
	email?: string;
	frequency?: Frequency;
}

/** Email signup form fragment, embedded by /everything and the homepage. Posts to /subscribe. */
export function emailSignupForm(c: Context<AppEnv>, opts: SignupFormOptions = {}) {
	const id = opts.idPrefix ?? 'subscribe';
	return html`<form class="form stack" method="post" action="/subscribe" data-form="subscribe">
<div class="field">
<label for="${id}-email">Email address</label>
<input id="${id}-email" name="email" type="email" required maxlength="${EMAIL_MAX}" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="you@example.com" value="${opts.email ?? ''}" aria-describedby="${id}-email-hint">
<p class="hint" id="${id}-email-hint">Used for this and nothing else. Never shared, never sold, deleted ${UNSUBSCRIBED_TTL_DAYS} days after you unsubscribe.</p>
</div>
${frequencyFieldset(id, opts.frequency ?? 'big')}
<div aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;">
<label for="${id}-website">Leave this field empty</label>
<input id="${id}-website" name="website" type="text" tabindex="-1" autocomplete="off">
</div>
${turnstileWidget(c.env)}
<button class="btn btn-primary" type="submit">Email me</button>
</form>`;
}

// ─── Pages ───────────────────────────────────────────────────────────────────

interface SubscribePageOptions {
	error?: string;
	email?: string;
	frequency?: Frequency;
	status?: number;
}

function renderSubscribePage(c: Ctx, opts: SubscribePageOptions = {}): Promise<Response> {
	const body = html`<div class="wrap section stack">
<header class="page-head">
<p class="kicker">Email updates</p>
<h1>Get told, by email</h1>
<p class="lede">The moment ${DAD} becomes a dad, an email lands in your inbox. Or, if you have a taste for anticipation, one every morning until then.</p>
</header>
${opts.error ? html`<p class="notice notice-error" role="alert">${opts.error}</p>` : ''}
<div class="grid">
<section class="card stack" aria-labelledby="subscribe-title">
<h2 class="card-title" id="subscribe-title">Sign up</h2>
${emailSignupForm(c, { email: opts.email, frequency: opts.frequency })}
</section>
<section class="card stack" aria-labelledby="speeds-title">
<h2 class="card-title" id="speeds-title">Two speeds</h2>
<h3>${FREQUENCY_COPY.big.label}</h3>
<p>Real news only. You will hear when labour starts, when the answer becomes YES, and if there is a false alarm. Realistically two or three emails, ever.</p>
<h3>${FREQUENCY_COPY.daily.label}</h3>
<p>Everything above, plus a short, dry update every morning at 09:00 UTC until it's a yes. Then a week of "dad day" updates, a farewell, and silence. A sample:</p>
<blockquote><p><strong>Day 47: still no.</strong><br>${dailyLine(47)}</p></blockquote>
</section>
<section class="card stack" aria-labelledby="fine-print-title">
<h2 class="card-title" id="fine-print-title">The fine print</h2>
<ul>
<li>Double opt-in: nothing is sent until you click the link in the confirmation email.</li>
<li>One-click unsubscribe in every email, including the fancy RFC 8058 kind your mail app shows at the top.</li>
<li>We store the address and your choice of speed. That's it. Unconfirmed addresses are deleted after ${UNCONFIRMED_TTL_DAYS} days.</li>
<li>Unsubscribed addresses are kept for ${UNSUBSCRIBED_TTL_DAYS} days, so the resubscribe button works, then deleted from this site's database.</li>
<li>Emails come from <span class="mono">${c.env.EMAIL_FROM}</span>. Add it to your contacts if you'd hate to miss the big one.</li>
</ul>
</section>
</div>
<p class="muted">Rather not hand over an email address? There are push notifications, webhooks, feeds and a DNS record on <a href="/everything">the everything page</a>. Or email <span class="mono">${ASK_ADDRESS}</span> and a robot will tell you the answer.</p>
</div>`;
	return renderPage(c, {
		title: 'Email updates',
		description: `Get an email the moment ${DAD} becomes a dad. Or a daily "still no", if you prefer.`,
		body,
		path: '/subscribe',
		turnstile: true,
		status: opts.status,
	});
}

function renderCheckInbox(c: Ctx): Promise<Response> | Response {
	if (wantsJson(c)) return c.json({ ok: true, message: CHECK_INBOX_MESSAGE });
	const body = html`<div class="wrap section stack">
<header class="page-head">
<p class="kicker">Nearly there</p>
<h1>Check your inbox</h1>
<p class="lede">If that address can receive email, a message from the stork is on its way. Click the link inside, within ${UNCONFIRMED_TTL_DAYS} days, to confirm.</p>
</header>
<p class="notice notice-ok" role="status">${CHECK_INBOX_MESSAGE}</p>
<section class="card stack">
<h2 class="card-title">Nothing there?</h2>
<ul>
<li>Check spam and any "promotions" folder. It comes from <span class="mono">${c.env.EMAIL_FROM}</span>.</li>
<li>Still nothing after 10 minutes? Try again. We send at most one email per address every 10 minutes, so nobody can use the stork as a weapon.</li>
<li>Already subscribed? Then we've sent your manage link instead, so you can change how often you hear from us.</li>
</ul>
</section>
<p class="cluster"><a class="btn btn-ghost" href="/">Back to the answer</a> <a class="btn btn-ghost" href="/everything">Other ways to be notified</a></p>
</div>`;
	return renderPage(c, { title: 'Check your inbox', body, path: '/subscribe', noindex: true });
}

function failSubscribe(c: Ctx, status: 400 | 403 | 429, error: string, fields: Record<string, string> = {}) {
	if (wantsJson(c)) return c.json({ ok: false, error }, status);
	const frequency = isFrequency(fields.frequency) ? fields.frequency : undefined;
	return renderSubscribePage(c, { error, email: (fields.email ?? '').trim().slice(0, EMAIL_MAX), frequency, status });
}

function renderTokenNotFound(c: Ctx): Promise<Response> | Response {
	if (wantsJson(c)) return c.json({ ok: false, error: 'Unknown or expired link.' }, 404);
	const body = html`<div class="wrap section stack">
<header class="page-head">
<p class="kicker">Link not recognised</p>
<h1>That link has wandered off</h1>
<p class="lede">It may have expired: unconfirmed sign-ups are deleted after ${UNCONFIRMED_TTL_DAYS} days, and old links stop working when an address subscribes again.</p>
</header>
<p class="cluster"><a class="btn btn-primary" href="/subscribe">Subscribe again</a> <a class="btn btn-ghost" href="/">Back to the answer</a></p>
</div>`;
	return renderPage(c, { title: 'Link not recognised', body, noindex: true, status: 404 });
}

function renderTooMany(c: Ctx): Promise<Response> | Response {
	const error = 'Steady on. Too many requests from your network; try again in a minute.';
	if (wantsJson(c)) return c.json({ ok: false, error }, 429);
	const body = html`<div class="wrap section stack"><header class="page-head"><p class="kicker">Slow down</p><h1>Too many requests</h1></header>
<p class="notice notice-error" role="alert">${error}</p></div>`;
	return renderPage(c, { title: 'Too many requests', body, noindex: true, status: 429 });
}

function renderConfirmed(c: Ctx, sub: SubscriberRow, newly: boolean): Promise<Response> | Response {
	if (wantsJson(c)) return c.json({ ok: true, confirmed: true, alreadyConfirmed: !newly, frequency: sub.frequency });
	const status: Status = c.get('state').status;
	const manage = `/unsubscribe/${encodeURIComponent(sub.token)}`;
	const body = html`<div class="wrap section stack">
<header class="page-head">
<p class="kicker">${newly ? 'Confirmed' : 'Already confirmed'}</p>
<h1>You're on the list.</h1>
<p class="lede">We'll email you ${FREQUENCY_COPY[sub.frequency].summary}. The current answer, for the record: <strong>${STATUS_COPY[status].word}</strong>.</p>
</header>
<p class="notice notice-ok" role="status">${newly ? 'Subscription confirmed. Welcome aboard.' : 'This link has been used before. You were already confirmed, so nothing has changed.'}</p>
<p class="cluster"><a class="btn btn-primary" href="/">See the answer</a> <a class="btn btn-ghost" href="${manage}">Manage subscription</a> <a class="btn btn-ghost" href="/everything">More ways to be notified</a></p>
<p class="muted tiny">Every email has a one-click unsubscribe link. We'd be hurt, briefly.</p>
</div>`;
	return renderPage(c, { title: 'Subscription confirmed', body, noindex: true });
}

interface ManageNotice {
	kind: 'ok' | 'error';
	message: string;
}

function renderManage(c: Ctx, sub: SubscriberRow, notice?: ManageNotice, httpStatus = 200): Promise<Response> | Response {
	const state = subscriptionState(sub);
	if (wantsJson(c)) {
		const payload = {
			ok: notice?.kind !== 'error',
			state,
			unsubscribed: state === 'unsubscribed',
			confirmed: sub.confirmed_at !== null,
			frequency: sub.frequency,
			...(notice ? { message: notice.message } : {}),
		};
		return c.json(payload, httpStatus as 200);
	}
	const action = `/unsubscribe/${encodeURIComponent(sub.token)}`;
	const lede =
		state === 'active'
			? `Confirmed, and getting ${FREQUENCY_COPY[sub.frequency].summary}.`
			: state === 'pending'
				? 'Not confirmed yet, so nothing is being sent.'
				: 'Unsubscribed. Nothing is being sent.';
	const body = html`<div class="wrap section stack">
<header class="page-head">
<p class="kicker">Your subscription</p>
<h1>Manage email updates</h1>
<p class="lede">For <span class="mono">${maskEmail(sub.email)}</span>. ${lede}</p>
</header>
${notice ? html`<p class="notice notice-${notice.kind}" role="${notice.kind === 'error' ? 'alert' : 'status'}">${notice.message}</p>` : ''}
${
	state === 'pending'
		? html`<div class="notice"><p>This address hasn't been confirmed yet. Since you have the link, you can do it right here.</p>
<form class="form" method="post" action="/confirm/${encodeURIComponent(sub.token)}"><button class="btn btn-primary" type="submit">Confirm now</button></form></div>`
		: ''
}
${
	state === 'unsubscribed'
		? html`<section class="card stack" id="unsubscribe" aria-labelledby="unsubscribed-title">
<h2 class="card-title" id="unsubscribed-title">You're unsubscribed</h2>
<p>No more emails will be sent to this address. Should you need the answer, it remains at <a href="/">${DOMAIN}</a>.</p>
<p class="muted">This address will be deleted from this site within ${UNSUBSCRIBED_TTL_DAYS} days.</p>
${
	sub.confirmed_at
		? html`<form class="form" method="post" action="${action}"><input type="hidden" name="action" value="resubscribe">
<button class="btn btn-primary" type="submit">Changed my mind: resubscribe</button></form>`
		: html`<p><a class="btn btn-primary" href="/subscribe">Subscribe again</a></p>`
}
</section>`
		: html`<div class="grid">
<section class="card stack" id="frequency" aria-labelledby="frequency-title">
<h2 class="card-title" id="frequency-title">How often?</h2>
<form class="form stack" method="post" action="${action}">
<input type="hidden" name="action" value="frequency">
${frequencyFieldset('manage', sub.frequency)}
<button class="btn btn-primary" type="submit">Save</button>
</form>
</section>
<section class="card stack" id="unsubscribe" aria-labelledby="unsubscribe-title">
<h2 class="card-title" id="unsubscribe-title">Unsubscribe</h2>
<p>One click and you're off the list. No guilt trip, no exit survey, no "are you sure?". This is the "are you sure?".</p>
<form class="form" method="post" action="${action}"><input type="hidden" name="action" value="unsubscribe">
<button class="btn btn-danger" type="submit">Unsubscribe</button></form>
</section>
</div>`
}
<p class="muted tiny">Bookmark-worthy: this link is the key to your subscription. Don't forward it to anyone you wouldn't trust with your inbox.</p>
</div>`;
	return renderPage(c, { title: 'Manage email updates', body, noindex: true, status: httpStatus });
}

// ─── Data ────────────────────────────────────────────────────────────────────

export type SubscribeAction =
	| { send: 'none' }
	| { send: 'confirm' | 'already'; sub: SubscriberRow; previousSentAt: string | null };

/**
 * Upsert by email and claim the right to send one email (atomically, so concurrent requests
 * can't double-send):
 * - new address: insert, send the confirmation.
 * - unsubscribed: fresh token, back to pending, send the confirmation.
 * - pending or active: if nothing was sent in the last 10 minutes, send the confirmation
 *   (pending; the new frequency choice applies) or the "already subscribed" manage link
 *   (active; nothing changes without proof of inbox ownership).
 */
export async function upsertSubscriber(env: Env, email: string, frequency: Frequency, now = new Date()): Promise<SubscribeAction> {
	const at = now.toISOString();
	const cutoff = new Date(now.getTime() - CONFIRM_RESEND_MS).toISOString();

	const inserted = await env.DB.prepare(
		`INSERT INTO subscribers (email, frequency, token, created_at, confirm_sent_at) VALUES (?1, ?2, ?3, ?4, ?4)
		 ON CONFLICT (email) DO NOTHING RETURNING ${SUBSCRIBER_COLUMNS}`,
	)
		.bind(email, frequency, randomToken(), at)
		.first<SubscriberRow>();
	if (inserted) return { send: 'confirm', sub: inserted, previousSentAt: null };

	const existing = await env.DB.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE email = ?`)
		.bind(email)
		.first<SubscriberRow>();
	if (!existing) return { send: 'none' };

	if (existing.unsubscribed_at) {
		const reset = await env.DB.prepare(
			`UPDATE subscribers SET token = ?1, frequency = ?2, created_at = ?3, confirm_sent_at = ?3,
			   confirmed_at = NULL, unsubscribed_at = NULL
			 WHERE id = ?4 AND unsubscribed_at IS NOT NULL RETURNING ${SUBSCRIBER_COLUMNS}`,
		)
			.bind(randomToken(), frequency, at, existing.id)
			.first<SubscriberRow>();
		return reset ? { send: 'confirm', sub: reset, previousSentAt: null } : { send: 'none' };
	}

	const claimed = await env.DB.prepare(
		`UPDATE subscribers SET confirm_sent_at = ?1,
		   frequency = CASE WHEN confirmed_at IS NULL THEN ?2 ELSE frequency END
		 WHERE id = ?3 AND unsubscribed_at IS NULL AND (confirm_sent_at IS NULL OR confirm_sent_at < ?4)
		 RETURNING ${SUBSCRIBER_COLUMNS}`,
	)
		.bind(at, frequency, existing.id, cutoff)
		.first<SubscriberRow>();
	if (!claimed) return { send: 'none' };
	return { send: claimed.confirmed_at ? 'already' : 'confirm', sub: claimed, previousSentAt: existing.confirm_sent_at };
}

/** Send the claimed email. Runs in waitUntil; never throws. Gives the slot back on transient failure. */
async function deliverSubscriptionEmail(env: Env, action: Exclude<SubscribeAction, { send: 'none' }>, status: Status): Promise<void> {
	try {
		const result =
			action.send === 'confirm' ? await sendConfirmation(env, action.sub, status) : await sendAlreadySubscribed(env, action.sub, status);
		if (result.ok) return;
		console.warn(`subscription email (${action.send}) not sent: ${result.code ?? 'unknown'}`);
		if (result.transient) {
			await env.DB.prepare('UPDATE subscribers SET confirm_sent_at = ? WHERE id = ? AND confirm_sent_at = ?')
				.bind(action.previousSentAt, action.sub.id, action.sub.confirm_sent_at)
				.run();
		}
	} catch (err) {
		console.error('subscription email failed:', err instanceof Error ? err.message : String(err));
	}
}

async function findSubscriber(env: Env, token: string): Promise<SubscriberRow | null> {
	if (!TOKEN_RE.test(token)) return null;
	return env.DB.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE token = ?`).bind(token).first<SubscriberRow>();
}

/** Look up a token; unknown tokens count against a per-IP limiter. */
async function lookup(c: Ctx): Promise<{ sub: SubscriberRow } | { response: Promise<Response> | Response }> {
	const sub = await findSubscriber(c.env, c.req.param('token') ?? '');
	if (sub) return { sub };
	if (!(await allow(c.env.RL_FORMS, `token-miss:${clientKey(c)}`))) return { response: renderTooMany(c) };
	return { response: renderTokenNotFound(c) };
}

async function reload(env: Env, id: number): Promise<SubscriberRow | null> {
	return env.DB.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE id = ?`).bind(id).first<SubscriberRow>();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

subscribeRoutes.get('/subscribe', (c) => renderSubscribePage(c));

subscribeRoutes.post('/subscribe', limitBody, async (c) => {
	const ip = clientIp(c);
	if (!(await allow(c.env.RL_FORMS, `subscribe:${clientKey(c)}`))) {
		return failSubscribe(c, 429, 'Steady on: too many sign-ups from your network. Try again in a minute.');
	}
	const fields = await readBody(c);
	if (!(await verifyTurnstile(c.env, fields['cf-turnstile-response'], ip))) {
		return failSubscribe(c, 403, "The robot check didn't pass. Please try again.", fields);
	}

	const email = normaliseEmail(fields.email ?? '');
	const frequency = (fields.frequency ?? 'big').trim() || 'big';
	if (!email) return failSubscribe(c, 400, 'Please enter an email address.', fields);
	if (email.length > EMAIL_MAX || !isValidEmail(email)) {
		return failSubscribe(c, 400, "That doesn't look like an email address. Please check it and try again.", fields);
	}
	if (!isFrequency(frequency)) return failSubscribe(c, 400, 'Please choose how often you would like to hear from us.', fields);
	if (isOwnDomain(email)) return failSubscribe(c, 400, `Nice try, but ${DOMAIN} already knows.`, fields);

	// Honeypot: bots get the same cheerful answer and nothing else.
	if ((fields.website ?? '').trim() !== '') return renderCheckInbox(c);

	const action = await upsertSubscriber(c.env, email, frequency);
	if (action.send !== 'none') c.executionCtx.waitUntil(deliverSubscriptionEmail(c.env, action, c.get('state').status));
	return renderCheckInbox(c);
});

/** GET /confirm: read-only. A pending address gets a button that POSTs; nothing changes here. */
function renderConfirmPrompt(c: Ctx, sub: SubscriberRow): Promise<Response> | Response {
	if (wantsJson(c)) return c.json({ ok: true, confirmed: false, state: 'pending', frequency: sub.frequency });
	const body = html`<div class="wrap section stack">
<header class="page-head">
<p class="kicker">One more click</p>
<h1>Confirm your subscription</h1>
<p class="lede">For <span class="mono">${maskEmail(sub.email)}</span>: ${FREQUENCY_COPY[sub.frequency].summary}.</p>
</header>
<form class="form" method="post" action="/confirm/${encodeURIComponent(sub.token)}"><button class="btn btn-primary" type="submit">Yes, keep me posted</button></form>
<p class="muted">Not you, or changed your mind? Just close this page: nothing is sent until the button is pressed.</p>
</div>`;
	return renderPage(c, { title: 'Confirm your subscription', body, noindex: true });
}

subscribeRoutes.get('/confirm/:token', async (c) => {
	privateHeaders(c);
	const found = await lookup(c);
	if ('response' in found) return found.response;
	const { sub } = found;

	if (sub.unsubscribed_at) {
		return renderManage(c, sub, { kind: 'error', message: 'This subscription was cancelled, so the confirmation link no longer applies.' });
	}
	if (sub.confirmed_at) return renderConfirmed(c, sub, false);
	return renderConfirmPrompt(c, sub);
});

subscribeRoutes.post('/confirm/:token', limitBody, async (c) => {
	privateHeaders(c);
	const found = await lookup(c);
	if ('response' in found) return found.response;
	const { sub } = found;
	if (!(await allow(c.env.RL_FORMS, `manage:${sub.id}`))) return renderTooMany(c);

	if (sub.unsubscribed_at) {
		return renderManage(c, sub, { kind: 'error', message: 'This subscription was cancelled, so the confirmation link no longer applies.' });
	}
	let newly = false;
	if (!sub.confirmed_at) {
		const res = await c.env.DB.prepare(
			'UPDATE subscribers SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL AND unsubscribed_at IS NULL',
		)
			.bind(nowIso(), sub.id)
			.run();
		newly = (res.meta.changes ?? 0) > 0;
	}
	return renderConfirmed(c, (await reload(c.env, sub.id)) ?? sub, newly);
});

subscribeRoutes.get('/unsubscribe/:token', async (c) => {
	privateHeaders(c);
	const found = await lookup(c);
	if ('response' in found) return found.response;
	return renderManage(c, found.sub);
});

// RFC 8058 one-click: mail providers POST "List-Unsubscribe=One-Click" (or nothing at all)
// with no cookies and no Turnstile. Anything without a recognised `action` unsubscribes.
subscribeRoutes.post('/unsubscribe/:token', limitBody, async (c) => {
	privateHeaders(c);
	const found = await lookup(c);
	if ('response' in found) return found.response;
	const { sub } = found;
	if (!(await allow(c.env.RL_FORMS, `manage:${sub.id}`))) return renderTooMany(c);

	const fields = await readBody(c);
	const action = fields.action ?? 'unsubscribe';

	if (action === 'frequency') {
		const frequency = (fields.frequency ?? '').trim();
		if (!isFrequency(frequency)) {
			return renderManage(c, sub, { kind: 'error', message: 'Please choose one of the two speeds.' }, 400);
		}
		if (sub.unsubscribed_at) {
			return renderManage(c, sub, { kind: 'error', message: "You're unsubscribed, so there's no speed to change." }, 409);
		}
		await c.env.DB.prepare('UPDATE subscribers SET frequency = ? WHERE id = ? AND unsubscribed_at IS NULL').bind(frequency, sub.id).run();
		const updated = (await reload(c.env, sub.id)) ?? sub;
		return renderManage(c, updated, { kind: 'ok', message: `Saved. From now on: ${FREQUENCY_COPY[updated.frequency].summary}.` });
	}

	if (action === 'resubscribe') {
		if (!sub.unsubscribed_at) return renderManage(c, sub, { kind: 'ok', message: "You're already subscribed. Nothing to do." });
		if (!sub.confirmed_at) {
			return renderManage(c, sub, { kind: 'error', message: 'This address was never confirmed. Please subscribe again from the form.' }, 409);
		}
		await c.env.DB.prepare('UPDATE subscribers SET unsubscribed_at = NULL WHERE id = ?').bind(sub.id).run();
		const updated = (await reload(c.env, sub.id)) ?? sub;
		return renderManage(c, updated, { kind: 'ok', message: 'Welcome back. We never doubted you.' });
	}

	await c.env.DB.prepare('UPDATE subscribers SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE id = ?').bind(nowIso(), sub.id).run();
	const updated = (await reload(c.env, sub.id)) ?? sub;
	return renderManage(c, updated, {
		kind: 'ok',
		message: sub.unsubscribed_at ? 'You were already unsubscribed. Still are.' : "Done. You're unsubscribed, and no more emails will be sent.",
	});
});
