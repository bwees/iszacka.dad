// OWNER: feeds agent.
// Pure renderers for every syndication format known to humankind (well, four of them):
// RSS 2.0, Atom 1.0, JSON Feed 1.1 and iCalendar (RFC 5545). Plus the ETag helpers the
// routes use to answer "has anything changed?" with a satisfying 304 Not Modified.
//
// Nothing in here touches the network or the database: routes load the data and pass
// it in, which keeps these functions trivially testable.

import type { SiteState, Status, Update, UpdateKind } from '../types';
import { DOMAIN, PARENTS, SITE_NAME, STATUS_COPY } from './site';

/** Feeds carry the latest 50 updates. */
export const FEED_ITEM_LIMIT = 50;

/** Every feed may be cached for a minute. The baby is unlikely to arrive faster than that. */
export const FEED_CACHE_CONTROL = 'public, max-age=60';

export const FEED_CONTENT_TYPES = {
	rss: 'application/rss+xml; charset=utf-8',
	atom: 'application/atom+xml; charset=utf-8',
	json: 'application/feed+json; charset=utf-8',
	ical: 'text/calendar; charset=utf-8',
} as const;

export interface FeedInput {
	/** Absolute base URL, no trailing slash (see `siteUrl(env)`). */
	siteUrl: string;
	state: SiteState;
	/** Newest first, as returned by `listUpdates`. */
	updates: Update[];
	/** Path the feed was requested on (for self links), e.g. '/rss.xml'. */
	selfPath?: string;
}

const KIND_LABELS: Record<UpdateKind, string> = {
	status: 'Status change',
	daily: 'Daily bulletin',
	system: 'Announcement',
};

const FEED_DESCRIPTION = 'Live, overengineered updates on whether Zack is a dad yet.';

// ─── Escaping ────────────────────────────────────────────────────────────────

