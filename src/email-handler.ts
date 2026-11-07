// OWNER: email agent.
// Inbound email (Resend receiving → signed webhook → InboundWorkflow): auto-reply with the
// answer, or enter a baby-pool guess sent by email ("guess" in the subject, "14 Nov 15:30" in
// the body). This module holds what each workflow step does; src/workflows/inbound.ts runs them.
//
//   fetchReceivedEmail  GET /emails/receiving/{id}, trimmed to what the later steps read
//   decideInbound       loop protection, authentication, quota, rate limits, guess parsing
//   enterGuess          the pool insert (only for a guess that parsed)
//   sendInboundReply    render and send, one reply per received email (idempotency key)
//   recordInbound       inbound_emails + the received email's quota count, exactly once
//
// Never replies to robots, mailing lists, bounces or ourselves (RFC 3834), and caps replies per
// sender per minute (RL_EMAIL) and per day (inbound_emails), so a broken auto-responder can't
// keep a conversation going. Only replies to (and only takes pool guesses from) senders Resend
// authenticated (DKIM or DMARC pass): a forged From would otherwise turn us into a spam cannon
// aimed at whoever it names. Sender addresses are only stored hashed. Once the daily send quota
// is down to DAILY_EMAIL_RESERVE (kept for real news), the email is recorded but not replied to.
//
// CPU (Workers Free gives each step 10 ms): the received email is capped at MAX_RECEIVED_BYTES
// before it is parsed, HTML at MAX_HTML_CHARS and text at MAX_TEXT_CHARS before any regex runs,
// and every regex here is linear on hostile input.

import { getCheckTotal } from './lib/counters';
import { liveStats } from './lib/live';
import { parseGuessText, submitGuess } from './lib/pool';
import { allow, hashIdentifier } from './lib/security';
import { DOMAIN, SITE_NAME, dnsAnswerName, siteUrl } from './lib/site';
import { getState } from './lib/state';
import { londonDate } from './lib/time';
import {
	DAILY_EMAIL_RESERVE,
	RESEND_API_BASE,
	RESEND_USER_AGENT,
	type RenderedEmail,
	emailDailyLimit,
	isQuotaCode,
	renderAutoReply,
	renderGuessConfirmation,
	renderGuessError,
	sendEmail,
	utcDay,
} from './notify/email';

/** Bigger than this (the API's JSON, attachments excluded) and we don't parse it at all. */
export const MAX_RECEIVED_BYTES = 512 * 1024;
/** HTML read when an email has no text part. Sliced before any regex sees it. */
export const MAX_HTML_CHARS = 32_000;
/** Plain text read for a guess. Sliced before any regex sees it. */
export const MAX_TEXT_CHARS = 16_000;
/** Text handed to the guess parser. */
export const MAX_GUESS_TEXT = 2000;
/** Longest subject we keep (replySubject trims further). */
export const MAX_SUBJECT_CHARS = 500;
/** Longest header value we keep. */
export const MAX_HEADER_CHARS = 2000;
/** RFC 5321 allows 64 + 1 + 255; anything longer isn't an address. */
export const MAX_ADDRESS_CHARS = 320;
/** Matches the pool's own name limit. */
export const GUESS_NAME_MAX = 40;
/** Replies per sender per rolling 24 hours, on top of RL_EMAIL's per-minute limit. */
export const MAX_REPLIES_PER_DAY = 20;
/** How long the fetch step waits for Resend before the step retries. */
export const RECEIVE_FETCH_TIMEOUT_MS = 10_000;
export const ANONYMOUS_NAME = 'Anonymous emailer';

export type InboundKind = 'status' | 'guess' | 'ignored';

// ─── Loop protection (pure) ──────────────────────────────────────────────────

export interface InboundEnvelope {
	/** Sender address (bare, see bareAddress). Empty for bounces. */
	from: string;
	headers: { get(name: string): string | null };
	/** Our own domains: never reply to these. */
	ownDomains: readonly string[];
}

const AUTOMATED_LOCAL_PART =
	/^(?:mailer-daemon|postmaster|daemon|listserv|majordomo|.*no[-_.]?reply.*|do[-_.]?not[-_.]?reply|bounces?|bounce[-+._].*|.*-bounces?|.*-request)$/i;
const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk', 'auto_reply']);

