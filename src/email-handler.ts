// OWNER: email agent.
// Inbound email (Resend receiving → webhook → this Worker): auto-reply with the answer, or
// enter a baby-pool guess sent by email ("guess" in the subject, "14 Nov 15:30" in the body).
//
// Never throws. Never replies to robots, mailing lists, bounces or ourselves (RFC 3834), and
// caps replies per sender per minute (RL_EMAIL) and per day (inbound_emails), so a broken
// auto-responder can't keep a conversation going. Only replies to (and only takes pool guesses
// from) senders Resend authenticated (DKIM or DMARC pass): a forged From would otherwise turn
// us into a spam cannon aimed at whoever it names. Sender addresses are only stored hashed.
// Once the daily send quota is down to DAILY_EMAIL_RESERVE (kept for real news), the email is
// recorded but not replied to.

import { getCheckTotal } from './lib/counters';
import { liveStats } from './lib/live';
import { parseGuessText, submitGuess } from './lib/pool';
import { allow, hashIdentifier } from './lib/security';
import { DOMAIN, SITE_NAME, dnsAnswerName, siteUrl } from './lib/site';
import { getState } from './lib/state';
import { londonDate, nowIso } from './lib/time';
import {
	DAILY_EMAIL_RESERVE,
	type RenderedEmail,
	emailQuotaRemaining,
	renderAutoReply,
	renderGuessConfirmation,
	renderGuessError,
	sendEmail,
} from './notify/email';

/** Bigger than this and we don't even read it. */
export const MAX_INBOUND_BYTES = 5 * 1024 * 1024;
/** Text handed to the guess parser. */
export const MAX_GUESS_TEXT = 2000;
/** Matches the pool's own name limit. */
export const GUESS_NAME_MAX = 40;
/** Replies per sender per rolling 24 hours, on top of RL_EMAIL's per-minute limit. */
export const MAX_REPLIES_PER_DAY = 20;
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
	if (at <= 0 || at === from.length - 1) return 'malformed sender';
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

// ─── Parsing helpers (pure) ──────────────────────────────────────────────────

/**
 * The new part of an email: quoted lines, signatures and "On <date>, X wrote:" blocks
 * removed, including the two-line variant that wraps before "wrote:". Keeps the reply chain's
 * dates away from the guess parser.
 */
export function extractFreshText(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (/^--\s*$/.test(line) || /^_{5,}\s*$/.test(line)) break;
		if (/^\s*-{2,}\s*original message\s*-{2,}/i.test(line)) break;
		if (/^\s*on\s/i.test(line) && (/wrote:\s*$/i.test(line) || /wrote:\s*$/i.test(lines[i + 1] ?? ''))) break;
		if (/^\s*from:\s/i.test(line) && out.some((l) => l.trim())) break;
		if (/^\s*>/.test(line)) continue;
		out.push(line);
	}
	return out.join('\n').trim();
}

/** Crude but safe HTML → text for emails that only have an HTML part. */
export function htmlToText(value: string): string {
	return value
		.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&amp;/gi, '&')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n\s*\n+/g, '\n\n');
}