/** Characters that are illegal in XML 1.0 (C0 controls bar tab/LF/CR, lone surrogates, U+FFFE/F). */
const INVALID_XML_CHARS =
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escape text for XML element content and attribute values, dropping characters XML can't carry. */
export function escapeXml(value: string): string {
	return value
		.replace(INVALID_XML_CHARS, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/** Escape text for HTML. */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Plain text (with newlines) → a small HTML fragment: blank lines make paragraphs, single newlines make <br>. */
export function textToHtml(text: string): string {
	const paragraphs = text
		.replace(/\r\n?/g, '\n')
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);
	return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

// ─── Shared item helpers ─────────────────────────────────────────────────────

/** Permanent, format-independent id for an update (RFC 4151 tag URI). */
export function updateTagId(id: number): string {
	return `tag:${DOMAIN},2026:updates/${id}`;
}

export function updateUrl(siteUrl: string, id: number): string {
	return `${siteUrl}/updates/${id}`;
}

function toDate(iso: string): Date {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/** RFC 822 date, as RSS 2.0 wants it: "Fri, 06 Nov 2026 21:30:00 GMT". */
export function rfc822(iso: string): string {
	return toDate(iso).toUTCString();
}

/** RFC 3339 timestamp in UTC. */
export function rfc3339(iso: string): string {
	return toDate(iso).toISOString();
}

/** The latest moment anything in the feed changed (newest update or the last status change). */
export function feedUpdatedAt(state: SiteState, updates: Update[]): string {
	const candidates = [state.statusChangedAt, ...updates.map((u) => u.createdAt)].map((iso) => toDate(iso).getTime());
	return new Date(Math.max(...candidates)).toISOString();
}

function itemSummary(update: Update): string {
	return update.body.trim() || update.title;
}

// ─── RSS 2.0 ─────────────────────────────────────────────────────────────────

export function renderRss(input: FeedInput): string {
	const { siteUrl, state, updates } = input;
	const self = `${siteUrl}${input.selfPath ?? '/feed.xml'}`;
	const copy = STATUS_COPY[state.status];
	const x = escapeXml;

	const items = updates.map((u) =>
		[
			'    <item>',
			`      <title>${x(u.title)}</title>`,
			`      <link>${x(updateUrl(siteUrl, u.id))}</link>`,
			`      <guid isPermaLink="false">${x(updateTagId(u.id))}</guid>`,
			`      <pubDate>${rfc822(u.createdAt)}</pubDate>`,
			`      <category>${x(KIND_LABELS[u.kind])}</category>`,
			`      <description>${x(textToHtml(itemSummary(u)))}</description>`,
			'    </item>',
		].join('\n'),
	);

	return [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
		'  <channel>',
		`    <title>${x(SITE_NAME)}</title>`,
		`    <link>${x(siteUrl)}/</link>`,
		`    <description>${x(`${FEED_DESCRIPTION} Current answer: ${copy.short}`)}</description>`,
		`    <atom:link href="${x(self)}" rel="self" type="application/rss+xml"/>`,
		'    <language>en-gb</language>',
		`    <lastBuildDate>${rfc822(feedUpdatedAt(state, updates))}</lastBuildDate>`,
		'    <ttl>5</ttl>',
		'    <docs>https://www.rssboard.org/rss-specification</docs>',
		`    <generator>${x(`${DOMAIN}, an unreasonable amount of TypeScript`)}</generator>`,
		...items,
		'  </channel>',
		'</rss>',
		'',
	].join('\n');
}

// ─── Atom 1.0 ────────────────────────────────────────────────────────────────

export function renderAtom(input: FeedInput): string {
	const { siteUrl, state, updates } = input;
	const self = `${siteUrl}${input.selfPath ?? '/atom.xml'}`;
	const copy = STATUS_COPY[state.status];
	const x = escapeXml;

	const entries = updates.map((u) =>
		[
			'  <entry>',
			`    <id>${x(updateTagId(u.id))}</id>`,
			`    <title type="text">${x(u.title)}</title>`,
			`    <link rel="alternate" type="text/html" href="${x(updateUrl(siteUrl, u.id))}"/>`,
			`    <published>${rfc3339(u.createdAt)}</published>`,
			`    <updated>${rfc3339(u.createdAt)}</updated>`,
			`    <category term="${x(u.kind)}" label="${x(KIND_LABELS[u.kind])}"/>`,
			`    <category term="status:${x(u.status)}" label="${x(STATUS_COPY[u.status].short)}"/>`,
			`    <content type="html">${x(textToHtml(itemSummary(u)))}</content>`,
			'  </entry>',
		].join('\n'),
	);

	return [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-GB">',
		`  <id>tag:${DOMAIN},2026:feed</id>`,
		`  <title type="text">${x(SITE_NAME)}</title>`,
		`  <subtitle type="text">${x(`${FEED_DESCRIPTION} Current answer: ${copy.short}`)}</subtitle>`,
		`  <updated>${feedUpdatedAt(state, updates)}</updated>`,
		`  <link rel="self" type="application/atom+xml" href="${x(self)}"/>`,
		`  <link rel="alternate" type="text/html" href="${x(siteUrl)}/"/>`,
		`  <author><name>${x(PARENTS)}</name><uri>${x(siteUrl)}/</uri></author>`,
		`  <generator uri="${x(siteUrl)}/api">${x(DOMAIN)}</generator>`,
		`  <icon>${x(siteUrl)}/icons/icon-192.png</icon>`,
		...entries,
		'</feed>',
		'',
	].join('\n');
}

// ─── JSON Feed 1.1 ───────────────────────────────────────────────────────────

export interface JsonFeedItem {
	id: string;
	url: string;
	title: string;
	content_text: string;
	content_html: string;
	date_published: string;
	tags: string[];
}

export interface JsonFeed {
	version: 'https://jsonfeed.org/version/1.1';
	title: string;
	home_page_url: string;
	feed_url: string;
	description: string;
	icon: string;
	favicon: string;
	language: string;
	authors: Array<{ name: string; url: string }>;
	_is_zack_a_dad: { about: string; status: Status; answer: string; statusChangedAt: string; dueDate: string | null };
	items: JsonFeedItem[];
}

export function buildJsonFeed(input: FeedInput): JsonFeed {
	const { siteUrl, state, updates } = input;
	const copy = STATUS_COPY[state.status];
	return {
		version: 'https://jsonfeed.org/version/1.1',
		title: SITE_NAME,
		home_page_url: `${siteUrl}/`,
		feed_url: `${siteUrl}${input.selfPath ?? '/feed.json'}`,
		description: `${FEED_DESCRIPTION} Current answer: ${copy.short}`,
		icon: `${siteUrl}/icons/icon-512.png`,
		favicon: `${siteUrl}/favicon-${state.status}.svg`,
		language: 'en-GB',
		authors: [{ name: PARENTS, url: `${siteUrl}/` }],
		_is_zack_a_dad: {
			about: `${siteUrl}/api`,
			status: state.status,
			answer: copy.word,
			statusChangedAt: state.statusChangedAt,
			dueDate: state.dueDate,
		},
		items: updates.map((u) => ({
			id: updateTagId(u.id),
			url: updateUrl(siteUrl, u.id),
			title: u.title,
			content_text: itemSummary(u),
			content_html: textToHtml(itemSummary(u)),
			date_published: rfc3339(u.createdAt),
			tags: [u.kind, `status:${u.status}`],
		})),
	};
}

export function renderJsonFeed(input: FeedInput): string {
	return `${JSON.stringify(buildJsonFeed(input), null, 2)}\n`;
}

// ─── iCalendar (RFC 5545) ────────────────────────────────────────────────────

export interface IcalInput {
	siteUrl: string;
	state: SiteState;
	/**
	 * ISO timestamp used for DTSTAMP. Pass something stable (e.g. the last time the
	 * data changed) rather than "now", so the body, and therefore the ETag, only
	 * changes when the calendar really does.
	 */
	stampedAt: string;
	/** When the due date was last set, for LAST-MODIFIED on its event. */
	dueDateModifiedAt?: string | null;
}

/** Escape a TEXT value (RFC 5545 §3.3.11). */
export function escapeIcalText(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r\n|\r|\n/g, '\\n');
}

const utf8 = new TextEncoder();

/**
 * Fold a content line so no physical line exceeds 75 octets (RFC 5545 §3.1).
 * Continuation lines start with a single space, which counts towards their 75.
 * Never splits a multi-byte UTF-8 sequence.
 */
export function foldIcalLine(line: string, limit = 75): string {
	if (utf8.encode(line).length <= limit) return line;
	const out: string[] = [];
	let current = '';
	let size = 0;
	let max = limit;
	for (const ch of line) {
		const bytes = utf8.encode(ch).length;
		if (size + bytes > max) {
			out.push(current);
			current = ' ';
			size = 1;
			max = limit;
		}
		current += ch;
		size += bytes;
	}
	out.push(current);
	return out.join('\r\n');
}

/** ISO timestamp → iCalendar UTC DATE-TIME, e.g. 20261106T213000Z. */
export function icalDateTime(iso: string): string {
	return toDate(iso)
		.toISOString()
		.replace(/\.\d{3}Z$/, 'Z')
		.replace(/[-:]/g, '');
}

/** 'YYYY-MM-DD' → iCalendar DATE, e.g. 20261120. */
export function icalDate(ymd: string): string {
	return ymd.replace(/-/g, '');
}

function nextDay(ymd: string): string {
	const d = new Date(`${ymd}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

function plusHour(iso: string): string {
	return new Date(toDate(iso).getTime() + 3_600_000).toISOString();
}

const CALENDAR_COLOURS: Record<Status, string> = { no: 'firebrick', soon: 'goldenrod', yes: 'forestgreen' };

/** The whole calendar, CRLF line endings and all. */
export function renderIcal(input: IcalInput): string {
	const { siteUrl, state } = input;
	const host = hostOf(siteUrl);
	const copy = STATUS_COPY[state.status];
	const stamp = icalDateTime(input.stampedAt);
	const t = escapeIcalText;
	const lines: string[] = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		`PRODID:-//${DOMAIN}//${SITE_NAME}//EN`,
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		`NAME:${t(SITE_NAME)}`,
		`X-WR-CALNAME:${t(SITE_NAME)}`,
		`DESCRIPTION:${t(`The due date and the big moments. ${copy.sentence}`)}`,
		`X-WR-CALDESC:${t(`The due date and the big moments. ${copy.sentence}`)}`,
		'X-WR-TIMEZONE:Europe/London',
		`URL;VALUE=URI:${siteUrl}/`,
		`SOURCE;VALUE=URI:${siteUrl}/calendar.ics`,
		`COLOR:${CALENDAR_COLOURS[state.status]}`,
		'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
		'X-PUBLISHED-TTL:PT1H',
	];

	if (state.dueDate) {
		const arrived = state.status === 'yes';
		lines.push(
			'BEGIN:VEVENT',
			`UID:due-date@${host}`,
			`DTSTAMP:${stamp}`,
			...(input.dueDateModifiedAt ? [`LAST-MODIFIED:${icalDateTime(input.dueDateModifiedAt)}`] : []),
			`DTSTART;VALUE=DATE:${icalDate(state.dueDate)}`,
			`DTEND;VALUE=DATE:${icalDate(nextDay(state.dueDate))}`,
			`SUMMARY:${t(arrived ? 'Original due date (now purely academic)' : 'Due date (an estimate, not a promise)')}`,
			`DESCRIPTION:${t(
				arrived
					? `The baby has already arrived, so this date is now trivia. ${siteUrl}/`
					: `The official estimated due date. Babies have not read the documentation. Live answer: ${siteUrl}/`,
			)}`,
			`URL;VALUE=URI:${siteUrl}/`,
			`STATUS:${arrived ? 'CONFIRMED' : 'TENTATIVE'}`,
			'TRANSP:TRANSPARENT',
			'CLASS:PUBLIC',
			'END:VEVENT',
		);
	}

	if (state.status === 'soon' || state.status === 'yes') {
		const moment = icalDateTime(state.statusChangedAt);
		const happening = state.status === 'soon';
		lines.push(
			'BEGIN:VEVENT',
			`UID:${happening ? 'its-happening' : 'became-a-dad'}-${moment}@${host}`,
			`DTSTAMP:${stamp}`,
			`DTSTART:${moment}`,
			`DTEND:${icalDateTime(plusHour(state.statusChangedAt))}`,
			`SUMMARY:${t(happening ? "It's happening" : 'Zack became a dad')}`,
			`DESCRIPTION:${t(`${copy.sentence} ${siteUrl}/`)}`,
			`URL;VALUE=URI:${siteUrl}/`,
			'STATUS:CONFIRMED',
			'TRANSP:OPAQUE',
			'CLASS:PUBLIC',
			'END:VEVENT',
		);
	}

	lines.push('END:VCALENDAR');
	return `${lines.map((l) => foldIcalLine(l)).join('\r\n')}\r\n`;
}

function hostOf(siteUrl: string): string {
	try {
		return new URL(siteUrl).hostname || DOMAIN;
	} catch {
		return DOMAIN;
	}
}

// ─── Conditional requests ────────────────────────────────────────────────────

/** Strong ETag: the first 128 bits of the body's SHA-256. */
export async function etagFor(body: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', utf8.encode(body));
	const hex = [...new Uint8Array(digest)]
		.slice(0, 16)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `"${hex}"`;
}

/**
 * If-None-Match evaluation (RFC 9110 §13.1.2): weak comparison, lists, and `*`.
 * Weak comparison matters because Cloudflare weakens ETags when it compresses.
 */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
	if (!ifNoneMatch) return false;
	const header = ifNoneMatch.trim();
	if (header === '*') return true;
	const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
	const want = opaque(etag);
	return header.split(',').some((tag) => opaque(tag) === want);
}