/**
 * Why we must not reply to this message, or null if a reply is fine. Covers RFC 3834
 * (Auto-Submitted), Precedence, mailing lists (List-Id), Microsoft's auto-response
 * suppression, bounces (null sender, mailer-daemon, postmaster), no-reply senders and mail
 * from our own domain.
 */
export function automatedReason(input: InboundEnvelope): string | null {
	const from = input.from.trim().toLowerCase().replace(/^<|>$/g, '');
	if (!from) return 'null sender (bounce)';
	const at = from.lastIndexOf('@');
	if (at <= 0 || at === from.length - 1 || from.length > MAX_ADDRESS_CHARS) return 'malformed sender';
	const local = (from.slice(0, at).split('+')[0] ?? '').trim();
	const domain = from.slice(at + 1);

	if (input.ownDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) return 'sender is on our own domain';
	if (AUTOMATED_LOCAL_PART.test(local)) return 'automated sender address';

	const header = (name: string) => (input.headers.get(name) ?? '').trim().toLowerCase();
	// A null Return-Path (RFC 5321 "MAIL FROM:<>") is a bounce or other delivery report.
	if (/^<\s*>$/.test(header('return-path'))) return 'null sender (bounce)';
	const autoSubmitted = header('auto-submitted');
	if (autoSubmitted && (autoSubmitted.split(';')[0] ?? '').trim() !== 'no') return 'Auto-Submitted';
	if (BULK_PRECEDENCE.has(header('precedence'))) return 'Precedence';
	if (input.headers.get('list-id') != null) return 'List-Id';
	if (/\b(?:all|oof|autoreply)\b/.test(header('x-auto-response-suppress'))) return 'X-Auto-Response-Suppress';
	if (input.headers.get('x-autoreply') != null || input.headers.get('x-autorespond') != null) return 'auto-responder header';
	return null;
}

/** Domains we send from (and the zone), lower-cased and de-duplicated. */
export function ownDomains(env: Pick<Env, 'EMAIL_FROM' | 'EMAIL_REPLY_FROM' | 'ZONE_NAME'>): string[] {
	const domainOf = (address: string | undefined) => (address?.includes('@') ? address.slice(address.lastIndexOf('@') + 1) : '');
	return [...new Set([DOMAIN, env.ZONE_NAME, domainOf(env.EMAIL_FROM), domainOf(env.EMAIL_REPLY_FROM)])]
		.map((d) => (d ?? '').trim().toLowerCase())
		.filter(Boolean);
}

/** Resend's verdicts on a received email ('pass', 'fail', 'gray', ...). Null for old emails. */
export interface InboundAuthentication {
	spf?: string | null;
	dkim?: string | null;
	dmarc?: string | null;
}

/**
 * Whether Resend vouches for the sender: DKIM pass (Resend only reports pass when the signing
 * domain matches the From domain, so it's aligned) or DMARC pass. SPF alone isn't enough (it
 * checks the envelope sender, not the From we'd reply to), and DMARC alone isn't required
 * (Gmail with p=none reports dmarc 'gray' with dkim 'pass'). Missing or unknown: not authenticated.
 * Never read from message headers: the sender writes those.
 */
export function senderAuthenticated(auth: InboundAuthentication | null | undefined): boolean {
	const verdict = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
	return verdict(auth?.dkim) === 'pass' || verdict(auth?.dmarc) === 'pass';
}

// ─── Parsing helpers (pure, linear on any input) ─────────────────────────────

/** The first `max` UTF-16 units, without splitting a surrogate pair. */
export function sliceChars(value: string, max: number): string {
	if (value.length <= max) return value;
	const code = value.charCodeAt(max - 1);
	return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * The new part of an email: quoted lines, signatures and "On <date>, X wrote:" blocks
 * removed, including the two-line variant that wraps before "wrote:". Keeps the reply chain's
 * dates away from the guess parser. One pass over the lines.
 */
export function extractFreshText(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const out: string[] = [];
	let hasContent = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (/^--\s*$/.test(line) || /^_{5,}\s*$/.test(line)) break;
		if (/^\s*-{2,}\s*original message\s*-{2,}/i.test(line)) break;
		if (/^\s*on\s/i.test(line) && (/wrote:\s*$/i.test(line) || /wrote:\s*$/i.test(lines[i + 1] ?? ''))) break;
		if (hasContent && /^\s*from:\s/i.test(line)) break;
		if (/^\s*>/.test(line)) continue;
		out.push(line);
		if (!hasContent && line.trim()) hasContent = true;
	}
	return out.join('\n').trim();
}

