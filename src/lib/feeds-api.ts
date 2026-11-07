// OWNER: feeds agent.
// Pure logic behind the public JSON API: the status document, update serialisation,
// query parsing, and the RFC 8470 "425 Too Early" verdict for /api/dad.

import type { SiteState, Status, Update, UpdateKind } from '../types';
import { STATUS_COPY } from './site';
import { daysBetween, londonHour } from './time';

// ─── /api/status ─────────────────────────────────────────────────────────────

export interface StatusLinks {
	self: string;
	html: string;
	text: string;
	history: string;
	updates: string;
	dad: string;
	stream: string;
	rss: string;
	atom: string;
	jsonFeed: string;
	calendar: string;
	badge: string;
	embed: string;
	docs: string;
	openapi: string;
	mcp: string;
}

export interface StatusDocument {
	isZackADad: boolean;
	status: Status;
	/** The giant word on the homepage: NO, NOT YET or YES. */
	answer: string;
	sentence: string;
	statusChangedAt: string;
	dueDate: string | null;
	/** Whole days from today (Europe/London) to the due date. Negative when overdue; null without a due date. */
	daysUntilDue: number | null;
	/** Total number of times anyone has asked. */
	checks: number;
	links: StatusLinks;
}

export function statusLinks(siteUrl: string): StatusLinks {
	return {
		self: `${siteUrl}/api/status`,
		html: `${siteUrl}/`,
		text: `${siteUrl}/api/status.txt`,
		history: `${siteUrl}/api/history`,
		updates: `${siteUrl}/api/updates`,
		dad: `${siteUrl}/api/dad`,
		stream: `${siteUrl}/api/stream`,
		rss: `${siteUrl}/feed.xml`,
		atom: `${siteUrl}/atom.xml`,
		jsonFeed: `${siteUrl}/feed.json`,
		calendar: `${siteUrl}/calendar.ics`,
		badge: `${siteUrl}/badge.svg`,
		embed: `${siteUrl}/embed`,
		docs: `${siteUrl}/api`,
		openapi: `${siteUrl}/openapi.json`,
		mcp: `${siteUrl}/mcp`,
	};
}

export function daysUntilDue(state: SiteState, today: string): number | null {
	return state.dueDate ? daysBetween(today, state.dueDate) : null;
}

export function buildStatusDocument(state: SiteState, opts: { checks: number; today: string; siteUrl: string }): StatusDocument {
	const copy = STATUS_COPY[state.status];
	return {
		isZackADad: state.status === 'yes',
		status: state.status,
		answer: copy.word,
		sentence: copy.sentence,
		statusChangedAt: state.statusChangedAt,
		dueDate: state.dueDate,
		daysUntilDue: daysUntilDue(state, opts.today),
		checks: opts.checks,
		links: statusLinks(opts.siteUrl),
	};
}

/** The one-line answer for /api/status.txt. */
export function statusText(status: Status): 'no' | 'not yet' | 'yes' {
	return status === 'yes' ? 'yes' : status === 'soon' ? 'not yet' : 'no';
}

// ─── /api/updates ────────────────────────────────────────────────────────────

export const UPDATES_DEFAULT_LIMIT = 20;
export const UPDATES_MAX_LIMIT = 50;

export interface PublicUpdate {
	id: number;
	kind: UpdateKind;
	title: string;
	body: string;
	status: Status;
	createdAt: string;
	url: string;
}

/** The public shape of an update (no delivery internals). */
export function publicUpdate(update: Update, siteUrl: string): PublicUpdate {
	return {
		id: update.id,
		kind: update.kind,
		title: update.title,
		body: update.body,
		status: update.status,
		createdAt: update.createdAt,
		url: `${siteUrl}/updates/${update.id}`,
	};
}

export type UpdatesQuery = { ok: true; limit: number; before: number | undefined } | { ok: false; error: string };

const POSITIVE_INT = /^[1-9]\d{0,15}$/;

