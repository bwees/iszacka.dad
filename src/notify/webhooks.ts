// Outgoing webhooks: Discord, Slack, or generic signed JSON for people who want
// their smart lights to flash when Zack becomes a dad.
//
// Delivery is one POST with a 10s timeout and no redirects. A 404 or 410 means
// the hook is gone and it's disabled on the spot; anything else that isn't 2xx
// counts as a failure, and ten in a row disables it. A success resets the count
// (and revives a disabled hook, so a manual test can bring one back).

import { siteUrl, STATUS_COPY } from '../lib/site';
import { nowIso } from '../lib/time';
import type { Audience, DeliveryResult, Frequency, SiteState, Status, Update, WebhookKind, WebhookRow } from '../types';

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const MAX_WEBHOOK_FAILURES = 10;
export const MAX_ACTIVE_WEBHOOKS = 500;
export const MAX_WEBHOOK_URL_LENGTH = 2048;
export const WEBHOOK_USER_AGENT = 'iszacka.dad-webhooks/1.0 (+https://iszacka.dad/webhooks)';
export const WEBHOOK_KINDS: readonly WebhookKind[] = ['discord', 'slack', 'generic'];

/** Why a webhook is being sent. Real announcements are 'update'; the rest come from the manage page. */
export type WebhookEvent = 'update' | 'hello' | 'test' | 'goodbye';

export const KIND_LABEL: Record<WebhookKind, string> = {
	discord: 'Discord',
	slack: 'Slack',
	generic: 'generic JSON',
};

/** Discord embed colours per status. */
export const STATUS_COLOUR: Record<Status, number> = {
	no: 0x8a8f98,
	soon: 0xf5a524,
	yes: 0x30a46c,
};

// ── URL rules ────────────────────────────────────────────────────────────────

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/** Hostname suffixes that only make sense on somebody's private network. */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.localdomain', '.intranet'];

/**
 * Is this a URL we're willing to POST to from a Worker? HTTPS, a real public
 * hostname (no IP literals, no localhost/.local/.internal), no credentials, not
 * this site, and not absurdly long. Returns the parsed URL or a polite refusal.
 */
export function checkPublicHttpsUrl(
	raw: unknown,
	opts: { maxLength: number; ownHosts?: readonly string[] },
): UrlCheck {
	const fail = (error: string): UrlCheck => ({ ok: false, error });
	if (typeof raw !== 'string' || !raw.trim()) return fail('Please paste a URL.');
	const value = raw.trim();
	if (value.length > opts.maxLength) {
		return fail(`That URL is ${value.length} characters long. The limit is ${opts.maxLength}, which is already generous.`);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return fail("That doesn't look like a URL. It should start with https://");
	}
	if (url.protocol !== 'https:') return fail('HTTPS only, please. The stork does not fly unencrypted.');
	if (url.username || url.password) return fail('No usernames or passwords in the URL, please.');
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	if (!host) return fail('That URL is missing a hostname.');
	if (host.startsWith('[') || host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
		return fail('IP addresses are not allowed. Use a proper domain name.');
	}
	if (host === 'localhost' || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		return fail('Local and internal hostnames are not allowed. This Worker lives on the public internet.');
	}
	if (!host.includes('.')) return fail('That hostname needs to be a real, public domain name.');
	for (const own of opts.ownHosts ?? []) {
		const ownHost = own.toLowerCase();
		if (ownHost && (host === ownHost || host.endsWith(`.${ownHost}`))) {
			return fail('That URL points back at this site. Lovely idea, terrible loop.');
		}
	}
	if (url.href.length > opts.maxLength) return fail(`That URL is too long once tidied up (limit ${opts.maxLength}).`);
	return { ok: true, url };
}

/** The hostnames that count as "this site" (never a webhook target). */
export function ownHosts(env: Pick<Env, 'SITE_URL'>, requestUrl?: string): string[] {
	const hosts = new Set<string>(['iszacka.dad']);
	try {
		hosts.add(new URL(siteUrl(env)).hostname);
	} catch {
		// SITE_URL is malformed; the default domain is still covered.
	}
	if (requestUrl) {
		try {
			const host = new URL(requestUrl).hostname;
			// Local dev hosts are already refused as localhost/IPs; only add real names.
			if (host.includes('.') && !/^[\d.]+$/.test(host)) hosts.add(host);
		} catch {
			// Not a URL; nothing to add.
		}
	}
	return [...hosts];
}