const BLOCK_OPEN = /<(script|style|head)(?=[\s/>])/gi;

/** Index of the first `</name` at or after `from` that ends there (`</head`, not `</header`), or -1. */
function closingTag(lower: string, name: string, from: number): number {
	for (let i = lower.indexOf(`</${name}`, from); i !== -1; i = lower.indexOf(`</${name}`, i + 1)) {
		const next = lower.charCodeAt(i + name.length + 2);
		// Anything but a letter, digit or hyphen ends the name (NaN at the end of the input counts).
		if (!(next >= 97 && next <= 122) && !(next >= 48 && next <= 57) && next !== 45) return i;
	}
	return -1;
}

/**
 * Drop <script>, <style> and <head> blocks that are closed. An unclosed one is left for the
 * tag stripper (only the tag goes). One forward pass: each name's closing tag is searched for
 * at most once per stretch of input, so 140 KB of `<style>` with no `</style>` is still linear,
 * where the old backreference regex rescanned to the end for every opener.
 */
function stripBlocks(value: string): string {
	const lower = value.toLowerCase();
	const nextClose = new Map<string, number>();
	let out = '';
	let kept = 0;
	BLOCK_OPEN.lastIndex = 0;
	for (let m = BLOCK_OPEN.exec(value); m; m = BLOCK_OPEN.exec(value)) {
		const name = (m[1] as string).toLowerCase();
		let close = nextClose.get(name);
		if (close === undefined || (close !== -1 && close < m.index)) {
			close = closingTag(lower, name, m.index + 1);
			nextClose.set(name, close);
		}
		if (close === -1) continue;
		const gt = value.indexOf('>', close);
		const end = gt === -1 ? value.length : gt + 1;
		out += `${value.slice(kept, m.index)} `;
		kept = end;
		BLOCK_OPEN.lastIndex = end;
	}
	return kept === 0 ? value : out + value.slice(kept);
}

/**
 * Crude but safe HTML → text for emails that only have an HTML part. Reads the first `max`
 * characters (MAX_HTML_CHARS), and every step is linear: `<[^<>]*>` rather than `<[^>]*>`,
 * which is quadratic on a run of `<` with no `>`.
 */
export function htmlToText(value: string, max = MAX_HTML_CHARS): string {
	return stripBlocks(sliceChars(value, max))
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
		.replace(/<[^<>]*>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&amp;/gi, '&')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n\s*\n+/g, '\n\n');
}

/** Whether the subject asks for a pool entry. */
export function isGuessSubject(subject: string): boolean {
	return /guess/i.test(subject);
}

/**
 * What the guess parser reads: the subject plus the fresh part of the body (text if there is a
 * text part, else the HTML turned into text), at most MAX_GUESS_TEXT characters. Both parts are
 * sliced before any regex runs.
 */
export function guessText(subject: string, text: string | null | undefined, html: string | null | undefined): string {
	const body = typeof text === 'string' ? sliceChars(text, MAX_TEXT_CHARS) : html ? htmlToText(html) : '';
	return `${subject}\n${extractFreshText(body)}`.slice(0, MAX_GUESS_TEXT);
}

