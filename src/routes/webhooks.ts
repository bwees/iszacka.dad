// Webhooks: register (POST /webhooks), manage (GET /webhooks/:token), test and
// delete. The token in the management URL is the only key: whoever has the link
// can test or delete the hook, and generic hooks use it as their signing secret.

import type { Context } from 'hono';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { type Html, renderPage } from '../lib/layout';
import { allow, clientIp, clientKey, randomToken, turnstileEnabled, turnstileWidget, verifyTurnstile, wantsJson } from '../lib/security';
import { siteUrl, STATUS_COPY } from '../lib/site';
import { formatLondon, nowIso } from '../lib/time';
import {
	detectWebhookKind,
	genericPayload,
	getWebhookByToken,
	isWebhookToken,
	KIND_LABEL,
	MAX_ACTIVE_WEBHOOKS,
	MAX_WEBHOOK_FAILURES,
	MAX_WEBHOOK_URL_LENGTH,
	maskWebhookUrl,
	ownHosts,
	parseFrequency,
	parseKindChoice,
	sendWebhook,
	systemUpdate,
	validateWebhookUrl,
	type WebhookDetails,
	type WebhookSendResult,
} from '../notify/webhooks';
import type { AppEnv, Frequency, SiteState, WebhookKind } from '../types';

export const webhookRoutes = new Hono<AppEnv>();

/** Generous for a URL, two selects and a Turnstile token. */
const MAX_FORM_BYTES = 16 * 1024;

const FREQUENCY_LABEL: Record<Frequency, string> = {
	big: 'Big news only',
	daily: 'Big news, plus the daily "still no"',
};

interface FormValues {
	url?: string;
	kind?: string;
	frequency?: string;
}

/** Webhook registration form fragment, embedded by /everything. Posts to /webhooks. */
export function webhookForm(c: Context<AppEnv>) {
	return registrationForm(c, {});
}