export function parseUpdatesQuery(query: { limit?: string | undefined; before?: string | undefined }): UpdatesQuery {
	let limit = UPDATES_DEFAULT_LIMIT;
	if (query.limit !== undefined && query.limit !== '') {
		const n = POSITIVE_INT.test(query.limit) ? Number(query.limit) : Number.NaN;
		if (!Number.isSafeInteger(n) || n < 1 || n > UPDATES_MAX_LIMIT) {
			return { ok: false, error: `limit must be a whole number from 1 to ${UPDATES_MAX_LIMIT}.` };
		}
		limit = n;
	}
	let before: number | undefined;
	if (query.before !== undefined && query.before !== '') {
		const n = POSITIVE_INT.test(query.before) ? Number(query.before) : Number.NaN;
		if (!Number.isSafeInteger(n)) return { ok: false, error: 'before must be a positive update id.' };
		before = n;
	}
	return { ok: true, limit, before };
}

// ─── /api/dad (RFC 8470: 425 Too Early) ──────────────────────────────────────

/** The UTC instant of 00:00 Europe/London on a 'YYYY-MM-DD' date (handles BST). */
export function londonMidnightUtc(ymd: string): number {
	const utcMidnight = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
	// At 00:00 UTC London reads 00:00 (GMT) or 01:00 (BST); subtract the offset.
	return utcMidnight - londonHour(new Date(utcMidnight)) * 3_600_000;
}

const TOO_EARLY_JOKES = [
	'Too early. The dad you requested has not been delivered yet.',
	'This resource is still compiling. Estimated build time: roughly nine months.',
	'Dad not found. Yet. Please try again after the baby.',
	'Request received too early: the baby has not approved this change.',
	'Zack is in private beta. General availability is pending sign-off from a very small stakeholder.',
	'The dad is still in the oven. Please do not open the door; it lets the heat out.',
] as const;

/** Re-check hourly once the due date has passed. Babies keep their own schedule. */
export const OVERDUE_RETRY_SECONDS = 3600;
/** While labour is in progress, a minute is a reasonable polling interval. Barely. */
export const SOON_RETRY_SECONDS = 60;

export type DadBody =
	| {
			error: 'too_early';
			status: 'no' | 'soon';
			isZackADad: false;
			message: string;
			dueDate: string | null;
			retryAfterSeconds: number | null;
			retryAt: string | null;
	  }
	| { status: 'yes'; isZackADad: true; message: string; createdAt: string; location: '/' };

export interface DadVerdict {
	httpStatus: 201 | 425;
	headers: Record<string, string>;
	body: DadBody;
}

/**
 * The verdict for /api/dad: 425 Too Early until the baby arrives (with Retry-After
 * derived from the due date when there is one), then 201 Created with Location: /.
 * `pick` chooses a joke (defaults to Math.random) so tests can be deterministic.
 */
export function dadVerdict(state: SiteState, now: Date, pick: (count: number) => number = (n) => Math.floor(Math.random() * n)): DadVerdict {
	if (state.status === 'yes') {
		return {
			httpStatus: 201,
			headers: { Location: '/' },
			body: {
				status: 'yes',
				isZackADad: true,
				message: 'Dad created. No refunds, no returns, no sleep.',
				createdAt: state.statusChangedAt,
				location: '/',
			},
		};
	}

	let retryAfter: number | null = null;
	if (state.status === 'soon') {
		retryAfter = SOON_RETRY_SECONDS;
	} else if (state.dueDate) {
		const seconds = Math.ceil((londonMidnightUtc(state.dueDate) - now.getTime()) / 1000);
		retryAfter = seconds > 0 ? seconds : OVERDUE_RETRY_SECONDS;
	}

	const index = Math.min(Math.max(0, Math.trunc(pick(TOO_EARLY_JOKES.length))), TOO_EARLY_JOKES.length - 1);
	const message =
		state.status === 'soon'
			? 'Any minute now. Labour is in progress, so the dad is currently being provisioned. Please hold.'
			: (TOO_EARLY_JOKES[index] ?? TOO_EARLY_JOKES[0]);

	return {
		httpStatus: 425,
		headers: retryAfter === null ? {} : { 'Retry-After': String(retryAfter) },
		body: {
			error: 'too_early',
			status: state.status,
			isZackADad: false,
			message,
			dueDate: state.dueDate,
			retryAfterSeconds: retryAfter,
			retryAt: retryAfter === null ? null : new Date(now.getTime() + retryAfter * 1000).toISOString(),
		},
	};
}

/** For tests and docs: every joke the 425 can tell. */
export function tooEarlyJokes(): readonly string[] {
	return TOO_EARLY_JOKES;
}