/** A display name fit for the pool leaderboard, or null. Addresses are not names. */
export function cleanName(value: string | null | undefined, max = GUESS_NAME_MAX): string | null {
	const s = (value ?? '')
		.slice(0, 1000)
		.normalize('NFKC')
		.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^["'“‘]+|["'”’]+$/g, '')
		.trim();
	if (!s || s.includes('@')) return null;
	return [...s].slice(0, max).join('').trim() || null;
}

/** "<id@host>", or null if it doesn't look like a Message-ID. */
export function normaliseMessageId(value: string | null | undefined): string | null {
	const v = (value ?? '').trim();
	if (!v || v.length > 500) return null;
	if (/^<[^<>\s]+@[^<>\s]+>$/.test(v)) return v;
	if (/^[^<>\s]+@[^<>\s]+$/.test(v)) return `<${v}>`;
	return null;
}

/**
 * The bare, lower-cased address from `addr`, `<addr>` or `Name <addr>`. Everything that
 * identifies a sender (hashing, rate limits, loop checks, the reply) uses this form, so
 * "Alex <Alex@Example.com>" and "alex@example.com" are the same person. Empty if there's no
 * plausible address.
 */
export function bareAddress(value: string | null | undefined): string {
	const v = (value ?? '').trim();
	if (v.length > 4 * MAX_ADDRESS_CHARS) return '';
	const angled = /<([^<>]*)>\s*$/.exec(v);
	const address = (angled ? (angled[1] ?? '') : v).trim().toLowerCase();
	if (!address || address.length > MAX_ADDRESS_CHARS || /[\s<>",;]/.test(address)) return '';
	return address;
}

/** In-Reply-To + References (RFC 5322 §3.6.4), capped well under header limits. */
export function threadingHeaders(messageId: string | null, references?: string | null): Record<string, string> {
	if (!messageId) return {};
	const refs = (references ?? '').split(/\s+/).filter((r) => /^<[^<>\s]+>$/.test(r) && r !== messageId);
	let chain = [...new Set([...refs, messageId])];
	while (chain.length > 1 && chain.join(' ').length > 900) chain = chain.slice(1);
	return { 'In-Reply-To': messageId, References: chain.join(' ') };
}

// ─── Step 1: fetch ───────────────────────────────────────────────────────────

/** The parsed body of GET /emails/receiving/{id} (fields we read). */
export interface ReceivedEmail {
	id?: string;
	/** May be "Name <addr>"; only the address is ever used. */
	from?: string;
	subject?: string;
	text?: string | null;
	html?: string | null;
	headers?: Record<string, unknown> | null;
	message_id?: string | null;
	/** Resend's own SPF/DKIM/DMARC verdicts (null for emails received before it existed). */
	authentication?: InboundAuthentication | null;
}

/** What the later steps read of a received email. Kept small: it is stored as the step's result. */
export interface FetchedEmail {
	/** Bare, lower-cased sender address ('' if there isn't a plausible one). */
	from: string;
	subject: string;
	/** Guess emails only (else null): the text part, at most MAX_TEXT_CHARS. */
	text: string | null;
	/** Guess emails without a text part only (else null): the HTML, at most MAX_HTML_CHARS. */
	html: string | null;
	/** The headers loop protection and threading read: lower-cased names, capped values. */
	headers: Record<string, string>;
	/** Normalised Message-ID, or null. */
	messageId: string | null;
	references: string | null;
	/** Resend's structured verdicts only; never the Authentication-Results headers the sender wrote. */
	authentication: InboundAuthentication | null;
}

export type FetchResult = { ok: true; email: FetchedEmail } | { ok: false; reason: string };

/** The only headers any later step reads. */
export const KEPT_HEADERS: readonly string[] = [
	'return-path',
	'auto-submitted',
	'precedence',
	'list-id',
	'x-auto-response-suppress',
	'x-autoreply',
	'x-autorespond',
	'subject',
	'message-id',
	'references',
];

function headerValue(name: string, value: unknown): string | null {
	const parts = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');
	if (!parts.length) return null;
	// References: keep the newest ids (at the end); everything else: the start.
	return name === 'references' ? parts.join(' ').slice(-MAX_HEADER_CHARS) : sliceChars(parts.join(', '), MAX_HEADER_CHARS);
}

/** Just the KEPT_HEADERS, lower-cased names, string values. */
export function keptHeaders(headers: Record<string, unknown> | null | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headers || typeof headers !== 'object') return out;
	for (const [rawName, value] of Object.entries(headers)) {
		const name = rawName.toLowerCase();
		if (!KEPT_HEADERS.includes(name) || name in out) continue;
		const v = headerValue(name, value);
		if (v !== null) out[name] = v;
	}
	return out;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function verdicts(auth: unknown): InboundAuthentication | null {
	if (!auth || typeof auth !== 'object') return null;
	const a = auth as Record<string, unknown>;
	const v = (x: unknown) => (typeof x === 'string' ? x.slice(0, 40) : null);
	return { spf: v(a.spf), dkim: v(a.dkim), dmarc: v(a.dmarc) };
}

/**
 * Reduce Resend's received email to a FetchedEmail. The sender is the webhook's `data.from`
 * (`webhookFrom`, already bare) in preference to the retrieved email's `from`, which can carry
 * a display name; either way it's the bare, lower-cased address. The body is only kept for a
 * guess (nothing else reads it), and only the part the guess parser would use.
 */
export function trimReceivedEmail(received: ReceivedEmail, webhookFrom = ''): FetchedEmail {
	const headers = keptHeaders(received.headers as Record<string, unknown> | null | undefined);
	const subject = sliceChars((str(received.subject) ?? headers.subject ?? '').trim(), MAX_SUBJECT_CHARS);
	const guess = isGuessSubject(subject);
	const text = str(received.text);
	const html = str(received.html);
	return {
		from: bareAddress(webhookFrom) || bareAddress(str(received.from)),
		subject,
		text: guess && text !== null ? sliceChars(text, MAX_TEXT_CHARS) : null,
		html: guess && text === null && html ? sliceChars(html, MAX_HTML_CHARS) : null,
		headers,
		messageId: normaliseMessageId(str(received.message_id) ?? headers['message-id']),
		references: headers.references ?? null,
		authentication: verdicts(received.authentication),
	};
}

/** The body as text, or null once it passes `max` bytes (checked before it is all read). */
export async function readCapped(res: Response, max: number): Promise<string | null> {
	const declared = Number(res.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > max) {
		await res.body?.cancel().catch(() => {});
		return null;
	}
	if (!res.body) return '';
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/** Thrown for failures worth another go (429, 5xx, network, timeout): the step retries. */
export class TransientFetchError extends Error {
	override name = 'TransientFetchError';
}

/**
 * Fetch and trim the received email (the webhook only carries metadata). 429, 5xx, network
 * errors, timeouts and unreadable JSON throw TransientFetchError, so the workflow step retries
 * with backoff. 404 and other 4xx, a missing id or API key, and an oversized email are
 * permanent: `{ ok: false, reason }`.
 */
export async function fetchReceivedEmail(
	env: Pick<Env, 'RESEND_API_KEY' | 'RESEND_API_BASE'>,
	emailId: string,
	webhookFrom = '',
): Promise<FetchResult> {
	if (!emailId) return { ok: false, reason: 'no email_id' };
	if (!env.RESEND_API_KEY) {
		console.error('inbound: RESEND_API_KEY is not set; cannot fetch the received email');
		return { ok: false, reason: 'no RESEND_API_KEY' };
	}
	const base = (env.RESEND_API_BASE || RESEND_API_BASE).replace(/\/+$/, '');
	let res: Response;
	try {
		res = await fetch(`${base}/emails/receiving/${encodeURIComponent(emailId)}`, {
			headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'User-Agent': RESEND_USER_AGENT },
			signal: AbortSignal.timeout(RECEIVE_FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		throw new TransientFetchError(`fetching the received email failed: ${errorMessage(err)}`);
	}
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		if (res.status === 429 || res.status >= 500) throw new TransientFetchError(`fetching the received email failed: HTTP ${res.status}`);
		console.error(`inbound: fetching the received email failed: HTTP ${res.status}`);
		return { ok: false, reason: `HTTP ${res.status}` };
	}
	const body = await readCapped(res, MAX_RECEIVED_BYTES);
	if (body === null) return { ok: false, reason: 'message too large' };
	let received: ReceivedEmail;
	try {
		received = JSON.parse(body) as ReceivedEmail;
	} catch {
		throw new TransientFetchError('the received email was not JSON');
	}
	if (!received || typeof received !== 'object') throw new TransientFetchError('the received email was not an object');
	return { ok: true, email: trimReceivedEmail(received, webhookFrom) };
}

// ─── Step 2: decide ──────────────────────────────────────────────────────────

/** A parsed guess (name from an explicit "Name:" line only), or why it didn't parse. */
export type ParsedGuess = { guessAt: string; name: string | null } | { error: string };

export type InboundDecision =
	| { action: 'ignore'; reason: string; fromHash: string | null }
	| { action: 'status'; fromHash: string | null }
	| { action: 'guess'; fromHash: string | null; guess: ParsedGuess };

export type ReplyDecision = Exclude<InboundDecision, { action: 'ignore' }>;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function headerGetter(headers: Record<string, string>): InboundEnvelope['headers'] {
	return { get: (name) => headers[name.toLowerCase()] ?? null };
}

/**
 * Today's sends (this email isn't counted yet: recordInbound does that) and this sender's
 * replies in the last 24 hours, in one round trip. Fails open (nulls), as the quota always has.
 */
async function quotaAndRecent(env: Pick<Env, 'DB'>, fromHash: string | null, now: Date): Promise<{ sent: number | null; recent: number | null }> {
	try {
		const statements = [env.DB.prepare('SELECT n FROM email_sends WHERE day = ?').bind(utcDay(now))];
		if (fromHash) {
			const since = new Date(now.getTime() - 86_400_000).toISOString();
			statements.push(
				env.DB.prepare("SELECT COUNT(*) AS n FROM inbound_emails WHERE from_hash = ? AND kind <> 'ignored' AND at > ?").bind(fromHash, since),
			);
		}
		const [sends, replies] = await env.DB.batch<{ n: number }>(statements);
		return { sent: sends?.results[0]?.n ?? 0, recent: replies ? (replies.results[0]?.n ?? 0) : null };
	} catch (err) {
		console.error('inbound: could not read the quota:', errorMessage(err));
		return { sent: null, recent: null };
	}
}

/**
 * Whether (and how) to answer this email. Never throws. The order matters: nothing about a
 * forged or automated sender reaches the rate limiter, and the quota is checked before a
 * guess is parsed, so a guess is never entered without its confirmation.
 */
export async function decideInbound(env: Env, email: FetchedEmail, now: Date = new Date()): Promise<InboundDecision> {
	const sender = email.from;
	const fromHash = sender ? await hashIdentifier(env, sender).catch(() => null) : null;
	const ignore = (reason: string): InboundDecision => ({ action: 'ignore', reason, fromHash });

	const reason = automatedReason({ from: sender, headers: headerGetter(email.headers), ownDomains: ownDomains(env) });
	if (reason) return ignore(reason);
	// A spoofed sender gets no reply and can't use up someone else's guesses.
	if (!senderAuthenticated(email.authentication)) return ignore('sender not authenticated');

	const { sent, recent } = await quotaAndRecent(env, fromHash, now);
	// Our replies never spend the emails kept for real news. This email counts too (Resend
	// counts received mail), although recordInbound only writes that after the reply.
	if (emailDailyLimit(env) - (sent ?? 0) - 1 <= DAILY_EMAIL_RESERVE) return ignore('daily send quota down to the reserve');
	if (!(await allow(env.RL_EMAIL, `email:${fromHash ?? 'unknown'}`))) return ignore('per-minute limit');
	if (recent !== null && recent >= MAX_REPLIES_PER_DAY) return ignore('daily limit');

	if (!isGuessSubject(email.subject)) return { action: 'status', fromHash };
	let parsed: ReturnType<typeof parseGuessText>;
	try {
		parsed = parseGuessText(guessText(email.subject, email.text, email.html), now.toISOString());
	} catch (err) {
		console.error('inbound: guess parsing failed:', errorMessage(err));
		parsed = { error: 'The pool is having a moment. Please try again shortly.' };
	}
	// Only an explicit "Name:" line goes on the public leaderboard. The From: display name is
	// often a full real name, and nobody agreed to publish it by emailing a robot.
	const guess: ParsedGuess = 'error' in parsed ? { error: parsed.error } : { guessAt: parsed.guessAt, name: cleanName(parsed.name) };
	return { action: 'guess', fromHash, guess };
}

// ─── Step 3: enter the guess ─────────────────────────────────────────────────

export type GuessOutcome = { ok: true; id: number; name: string; anonymous: boolean; guessAt: string } | { ok: false; error: string };

/** Put a parsed guess in the pool. Never throws (submitGuess doesn't). */
export async function enterGuess(env: Env, guess: { guessAt: string; name: string | null }, fromHash: string | null): Promise<GuessOutcome> {
	const name = guess.name ?? ANONYMOUS_NAME;
	const result = await submitGuess(env, { name, guessAt: guess.guessAt, source: 'email', ipHash: fromHash });
	if (!result.ok) return { ok: false, error: result.error };
	return { ok: true, id: result.id, name, anonymous: guess.name === null, guessAt: guess.guessAt };
}

// ─── Step 4: reply ───────────────────────────────────────────────────────────

async function statusReply(env: Env, base: string, subject: string): Promise<RenderedEmail> {
	const state = await getState(env, { fresh: true });
	const counts = env.DB.batch<{ n: number }>([
		env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL'),
		env.DB.prepare('SELECT COUNT(*) AS n FROM guesses WHERE hidden = 0'),
	])
		.then((rows) => rows.map((r) => r.results[0]?.n ?? 0))
		.catch(() => [null, null]);
	const [checks, viewers, [subscribers, guesses]] = await Promise.all([
		getCheckTotal(env).catch(() => null),
		liveStats(env)
			.then((s) => s.viewers)
			.catch(() => null),
		counts,
	]);
	return renderAutoReply({
		base,
		state,
		stats: { checks, viewers, subscribers: subscribers ?? null, guesses: guesses ?? null },
		today: londonDate(),
		originalSubject: subject,
		// Only advertise `dig` when the record is actually kept up to date.
		dnsName: dnsAnswerName(env),
	});
}

/** What the reply step did. `retry`: a transient failure worth another attempt. */
export interface ReplyOutcome {
	sent: boolean;
	code?: string;
	retry?: boolean;
}

/**
 * Render and send the reply. `entered` is the guess step's result (guess emails that parsed).
 * One reply per received email: the idempotency key is `reply:<emailId>`, so a step retry or
 * a replayed instance reuses it. Never throws for a send failure; says whether to retry.
 */
export async function sendInboundReply(
	env: Env,
	emailId: string,
	email: FetchedEmail,
	decision: ReplyDecision,
	entered: GuessOutcome | null,
): Promise<ReplyOutcome> {
	const base = siteUrl(env);
	const subject = email.subject;
	let reply: RenderedEmail;
	if (decision.action === 'status') reply = await statusReply(env, base, subject);
	else if ('error' in decision.guess) reply = await renderGuessError({ base, error: decision.guess.error, originalSubject: subject });
	else if (entered?.ok) {
		reply = await renderGuessConfirmation({
			base,
			name: entered.name,
			anonymous: entered.anonymous,
			guessAt: entered.guessAt,
			id: entered.id,
			originalSubject: subject,
		});
	} else {
		reply = await renderGuessError({ base, error: entered?.error ?? 'The pool is having a moment. Please try again shortly.', originalSubject: subject });
	}

	const result = await sendEmail(
		env,
		{
			to: email.from,
			from: { email: env.EMAIL_REPLY_FROM, name: SITE_NAME },
			...reply,
			headers: { 'Auto-Submitted': 'auto-replied', ...threadingHeaders(email.messageId, email.references) },
			idempotencyKey: `reply:${emailId}`,
		},
		{ reserve: DAILY_EMAIL_RESERVE },
	);
	if (result.ok) return { sent: true };
	console.warn(`inbound: reply not sent: ${result.code ?? 'unknown'}`);
	return { sent: false, code: result.code, retry: Boolean(result.transient) && !isQuotaCode(result.code) };
}

// ─── Step 5: record ──────────────────────────────────────────────────────────

/**
 * Record the email in inbound_emails and count it against today's send quota (Resend counts
 * received mail), exactly once per `marker` (the workflow instance id): one D1 batch, which is
 * a transaction, writes both only if the marker isn't in resend_events yet, then adds it. A
 * retried or replayed step finds the marker and writes nothing. True if this call recorded it.
 * Throws if D1 can't be written, so the step retries.
 */
export async function recordInbound(
	env: Pick<Env, 'DB'>,
	marker: string,
	kind: InboundKind,
	fromHash: string | null,
	now: Date = new Date(),
): Promise<boolean> {
	const at = now.toISOString();
	const results = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO email_sends (day, n) SELECT ?1, 1 WHERE NOT EXISTS (SELECT 1 FROM resend_events WHERE svix_id = ?2)
			 ON CONFLICT (day) DO UPDATE SET n = n + 1`,
		).bind(utcDay(now), marker),
		env.DB.prepare(
			'INSERT INTO inbound_emails (kind, from_hash, at) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM resend_events WHERE svix_id = ?4)',
		).bind(kind, fromHash, at, marker),
		env.DB.prepare("INSERT INTO resend_events (svix_id, type, at) VALUES (?1, 'inbound.recorded', ?2) ON CONFLICT (svix_id) DO NOTHING").bind(
			marker,
			at,
		),
	]);
	return (results[2]?.meta.changes ?? 0) > 0;
}