function registrationForm(c: Context<AppEnv>, values: FormValues) {
	const kind = values.kind ?? 'auto';
	const frequency = values.frequency ?? 'big';
	const option = (value: string, label: string, current: string) =>
		html`<option value="${value}"${current === value ? html` selected` : ''}>${label}</option>`;
	return html`<form class="form stack webhook-form" method="post" action="/webhooks">
	<div class="field">
		<label for="webhook-url">Webhook URL</label>
		<input id="webhook-url" name="url" type="url" inputmode="url" required maxlength="${MAX_WEBHOOK_URL_LENGTH}"
			autocomplete="off" spellcheck="false" placeholder="https://discord.com/api/webhooks/…" value="${values.url ?? ''}"
			aria-describedby="webhook-url-hint">
		<p class="hint" id="webhook-url-hint">A Discord or Slack incoming webhook, or any HTTPS endpoint that accepts JSON.</p>
	</div>
	<div class="field-row">
		<div class="field">
			<label for="webhook-kind">Format</label>
			<select id="webhook-kind" name="kind">
				${option('auto', 'Work it out from the URL', kind)} ${option('discord', 'Discord', kind)}
				${option('slack', 'Slack', kind)} ${option('generic', 'Generic JSON (signed)', kind)}
			</select>
		</div>
		<div class="field">
			<label for="webhook-frequency">How often</label>
			<select id="webhook-frequency" name="frequency">
				${option('big', FREQUENCY_LABEL.big, frequency)} ${option('daily', FREQUENCY_LABEL.daily, frequency)}
			</select>
		</div>
	</div>
	${turnstileWidget(c.env)}
	<div class="cluster">
		<button type="submit" class="btn btn-primary">Add webhook</button>
		<a class="btn btn-ghost" href="/webhooks">How it works</a>
	</div>
</form>`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Secret pages: never cached, never leaked via Referer, never indexed. */
function secretHeaders(c: Context<AppEnv>): void {
	c.header('Cache-Control', 'no-store');
	c.header('Referrer-Policy', 'no-referrer');
	c.header('X-Robots-Tag', 'noindex');
}

function manageUrl(c: Context<AppEnv>, token: string): string {
	return `${new URL(c.req.url).origin}/webhooks/${token}`;
}

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
	try {
		if ((c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
			const value: unknown = await c.req.json();
			return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
		}
		return (await c.req.parseBody()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value.trim() : undefined);

function describeLastStatus(status: number | null): string {
	if (status === null) return 'Never sent';
	if (status === 0) return 'No response';
	return `HTTP ${status}`;
}

function sampleState(state: SiteState): SiteState {
	return { status: state.status, statusChangedAt: state.statusChangedAt, dueDate: state.dueDate };
}

// ── Pages ────────────────────────────────────────────────────────────────────

function genericDocs(c: Context<AppEnv>, token: string | null) {
	const state = sampleState(c.get('state'));
	const copy = STATUS_COPY.yes;
	const example = genericPayload(
		{
			id: 42,
			kind: 'status',
			title: copy.headline,
			body: copy.sentence,
			status: 'yes',
			audience: 'all',
			createdAt: '2026-11-20T03:14:15.926Z',
			notifiedAt: null,
		},
		{ ...state, status: 'yes', statusChangedAt: '2026-11-20T03:14:15.926Z' },
		siteUrl(c.env),
		'update',
		'2026-11-20T03:15:16.000Z',
	);
	const secret = token ?? '<the token at the end of your management link>';
	const verify = `import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the request body exactly as received (a Buffer or string), before JSON.parse.
function isFromTheStork(rawBody, signatureHeader) {
  const expected = 'sha256=' + createHmac('sha256', ${JSON.stringify(secret)}).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}`;
	return html`<section class="card stack" aria-labelledby="generic-docs">
	<h2 class="card-title" id="generic-docs">Generic JSON webhooks</h2>
	<p>We <code>POST</code> a JSON body with these headers:</p>
	<dl class="stack">
		<div><dt><code>Content-Type</code></dt><dd><code>application/json</code></dd></div>
		<div><dt><code>X-Iszackadad-Event</code></dt><dd><code>update</code> for real news; <code>hello</code>, <code>test</code> or <code>goodbye</code> for housekeeping. Only act on <code>update</code>.</dd></div>
		<div><dt><code>X-Iszackadad-Signature</code></dt><dd><code>sha256=&lt;hex&gt;</code>: an HMAC-SHA256 of the raw body, keyed with your webhook's token.</dd></div>
		<div><dt><code>X-Iszackadad-Delivery</code></dt><dd>A delivery id, for de-duplicating if you're that sort of person.</dd></div>
	</dl>
	<p>The body looks like this (<code>state.status</code> is <code>no</code>, <code>soon</code> or <code>yes</code>):</p>
	<pre class="code"><code>${JSON.stringify(example, null, 2)}</code></pre>
	<p>Check the signature before believing a word of it. In Node:</p>
	<pre class="code"><code>${verify}</code></pre>
	<p class="muted tiny">Reply with any 2xx within 10 seconds. A 404 or 410 unsubscribes you on the spot. Anything else counts as a failure, and ${MAX_WEBHOOK_FAILURES} in a row switches the webhook off. Redirects aren't followed.</p>
</section>`;
}

async function formPage(c: Context<AppEnv>, values: FormValues, error?: string, status = 200): Promise<Response> {
	const body = html`<div class="wrap section stack">
	<header class="page-head">
		<p class="kicker">Webhooks</p>
		<h1>Tell your group chat the moment Zack is a dad</h1>
		<p class="lede">Point us at a Discord channel, a Slack channel or your own server, and we'll post there when labour starts and when the baby arrives. Optionally, every day until then, to confirm that nothing has happened.</p>
	</header>
	${error ? html`<div class="notice notice-error" role="alert"><p>${error}</p></div>` : ''}
	<section class="card stack" aria-labelledby="add-webhook">
		<h2 class="card-title" id="add-webhook">Add a webhook</h2>
		${registrationForm(c, values)}
		<p class="muted tiny">You'll get a secret management link to test or delete it. At most ${MAX_ACTIVE_WEBHOOKS} webhooks, so the stork doesn't get repetitive strain injury.</p>
	</section>
	<section class="card stack" aria-labelledby="formats">
		<h2 class="card-title" id="formats">Formats</h2>
		<ul>
			<li><strong>Discord</strong> (<code>discord.com/api/webhooks/…</code>): a message with an embed, coloured by the answer. Nobody gets pinged.</li>
			<li><strong>Slack</strong> (<code>hooks.slack.com/…</code>): a message with a header and the details.</li>
			<li><strong>Generic JSON</strong>: anything else. Signed, so you can tell it's really us.</li>
		</ul>
	</section>
	${genericDocs(c, null)}
</div>`;
	return renderPage(c, {
		title: 'Webhooks',
		description: 'Get a Discord, Slack or JSON webhook the moment Zack is a dad.',
		body,
		path: '/webhooks',
		turnstile: turnstileEnabled(c.env),
		status,
	});
}

function helloNotice(result: WebhookSendResult) {
	if (result.ok) {
		return html`<div class="notice notice-ok"><p>We sent a hello message and it was accepted (${result.detail}). Have a look.</p></div>`;
	}
	return html`<div class="notice notice-error"><p>We sent a hello message but it didn't go through (${result.detail}). We'll keep trying with real news; use the Test button once it's sorted.</p></div>`;
}

function managePage(c: Context<AppEnv>, hook: WebhookDetails, notice?: Html, status = 200): Promise<Response> {
	secretHeaders(c);
	const active = hook.disabled_at === null;
	const kind = hook.kind as WebhookKind;
	const body = html`<div class="wrap section stack">
	<header class="page-head">
		<p class="kicker">Webhook management</p>
		<h1>Your ${KIND_LABEL[kind]} webhook</h1>
		<p class="lede">This page's address is the only key to this webhook. Bookmark it; don't share it.</p>
	</header>
	${notice ?? ''}
	<section class="card stack" aria-labelledby="hook-status">
		<h2 class="card-title" id="hook-status">Status
			${active ? html`<span class="badge badge-yes">Active</span>` : html`<span class="badge badge-no">Disabled</span>`}</h2>
		${active
			? ''
			: html`<p>Switched off on ${formatLondon(hook.disabled_at as string)} after ${hook.last_status === 404 || hook.last_status === 410 ? 'the other end said it no longer exists' : `${hook.failures} failed deliveries`}. A successful test switches it back on.</p>`}
		<div class="stats">
			<div class="stat"><span class="stat-value">${hook.failures}</span><span class="stat-label">failures in a row (limit ${MAX_WEBHOOK_FAILURES})</span></div>
			<div class="stat"><span class="stat-value">${describeLastStatus(hook.last_status)}</span><span class="stat-label">last response</span></div>
			<div class="stat"><span class="stat-value">${hook.last_sent_at ? formatLondon(hook.last_sent_at) : 'Never'}</span><span class="stat-label">last sent</span></div>
		</div>
		<div class="table-wrap"><table class="table">
			<tbody>
				<tr><th scope="row">URL</th><td class="mono">${maskWebhookUrl(hook.url)}</td></tr>
				<tr><th scope="row">Format</th><td>${KIND_LABEL[kind]}</td></tr>
				<tr><th scope="row">Frequency</th><td>${FREQUENCY_LABEL[hook.frequency]}</td></tr>
				<tr><th scope="row">Added</th><td>${formatLondon(hook.created_at)}</td></tr>
			</tbody>
		</table></div>
	</section>
	<section class="card stack" aria-labelledby="hook-actions">
		<h2 class="card-title" id="hook-actions">Do something</h2>
		<form class="form" method="post" action="/webhooks/${hook.token}/test">
			<p>Send a test message with the current answer${active ? '' : ' (and switch the webhook back on if it works)'}.</p>
			<button type="submit" class="btn btn-primary">Send a test</button>
		</form>
		<form class="form stack" method="post" action="/webhooks/${hook.token}/delete">
			<p>Delete the webhook. This channel will have to find out like everyone else.</p>
			<label class="cluster"><input type="checkbox" name="confirm" value="yes" required> Yes, delete it</label>
			<div><button type="submit" class="btn btn-danger">Delete webhook</button></div>
		</form>
	</section>
	${kind === 'generic' ? genericDocs(c, hook.token) : ''}
</div>`;
	// path: never put the token in canonical/og:url, even on a noindex page.
	return renderPage(c, { title: 'Manage webhook', body, path: '/webhooks', noindex: true, status });
}

async function notFoundPage(c: Context<AppEnv>): Promise<Response> {
	secretHeaders(c);
	if (wantsJson(c)) return c.json({ ok: false, error: 'No webhook with that link. It may have been deleted.' }, 404);
	const body = html`<div class="wrap section stack">
	<header class="page-head">
		<h1>No such webhook</h1>
		<p class="lede">That management link doesn't match a webhook. It may have been deleted, or the link got mangled on the way here.</p>
	</header>
	<p><a class="btn" href="/webhooks">Add a new one</a></p>
</div>`;
	return renderPage(c, { title: 'No such webhook', body, path: '/webhooks', noindex: true, status: 404 });
}

// ── Routes ───────────────────────────────────────────────────────────────────

webhookRoutes.get('/webhooks', (c) => formPage(c, {}));

webhookRoutes.post('/webhooks', async (c) => {
	c.header('Cache-Control', 'no-store');
	const json = wantsJson(c);
	const ip = clientIp(c);
	const reject = (error: string, status: 400 | 403 | 409 | 429 | 503, values: FormValues) =>
		json ? c.json({ ok: false, error }, status) : formPage(c, values, error, status);

	if (!(await allow(c.env.RL_FORMS, `webhook:${clientKey(c)}`))) {
		return reject('Too many attempts. Have a cup of tea and try again in a minute.', 429, {});
	}
	if (Number(c.req.header('content-length') ?? '0') > MAX_FORM_BYTES) {
		return reject('That is a remarkably large form submission. A URL and two choices will do.', 400, {});
	}
	const body = await readBody(c);
	const values: FormValues = {
		url: str(body.url)?.slice(0, MAX_WEBHOOK_URL_LENGTH + 100),
		kind: str(body.kind),
		frequency: str(body.frequency),
	};
	if (!(await verifyTurnstile(c.env, body['cf-turnstile-response'], ip))) {
		return reject("The robot check didn't pass. Please try again.", 403, values);
	}

	const url = validateWebhookUrl(body.url, ownHosts(c.env, c.req.url));
	if (!url.ok) return reject(url.error, 400, values);
	const kindChoice = parseKindChoice(values.kind);
	if (kindChoice === null) return reject('Pick a format: Discord, Slack, generic JSON or automatic.', 400, values);
	const frequency = parseFrequency(values.frequency);
	if (frequency === null) return reject('Pick how often: big news only, or daily.', 400, values);
	const kind: WebhookKind = kindChoice === 'auto' ? detectWebhookKind(url.url) : kindChoice;
	const href = url.url.href;

	const existing = await c.env.DB.prepare('SELECT id, disabled_at FROM webhooks WHERE url = ?')
		.bind(href)
		.first<{ id: number; disabled_at: string | null }>();
	if (existing && existing.disabled_at === null) {
		return reject(
			"That webhook is already on the list. Lost its management link? Delete the webhook on the Discord/Slack side (we'll notice and tidy up) or make a new one.",
			409,
			values,
		);
	}
	const active = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM webhooks WHERE disabled_at IS NULL').first<{ n: number }>();
	if ((active?.n ?? 0) >= MAX_ACTIVE_WEBHOOKS) {
		return reject(`The stork's list is full (${MAX_ACTIVE_WEBHOOKS} webhooks). Email and feeds still have room.`, 503, values);
	}

	// Say hello first: a 404/410 means a typo'd URL, which shouldn't be stored at all.
	const token = randomToken();
	const state = c.get('state');
	const copy = STATUS_COPY[state.status];
	const hello = await sendWebhook(
		c.env,
		{ id: 0, url: href, kind, token },
		systemUpdate(
			state,
			'Hello from iszacka.dad 👋',
			`This ${KIND_LABEL[kind]} webhook is now on the stork's list. It will get ${frequency === 'daily' ? 'every update, including a daily "still no"' : 'the big news only: labour starting, and Zack becoming a dad'}. For now: ${copy.sentence}`,
		),
		state,
		{ event: 'hello', account: false },
	);
	if (hello.gone) {
		return reject(
			`We said hello and the other end says that webhook doesn't exist (HTTP ${hello.status}). Check the URL and try again.`,
			400,
			values,
		);
	}

	let id: number;
	try {
		const at = nowIso();
		// A disabled hook with the same URL is replaced: its old link stops working.
		const statements = [
			...(existing ? [c.env.DB.prepare('DELETE FROM webhooks WHERE id = ? AND disabled_at IS NOT NULL').bind(existing.id)] : []),
			c.env.DB.prepare(
				`INSERT INTO webhooks (url, kind, frequency, token, created_at, failures, last_status, last_sent_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
			).bind(href, kind, frequency, token, at, hello.ok ? 0 : 1, hello.status, at),
		];
		const results = await c.env.DB.batch<{ id: number }>(statements);
		const inserted = results.at(-1)?.results[0]?.id;
		if (typeof inserted !== 'number') throw new Error('insert returned no id');
		id = inserted;
	} catch (err) {
		if (String(err).includes('UNIQUE')) return reject('That webhook was added a moment ago. Check its channel for the hello.', 409, values);
		throw err;
	}

	const link = manageUrl(c, token);
	secretHeaders(c);
	if (json) {
		return c.json(
			{ ok: true, id, kind, frequency, token, manageUrl: link, hello: { ok: hello.ok, detail: hello.detail ?? null } },
			201,
		);
	}
	const page = html`<div class="wrap section stack">
	<header class="page-head">
		<p class="kicker">Webhook added</p>
		<h1>You're on the list</h1>
		<p class="lede">This ${KIND_LABEL[kind]} webhook will hear about it ${frequency === 'daily' ? 'every day until the big news, and then the big news' : 'when labour starts and when Zack is a dad'}.</p>
	</header>
	<section class="card stack" aria-labelledby="save-this">
		<h2 class="card-title" id="save-this">Save this link</h2>
		<p>It's the only way to test or delete the webhook, and we'll only show it once.${kind === 'generic' ? ' Its token is also your signing secret.' : ''}</p>
		<pre class="code"><code>${link}</code></pre>
		<p><a class="btn btn-primary" href="/webhooks/${token}">Open the management page</a></p>
	</section>
	${helloNotice(hello)}
</div>`;
	return renderPage(c, { title: 'Webhook added', body: page, path: '/webhooks', noindex: true, status: 201 });
});

/**
 * After a test or a refused delete (no JS), the page is reached by a 303 to its own address,
 * so the address bar keeps the bookmarkable link. Outcomes are fixed keys, never free text.
 */
const MANAGE_NOTICES: Readonly<Record<string, { kind: 'ok' | 'error'; text: string }>> = {
	ok: { kind: 'ok', text: 'Test sent and accepted.' },
	'ok-on': { kind: 'ok', text: 'Test sent and accepted. The webhook is switched back on.' },
	failed: { kind: 'error', text: "The test didn't go through. The last response below says what the other end answered." },
	rate: { kind: 'error', text: 'Too many attempts. The stork needs a breather; try again in a minute.' },
	confirm: { kind: 'error', text: 'Tick "Yes, delete it" first. We like to be sure.' },
};

function manageNotice(c: Context<AppEnv>): Html | undefined {
	const key = c.req.query('test') ?? c.req.query('error');
	if (!key || !Object.hasOwn(MANAGE_NOTICES, key)) return undefined;
	const notice = MANAGE_NOTICES[key] as { kind: 'ok' | 'error'; text: string };
	return notice.kind === 'ok'
		? html`<div class="notice notice-ok" role="status"><p>${notice.text}</p></div>`
		: html`<div class="notice notice-error" role="alert"><p>${notice.text}</p></div>`;
}

/** 303 back to the management page, with a fixed outcome key. */
function backToManage(c: Context<AppEnv>, token: string, query: string): Response {
	secretHeaders(c);
	return c.redirect(`/webhooks/${token}?${query}`, 303);
}

webhookRoutes.get('/webhooks/:token', async (c) => {
	const hook = await getWebhookByToken(c.env, c.req.param('token'));
	if (!hook) return notFoundPage(c);
	if (wantsJson(c)) {
		secretHeaders(c);
		return c.json({
			ok: true,
			kind: hook.kind,
			frequency: hook.frequency,
			url: maskWebhookUrl(hook.url),
			active: hook.disabled_at === null,
			failures: hook.failures,
			lastStatus: hook.last_status,
			lastSentAt: hook.last_sent_at,
			createdAt: hook.created_at,
			disabledAt: hook.disabled_at,
		});
	}
	return managePage(c, hook, manageNotice(c));
});

// Test and delete are POST-only actions; their addresses aren't pages. A bookmark or a stray
// GET goes back to the management page rather than a 404 (and never sends anything).
for (const action of ['test', 'delete']) {
	webhookRoutes.get(`/webhooks/:token/${action}`, async (c) => {
		const token = c.req.param('token');
		if (!isWebhookToken(token)) return notFoundPage(c);
		secretHeaders(c);
		return c.redirect(`/webhooks/${token}`, 303);
	});
}

webhookRoutes.post('/webhooks/:token/test', async (c) => {
	const token = c.req.param('token');
	if (!isWebhookToken(token)) return notFoundPage(c);
	if (!(await allow(c.env.RL_FORMS, `webhook-test:${clientKey(c)}`))) {
		const error = 'Too many tests. The stork needs a breather; try again in a minute.';
		if (wantsJson(c)) return c.json({ ok: false, error }, 429);
		return backToManage(c, token, 'error=rate');
	}
	const hook = await getWebhookByToken(c.env, token);
	if (!hook) return notFoundPage(c);
	const state = c.get('state');
	const result = await sendWebhook(
		c.env,
		hook,
		systemUpdate(state, 'Test message', `If you can read this, the webhook works. The current answer: ${STATUS_COPY[state.status].sentence}`),
		state,
		{ event: 'test' },
	);
	if (wantsJson(c)) {
		secretHeaders(c);
		return c.json({ ok: result.ok, status: result.status, detail: result.detail ?? null, disabled: result.disabled === true }, result.ok ? 200 : 502);
	}
	// Post/redirect/get: the address bar stays on the bookmarkable link, and a refresh doesn't
	// send another test. The response detail isn't put in the URL; "last response" shows it.
	return backToManage(c, token, `test=${result.ok ? (hook.disabled_at ? 'ok-on' : 'ok') : 'failed'}`);
});

webhookRoutes.post('/webhooks/:token/delete', async (c) => {
	const token = c.req.param('token');
	if (!isWebhookToken(token)) return notFoundPage(c);
	const json = wantsJson(c);
	if (!(await allow(c.env.RL_FORMS, `webhook-delete:${clientKey(c)}`))) {
		const error = 'Too many attempts. Try again in a minute.';
		if (json) return c.json({ ok: false, error }, 429);
		return backToManage(c, token, 'error=rate');
	}
	const hook = await getWebhookByToken(c.env, token);
	if (!hook) return notFoundPage(c);
	if (!json) {
		const body = await readBody(c);
		if (body.confirm !== 'yes') return backToManage(c, token, 'error=confirm');
	}
	await c.env.DB.prepare('DELETE FROM webhooks WHERE id = ?').bind(hook.id).run();

	// A farewell, if it was still working. Best effort; the row is already gone.
	if (hook.disabled_at === null) {
		const state = c.get('state');
		c.executionCtx.waitUntil(
			sendWebhook(
				c.env,
				hook,
				systemUpdate(
					state,
					'Goodbye from iszacka.dad',
					"This webhook has been removed. You'll have to find out whether Zack is a dad the old-fashioned way: by refreshing the website.",
				),
				state,
				{ event: 'goodbye', account: false },
			),
		);
	}

	secretHeaders(c);
	if (json) return c.json({ ok: true, deleted: true });
	const body = html`<div class="wrap section stack">
	<header class="page-head">
		<p class="kicker">Webhook deleted</p>
		<h1>Deleted</h1>
		<p class="lede">That webhook won't hear from us again${hook.disabled_at === null ? ', apart from a short goodbye' : ''}. The management link no longer works.</p>
	</header>
	<p><a class="btn" href="/">Back to the answer</a> <a class="btn btn-ghost" href="/webhooks">Add another</a></p>
</div>`;
	return renderPage(c, { title: 'Webhook deleted', body, path: '/webhooks', noindex: true });
});