/** Validate a webhook URL against the rules above. */
export function validateWebhookUrl(raw: unknown, hosts: readonly string[] = ['iszacka.dad']): UrlCheck {
	return checkPublicHttpsUrl(raw, { maxLength: MAX_WEBHOOK_URL_LENGTH, ownHosts: hosts });
}

/** Discord and Slack are recognised from the URL; everything else gets generic JSON. */
export function detectWebhookKind(input: string | URL): WebhookKind {
	let url: URL;
	try {
		url = typeof input === 'string' ? new URL(input) : input;
	} catch {
		return 'generic';
	}
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	const discordHost = /^((canary|ptb)\.)?(discord|discordapp)\.com$/.test(host);
	if (discordHost && /^\/api\/(v\d+\/)?webhooks\//i.test(url.pathname)) return 'discord';
	if (host === 'hooks.slack.com') return 'slack';
	return 'generic';
}

/** Form value → kind. 'auto' (or empty) means "work it out from the URL". */
export function parseKindChoice(value: unknown): WebhookKind | 'auto' | null {
	if (value === undefined || value === null || value === '' || value === 'auto') return 'auto';
	return typeof value === 'string' && (WEBHOOK_KINDS as readonly string[]).includes(value) ? (value as WebhookKind) : null;
}

export function parseFrequency(value: unknown): Frequency | null {
	if (value === undefined || value === null || value === '') return 'big';
	return value === 'big' || value === 'daily' ? value : null;
}

/** Show enough of a URL to recognise it without leaking its secret path (Discord/Slack tokens live there). */
export function maskWebhookUrl(raw: string): string {
	try {
		const url = new URL(raw);
		const segments = url.pathname.split('/').filter(Boolean);
		const shown = segments.slice(0, Math.max(segments.length - 1, 0));
		const last = segments.at(-1);
		// Long segments (tokens) keep a recognisable prefix; short ones are hidden entirely.
		const masked = !last ? '' : last.length >= 12 ? `${last.slice(0, 4)}${'•'.repeat(8)}` : '•'.repeat(6);
		const path = [...shown.map((s) => (s.length > 24 ? `${s.slice(0, 20)}…` : s)), masked].filter(Boolean).join('/');
		return `${url.protocol}//${url.host}/${path}${url.search ? '?…' : ''}`;
	} catch {
		return '(unparseable URL)';
	}
}

// ── Payloads ─────────────────────────────────────────────────────────────────

/** A one-off "update" for hello / test / goodbye messages (not stored; id 0). */
export function systemUpdate(state: SiteState, title: string, body: string, at: string = nowIso()): Update {
	return { id: 0, kind: 'system', title, body, status: state.status, audience: 'none', createdAt: at, notifiedAt: null };
}

/** Where a message should link to: the update's own page, or the homepage for one-offs. */
export function updateLink(base: string, update: Update): string {
	return update.id > 0 ? `${base}/updates/${update.id}` : `${base}/`;
}

function truncate(value: string, max: number): string {
	const chars = [...value];
	return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

function eventTitle(update: Update, event: WebhookEvent): string {
	return event === 'test' ? `[Test] ${update.title}` : update.title;
}

function bodyText(update: Update): string {
	return update.body.trim() || STATUS_COPY[update.status].sentence;
}

export interface DiscordPayload {
	username: string;
	avatar_url: string;
	content: string;
	allowed_mentions: { parse: string[] };
	embeds: Array<{
		title: string;
		description: string;
		url: string;
		color: number;
		timestamp: string;
		footer: { text: string };
	}>;
}

export function discordPayload(update: Update, base: string, event: WebhookEvent = 'update'): DiscordPayload {
	const copy = STATUS_COPY[update.status];
	const title = eventTitle(update, event);
	return {
		username: 'iszacka.dad',
		avatar_url: `${base}/icons/icon-192.png`,
		content: truncate(`${copy.emoji} ${title}`, 2000),
		// Nobody gets @everyone'd about this, however exciting it is.
		allowed_mentions: { parse: [] },
		embeds: [
			{
				title: truncate(title, 256),
				description: truncate(bodyText(update), 4096),
				url: updateLink(base, update),
				color: STATUS_COLOUR[update.status],
				timestamp: update.createdAt,
				footer: { text: truncate(`Is Zack a dad? ${copy.word} · iszacka.dad`, 2048) },
			},
		],
	};
}

/** Slack mrkdwn needs &, < and > escaped; everything else is literal. */
export function slackEscape(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface SlackPayload {
	text: string;
	blocks: Array<Record<string, unknown>>;
}

export function slackPayload(update: Update, base: string, event: WebhookEvent = 'update'): SlackPayload {
	const copy = STATUS_COPY[update.status];
	const title = eventTitle(update, event);
	const link = updateLink(base, update);
	return {
		text: truncate(`${copy.emoji} ${title}`, 3000),
		blocks: [
			{ type: 'header', text: { type: 'plain_text', text: truncate(`${copy.emoji} ${title}`, 150), emoji: true } },
			{ type: 'section', text: { type: 'mrkdwn', text: truncate(slackEscape(bodyText(update)), 3000) } },
			{
				type: 'context',
				elements: [
					{ type: 'mrkdwn', text: `Is Zack a dad? *${slackEscape(copy.word)}* · <${link}|iszacka.dad>` },
				],
			},
		],
	};
}

export interface GenericPayload {
	event: WebhookEvent;
	update: Update;
	state: SiteState;
	url: string;
	sentAt: string;
}

export function genericPayload(
	update: Update,
	state: SiteState,
	base: string,
	event: WebhookEvent = 'update',
	sentAt: string = nowIso(),
): GenericPayload {
	return { event, update, state, url: updateLink(base, update), sentAt };
}

/** `sha256=<hex HMAC-SHA256 of the raw body, keyed with the hook's token>`. */
export async function signWebhookBody(secret: string, body: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
	return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface WebhookRequest {
	body: string;
	headers: Record<string, string>;
}

/** The exact bytes and headers we'd send to a hook. */
export async function buildWebhookRequest(
	hook: Pick<WebhookRow, 'id' | 'kind' | 'token'>,
	update: Update,
	state: SiteState,
	base: string,
	event: WebhookEvent = 'update',
	sentAt: string = nowIso(),
): Promise<WebhookRequest> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'User-Agent': WEBHOOK_USER_AGENT,
	};
	let body: string;
	switch (hook.kind) {
		case 'discord':
			body = JSON.stringify(discordPayload(update, base, event));
			break;
		case 'slack':
			body = JSON.stringify(slackPayload(update, base, event));
			break;
		default: {
			body = JSON.stringify(genericPayload(update, state, base, event, sentAt));
			headers['X-Iszackadad-Event'] = event;
			headers['X-Iszackadad-Delivery'] = `${update.id}-${hook.id}-${Date.parse(sentAt) || 0}`;
			headers['X-Iszackadad-Signature'] = await signWebhookBody(hook.token, body);
		}
	}
	return { body, headers };
}

// ── Storage ──────────────────────────────────────────────────────────────────

/** Everything the manage page shows. */
export interface WebhookDetails extends WebhookRow {
	created_at: string;
	last_status: number | null;
	last_sent_at: string | null;
	disabled_at: string | null;
}

const ROW_COLUMNS = 'id, url, kind, frequency, token, failures';
const DETAIL_COLUMNS = `${ROW_COLUMNS}, created_at, last_status, last_sent_at, disabled_at`;

/** Active webhooks for an audience ('all' → every hook, 'daily' → frequency 'daily'), id > afterId, ascending. */
export async function listWebhookTargets(env: Env, audience: Audience, afterId: number, limit: number): Promise<WebhookRow[]> {
	if (audience === 'none') return [];
	const max = Math.min(Math.max(Math.floor(limit) || 1, 1), 500);
	const after = Number.isFinite(afterId) ? Math.max(Math.floor(afterId), 0) : 0;
	const frequency = audience === 'daily' ? " AND frequency = 'daily'" : '';
	const { results } = await env.DB.prepare(
		`SELECT ${ROW_COLUMNS} FROM webhooks WHERE disabled_at IS NULL AND id > ?${frequency} ORDER BY id ASC LIMIT ?`,
	)
		.bind(after, max)
		.all<WebhookRow>();
	return results;
}

export async function getWebhookByToken(env: Env, token: string): Promise<WebhookDetails | null> {
	if (!isWebhookToken(token)) return null;
	return env.DB.prepare(`SELECT ${DETAIL_COLUMNS} FROM webhooks WHERE token = ?`).bind(token).first<WebhookDetails>();
}

export function isWebhookToken(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(value);
}

// ── Delivery ─────────────────────────────────────────────────────────────────

export interface WebhookSendResult extends DeliveryResult {
	/** HTTP status, or 0 if there was no response (timeout / network). */
	status: number;
	/** True if this attempt disabled the hook. */
	disabled?: boolean;
}

/** What a POST came to: the HTTP status (0 for no response) and a human-readable detail. */
interface Posted {
	status: number;
	detail: string;
}

/** POST one message (no redirects, with a timeout). Never throws. */
async function postWebhook(hook: Pick<WebhookRow, 'url'>, request: WebhookRequest): Promise<Posted> {
	try {
		const res = await fetch(hook.url, {
			method: 'POST',
			headers: request.headers,
			body: request.body,
			redirect: 'manual',
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
		});
		return { status: res.status, detail: await describeResponse(res) };
	} catch (err) {
		return { status: 0, detail: describeError(err) };
	}
}

type Verdict = 'ok' | 'gone' | 'fail';

function verdictFor(status: number): Verdict {
	if (status >= 200 && status < 300) return 'ok';
	if (status === 404 || status === 410) return 'gone';
	return 'fail';
}

/** The bookkeeping UPDATE for one POST. 'fail' RETURNs the new failure count and disabled_at. */
function bookkeepingStatement(env: Env, hookId: number, verdict: Verdict, status: number, sentAt: string): D1PreparedStatement {
	if (verdict === 'ok') {
		return env.DB.prepare('UPDATE webhooks SET failures = 0, last_status = ?, last_sent_at = ?, disabled_at = NULL WHERE id = ?').bind(
			status,
			sentAt,
			hookId,
		);
	}
	if (verdict === 'gone') {
		return env.DB.prepare(
			'UPDATE webhooks SET failures = failures + 1, last_status = ?, last_sent_at = ?, disabled_at = COALESCE(disabled_at, ?) WHERE id = ?',
		).bind(status, sentAt, sentAt, hookId);
	}
	return env.DB.prepare(
		`UPDATE webhooks SET failures = failures + 1, last_status = ?, last_sent_at = ?,
		 disabled_at = CASE WHEN failures + 1 >= ? THEN COALESCE(disabled_at, ?) ELSE disabled_at END
		 WHERE id = ? RETURNING failures, disabled_at`,
	).bind(status, sentAt, MAX_WEBHOOK_FAILURES, sentAt, hookId);
}

/** The result for one POST, given its verdict and (for failures) the row the bookkeeping returned. */
function sendResult(
	verdict: Verdict,
	posted: Posted,
	account: boolean,
	row: { failures: number; disabled_at: string | null } | null,
): WebhookSendResult {
	const { status, detail } = posted;
	if (verdict === 'ok') return { ok: true, status, detail };
	if (verdict === 'gone') return { ok: false, gone: true, disabled: account, status, detail: `${detail}: the webhook is gone, so it's been disabled` };
	if (!account) return { ok: false, status, detail };
	if (row && row.failures >= MAX_WEBHOOK_FAILURES) {
		return { ok: false, status, disabled: true, detail: `${detail} (failure ${row.failures}; disabled after ${MAX_WEBHOOK_FAILURES} in a row)` };
	}
	return { ok: false, status, detail: row ? `${detail} (failure ${row.failures} of ${MAX_WEBHOOK_FAILURES})` : detail };
}

/**
 * POST one message and keep the books (failures, last status, disabling). Never
 * throws. `account: false` skips the bookkeeping (used for the goodbye message,
 * whose row no longer exists).
 */
export async function sendWebhook(
	env: Env,
	hook: Pick<WebhookRow, 'id' | 'url' | 'kind' | 'token'>,
	update: Update,
	state: SiteState,
	opts: { event?: WebhookEvent; account?: boolean } = {},
): Promise<WebhookSendResult> {
	const event = opts.event ?? 'update';
	const account = opts.account ?? true;
	const sentAt = nowIso();
	let posted: Posted;
	try {
		posted = await postWebhook(hook, await buildWebhookRequest(hook, update, state, siteUrl(env), event, sentAt));
	} catch (err) {
		posted = { status: 0, detail: describeError(err) };
	}
	const verdict = verdictFor(posted.status);
	let row: { failures: number; disabled_at: string | null } | null = null;
	if (account) {
		try {
			row = await bookkeepingStatement(env, hook.id, verdict, posted.status, sentAt).first<{ failures: number; disabled_at: string | null }>();
		} catch (err) {
			console.error('webhook bookkeeping failed:', err);
		}
	}
	return sendResult(verdict, posted, account, row);
}

/** POST one webhook. Never throws; disables hooks that are gone or keep failing. */
export async function deliverWebhook(env: Env, hook: WebhookRow, update: Update, state: SiteState): Promise<DeliveryResult> {
	const [result] = await deliverWebhookBatch(env, [hook], update, state);
	return result ?? { ok: false, detail: 'unexpected error: no result' };
}

/** Simultaneous POSTs per batch: Workers allows six open connections per invocation. */
const WEBHOOK_CONCURRENCY = 6;

/**
 * POST an update to a batch of hooks (at most WEBHOOK_CONCURRENCY at a time), then keep the
 * books for all of them in one D1 batch. Discord and Slack bodies are the same for every hook,
 * so each is built once. Never throws; one result per hook, in order.
 */
export async function deliverWebhookBatch(
	env: Env,
	hooks: readonly WebhookRow[],
	update: Update,
	state: SiteState,
): Promise<DeliveryResult[]> {
	const base = siteUrl(env);
	const sentAt = nowIso();
	const shared = new Map<WebhookKind, Promise<WebhookRequest>>();
	const requestFor = (hook: WebhookRow): Promise<WebhookRequest> => {
		if (hook.kind === 'generic') return buildWebhookRequest(hook, update, state, base, 'update', sentAt);
		let request = shared.get(hook.kind);
		if (!request) shared.set(hook.kind, (request = buildWebhookRequest(hook, update, state, base, 'update', sentAt)));
		return request;
	};

	const posted: Posted[] = new Array(hooks.length);
	let next = 0;
	const worker = async () => {
		while (next < hooks.length) {
			const i = next++;
			const hook = hooks[i] as WebhookRow;
			try {
				posted[i] = await postWebhook(hook, await requestFor(hook));
			} catch (err) {
				posted[i] = { status: 0, detail: describeError(err) };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(WEBHOOK_CONCURRENCY, hooks.length) }, worker));

	const verdicts = posted.map((p) => verdictFor(p.status));
	let rows: Array<{ failures: number; disabled_at: string | null } | null> = hooks.map(() => null);
	if (hooks.length) {
		try {
			const written = await env.DB.batch<{ failures: number; disabled_at: string | null }>(
				hooks.map((hook, i) => bookkeepingStatement(env, hook.id, verdicts[i] as Verdict, (posted[i] as Posted).status, sentAt)),
			);
			rows = written.map((r) => r?.results[0] ?? null);
		} catch (err) {
			console.error('webhook bookkeeping failed:', err);
		}
	}
	return hooks.map((_, i) => {
		const { ok, gone, detail } = sendResult(verdicts[i] as Verdict, posted[i] as Posted, true, rows[i] ?? null);
		return gone ? { ok, gone, detail } : { ok, detail };
	});
}

async function describeResponse(res: Response): Promise<string> {
	const label = `HTTP ${res.status}`;
	if (res.status >= 300 && res.status < 400) {
		await res.body?.cancel();
		return `${label}: redirected to somewhere else (we don't follow redirects)`;
	}
	if (res.ok) {
		await res.body?.cancel();
		return label;
	}
	const text = await readBodySnippet(res);
	return text ? `${label}: ${truncate(text, 160)}` : label;
}

/**
 * The first few KB of a response body as tidy text, for error details. Reads no
 * more than `maxBytes`, so an endpoint answering with a gigabyte of HTML can't
 * take the Worker's memory down with it. Never throws.
 */
export async function readBodySnippet(res: Response, maxBytes = 2048): Promise<string> {
	if (!res.body) return '';
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < maxBytes) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} catch {
		// A broken body is still a body; use what arrived.
	} finally {
		reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(Math.min(size, maxBytes));
	let offset = 0;
	for (const chunk of chunks) {
		const take = chunk.subarray(0, bytes.length - offset);
		bytes.set(take, offset);
		offset += take.length;
		if (offset >= bytes.length) break;
	}
	return new TextDecoder().decode(bytes).replace(/\uFFFD+$/, '').replace(/\s+/g, ' ').trim();
}

function describeError(err: unknown): string {
	if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
		return `no response within ${WEBHOOK_TIMEOUT_MS / 1000}s`;
	}
	return `request failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
}