/** A display name fit for the pool leaderboard, or null. Addresses are not names. */
export function cleanName(value: string | null | undefined, max = GUESS_NAME_MAX): string | null {
	const s = (value ?? '')
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
	const angled = /<([^<>]*)>\s*$/.exec(v);
	const address = (angled ? (angled[1] ?? '') : v).trim().toLowerCase();
	if (!address || /[\s<>",;]/.test(address)) return '';
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

// ─── The handler ─────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function count(env: Env, sql: string, ...binds: unknown[]): Promise<number | null> {
	try {
		const row = await env.DB.prepare(sql)
			.bind(...binds)
			.first<{ n: number }>();
		return row?.n ?? 0;
	} catch {
		return null;
	}
}

async function recordInbound(env: Env, kind: InboundKind, fromHash: string | null): Promise<void> {
	try {
		await env.DB.prepare('INSERT INTO inbound_emails (kind, from_hash, at) VALUES (?, ?, ?)').bind(kind, fromHash, nowIso()).run();
	} catch (err) {
		console.error('inbound: could not record email:', errorMessage(err));
	}
}

async function statusReply(env: Env, base: string, subject: string): Promise<RenderedEmail> {
	const state = await getState(env, { fresh: true });
	const [checks, viewers, subscribers, guesses] = await Promise.all([
		getCheckTotal(env).catch(() => null),
		liveStats(env)
			.then((s) => s.viewers)
			.catch(() => null),
		count(env, 'SELECT COUNT(*) AS n FROM subscribers WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL'),
		count(env, 'SELECT COUNT(*) AS n FROM guesses WHERE hidden = 0'),
	]);
	return renderAutoReply({
		base,
		state,
		stats: { checks, viewers, subscribers, guesses },
		today: londonDate(),
		originalSubject: subject,
		// Only advertise `dig` when the record is actually kept up to date.
		dnsName: dnsAnswerName(env),
	});
}

async function guessReply(env: Env, base: string, email: InboundEmail, subject: string, fromHash: string | null): Promise<RenderedEmail> {
	const bodyText = email.text ?? (email.html ? htmlToText(email.html) : '');
	const text = `${subject}\n${extractFreshText(bodyText)}`.slice(0, MAX_GUESS_TEXT);
	const guess = parseGuessText(text, nowIso());
	if ('error' in guess) return renderGuessError({ base, error: guess.error, originalSubject: subject });

	// Only an explicit "Name:" line goes on the public leaderboard. The From: display name is
	// often a full real name, and nobody agreed to publish it by emailing a robot.
	const chosen = cleanName(guess.name);
	const name = chosen ?? ANONYMOUS_NAME;
	const result = await submitGuess(env, { name, guessAt: guess.guessAt, source: 'email', ipHash: fromHash });
	if (!result.ok) return renderGuessError({ base, error: result.error, originalSubject: subject });
	return renderGuessConfirmation({ base, name, anonymous: !chosen, guessAt: guess.guessAt, id: result.id, originalSubject: subject });
}

/** One inbound email, already parsed (by Resend's receiving API, in production). */
export interface InboundEmail {
	/** Sender address: bare, or "Name <addr>" (only the address is used). Empty for bounces. */
	from: string;
	subject: string;
	text?: string | null;
	html?: string | null;
	/** Message headers (names lower-cased). Repeated headers may arrive as arrays. */
	headers?: Record<string, string | string[]> | Headers | null;
	messageId?: string | null;
	references?: string | null;
	/** Resend's id for the received email (keys our reply, so a redelivery can't double-send). */
	id?: string | null;
	/** Resend's SPF/DKIM/DMARC verdicts. Missing means unauthenticated. */
	authentication?: InboundAuthentication | null;
}

/** A Headers view over whatever the caller has. */
function headerView(headers: InboundEmail['headers']): Headers {
	if (headers instanceof Headers) return headers;
	const out = new Headers();
	for (const [name, value] of Object.entries(headers ?? {})) {
		try {
			if (typeof value === 'string') out.set(name, value);
			else if (Array.isArray(value)) out.set(name, value.filter((v) => typeof v === 'string').join(', '));
		} catch {
			// A header name or value Headers won't accept: not one we need.
		}
	}
	return out;
}

async function processInbound(email: InboundEmail, env: Env): Promise<void> {
	const sender = bareAddress(email.from);
	const fromHash = sender ? await hashIdentifier(env, sender).catch(() => null) : null;
	const headers = headerView(email.headers);
	const header = (name: string) => headers.get(name);

	// Absurdly large emails aren't read at all.
	const size = (email.text?.length ?? 0) + (email.html?.length ?? 0);

	const reason = automatedReason({ from: sender, headers, ownDomains: ownDomains(env) });
	if (reason || size > MAX_INBOUND_BYTES) {
		console.log(`inbound: not replying (${reason ?? 'message too large'})`);
		return recordInbound(env, 'ignored', fromHash);
	}
	// A spoofed sender gets no reply and can't use up someone else's guesses.
	if (!senderAuthenticated(email.authentication)) {
		console.log('inbound: not replying (sender not authenticated)');
		return recordInbound(env, 'ignored', fromHash);
	}
	// Our replies never spend the emails kept for real news. Checked before a guess goes in, so
	// a guess is never entered without its confirmation.
	if ((await emailQuotaRemaining(env)) <= DAILY_EMAIL_RESERVE) {
		console.log('inbound: not replying (daily send quota down to the reserve)');
		return recordInbound(env, 'ignored', fromHash);
	}

	if (!(await allow(env.RL_EMAIL, `email:${fromHash ?? 'unknown'}`))) {
		console.log('inbound: not replying (per-minute limit)');
		return recordInbound(env, 'ignored', fromHash);
	}
	if (fromHash) {
		const since = new Date(Date.now() - 86_400_000).toISOString();
		const recent = await count(env, "SELECT COUNT(*) AS n FROM inbound_emails WHERE from_hash = ? AND kind <> 'ignored' AND at > ?", fromHash, since);
		if (recent !== null && recent >= MAX_REPLIES_PER_DAY) {
			console.log('inbound: not replying (daily limit)');
			return recordInbound(env, 'ignored', fromHash);
		}
	}

	const subject = (email.subject ?? header('subject') ?? '').trim();
	const base = siteUrl(env);
	const isGuess = /guess/i.test(subject);
	const reply = isGuess ? await guessReply(env, base, email, subject, fromHash) : await statusReply(env, base, subject);
	const messageId = normaliseMessageId(email.messageId ?? header('message-id'));
	const replyKey = email.id ?? messageId;

	const result = await sendEmail(
		env,
		{
			to: sender,
			from: { email: env.EMAIL_REPLY_FROM, name: SITE_NAME },
			...reply,
			headers: { 'Auto-Submitted': 'auto-replied', ...threadingHeaders(messageId, email.references ?? header('references')) },
			// One reply per inbound email: a new email gets a new key, a redelivery the same one.
			...(replyKey ? { idempotencyKey: `reply:${replyKey}` } : {}),
		},
		{ reserve: DAILY_EMAIL_RESERVE },
	);
	if (!result.ok) console.warn(`inbound: reply not sent: ${result.code ?? 'unknown'}`);
	await recordInbound(env, isGuess ? 'guess' : 'status', fromHash);
}

/** Handle one inbound email. Never throws. */
export async function handleInboundEmail(email: InboundEmail, env: Env): Promise<void> {
	try {
		await processInbound(email, env);
	} catch (err) {
		console.error('inbound: failed:', errorMessage(err));
	}
}
