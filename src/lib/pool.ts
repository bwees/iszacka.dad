// OWNER: fun agent.
// Baby pool: guesses of the moment the site flips to YES.
//
// Rules:
//   * a name (1-40 characters, shown publicly) and a moment, stored as ISO UTC;
//   * the moment must be in the future, and within 60 days before to 30 days after
//     the due date (or within the next 120 days if there's no due date yet);
//   * at most 3 guesses per person: on the web, per name on a connection (salted IP hash,
//     IPv6 /64) with a looser ceiling per connection, so a household or a party on one
//     Wi-Fi can all play; by email, per sender (salted address hash);
//   * the pool closes the instant Zack becomes a dad;
//   * closest guess to the YES moment wins; ties go to whoever guessed first.
//
// Every "local" time here is Europe/London, converted with the real GMT/BST
// rules (via Intl), including the hour that doesn't exist in March and the hour
// that happens twice in October.

import type { SiteState } from '../types';
import { DOMAIN } from './site';
import { getState } from './state';
import { TZ, addDays, formatLondon, formatLondonDate, isYmd, londonDate, nowIso } from './time';

export interface GuessInput {
	name: string;
	/** ISO UTC timestamp. */
	guessAt: string;
	source: 'web' | 'email';
	ipHash?: string | null;
}

/** Why a guess was refused (optional extra on the error result, for HTTP status codes). */
export type GuessErrorCode = 'invalid' | 'closed' | 'limit' | 'unavailable';

export type GuessResult = { ok: true; id: number } | { ok: false; error: string; code?: GuessErrorCode };

// ─── Rules ───────────────────────────────────────────────────────────────────

export const NAME_MAX_LENGTH = 40;
export const MAX_GUESSES_PER_PERSON = 3;
/** Web guesses per connection (IP or IPv6 /64), whatever the names: a house, not a botnet. */
export const MAX_GUESSES_PER_CONNECTION = 12;
export const WINDOW_DAYS_BEFORE_DUE = 60;
export const WINDOW_DAYS_AFTER_DUE = 30;
export const WINDOW_DAYS_WITHOUT_DUE = 120;

const DAY_MS = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Trim, collapse whitespace and drop control characters. */
export function normaliseName(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	return raw
		// Control and format characters (bidi overrides etc.), but keep the zero-width
		// joiner so emoji sequences survive.
		.replace(/(?!‍)[\p{Cc}\p{Cf}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Length in characters as a human counts them (code points, not UTF-16 units). */
function charLength(value: string): number {
	return [...value].length;
}

export function validateName(raw: unknown): { name: string } | { error: string } {
	const name = normaliseName(raw);
	if (!name) return { error: 'A name, please. Any name. It goes on the leaderboard.' };
	if (charLength(name) > NAME_MAX_LENGTH) {
		return { error: `Names can be at most ${NAME_MAX_LENGTH} characters. This is a leaderboard, not a guest list.` };
	}
	if (/https?:|www\.|\.(?:com|net|org|io|xyz|ru)\b/i.test(name)) return { error: 'Names, not links.' };
	if (/\S+@\S+\.\S+/.test(name)) {
		return { error: 'That looks like an email address. Names are shown publicly, so a first name will do.' };
	}
	return { name };
}

export interface GuessWindow {
	/** First London date guesses may fall on ('YYYY-MM-DD'), or null when there's no due date. */
	startDate: string | null;
	/** Last London date guesses may fall on ('YYYY-MM-DD'), or null when there's no due date. */
	endDate: string | null;
	/** Exclusive lower bound (now), ISO. */
	notBefore: string;
	/** Inclusive upper bound, ISO. */
	notAfter: string;
	/** Human description, e.g. "between Mon 2 Nov and Wed 30 Dec 2026". */
	description: string;
}

/** The window of acceptable guesses, given the state and the current moment. */
export function guessWindow(state: Pick<SiteState, 'dueDate'>, now: string): GuessWindow {
	const nowMs = Date.parse(now);
	if (isYmd(state.dueDate)) {
		const startDate = addDays(state.dueDate, -WINDOW_DAYS_BEFORE_DUE);
		const endDate = addDays(state.dueDate, WINDOW_DAYS_AFTER_DUE);
		const endLocal = londonLocalToUtc({ ...ymdParts(endDate), hour: 23, minute: 59 });
		const notAfter = 'iso' in endLocal ? endLocal.iso : new Date(Date.parse(`${endDate}T23:59:00Z`)).toISOString();
		return {
			startDate,
			endDate,
			notBefore: new Date(nowMs).toISOString(),
			notAfter,
			description: `between ${formatLondonDate(startDate)} and ${formatLondonDate(endDate)} (${WINDOW_DAYS_BEFORE_DUE} days before to ${WINDOW_DAYS_AFTER_DUE} days after the due date)`,
		};
	}
	const notAfter = new Date(nowMs + WINDOW_DAYS_WITHOUT_DUE * DAY_MS).toISOString();
	return {
		startDate: null,
		endDate: null,
		notBefore: new Date(nowMs).toISOString(),
		notAfter,
		description: `within the next ${WINDOW_DAYS_WITHOUT_DUE} days (there's no due date on file yet)`,
	};
}

/**
 * Pure validation of a guess against the rules (everything except the per-person
 * limit, which needs the database). Returns the cleaned name and normalised ISO.
 */
export function validateGuess(
	input: Pick<GuessInput, 'name' | 'guessAt'>,
	state: SiteState,
	now: string,
): { name: string; guessAt: string } | { error: string } {
	if (state.status === 'yes') return { error: 'The pool is closed: Zack is already a dad. Better luck next baby.' };
	const named = validateName(input.name);
	if ('error' in named) return named;

	if (typeof input.guessAt !== 'string' || !ISO_RE.test(input.guessAt) || !Number.isFinite(Date.parse(input.guessAt))) {
		return { error: 'That guess needs a valid date and time.' };
	}
	const at = Date.parse(input.guessAt);
	const guessAt = new Date(at).toISOString();
	const nowMs = Date.parse(now);
	if (!(at > nowMs)) {
		return { error: 'That moment has already happened (and Zack still was not a dad). Pick a time in the future.' };
	}

	const window = guessWindow(state, now);
	if (window.startDate && window.endDate) {
		const day = londonDate(new Date(at));
		if (day < window.startDate) {
			return { error: `Too early. Guesses must be ${window.description}.` };
		}
		if (day > window.endDate) {
			return { error: `Too late. Guesses must be ${window.description}. Induction would have had words by then.` };
		}
	} else if (at > Date.parse(window.notAfter)) {
		return { error: `Too far ahead. Guesses must be ${window.description}.` };
	}
	return { name: named.name, guessAt };
}

export async function submitGuess(env: Env, input: GuessInput): Promise<GuessResult> {
	try {
		const now = nowIso();
		const state = await getState(env, { fresh: true });
		const checked = validateGuess(input, state, now);
		if ('error' in checked) return { ok: false, error: checked.error, code: state.status === 'yes' ? 'closed' : 'invalid' };
		const source = input.source === 'email' ? 'email' : 'web';
		const ipHash = typeof input.ipHash === 'string' && input.ipHash ? input.ipHash : null;

		// One statement, so a status flip or a burst of submissions can't sneak past
		// the closing bell or the limits between a check and the insert. Email: 3 per sender.
		// Web: 3 per name on a connection, and a ceiling per connection. Names are stored
		// normalised, so lower() (ASCII folding) is enough to match them.
		const limits =
			source === 'email'
				? '(SELECT COUNT(*) FROM guesses WHERE ip_hash = ?4) < ?5'
				: `(SELECT COUNT(*) FROM guesses WHERE ip_hash = ?4 AND lower(name) = lower(?1)) < ?5
				   AND (SELECT COUNT(*) FROM guesses WHERE ip_hash = ?4) < ?6`;
		const result = await env.DB.prepare(
			`INSERT INTO guesses (name, guess_at, source, ip_hash)
			 SELECT ?1, ?2, ?3, ?4
			 WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'status' AND value = 'yes')
			   AND (?4 IS NULL OR (${limits}))`,
		)
			.bind(
				checked.name,
				checked.guessAt,
				source,
				ipHash,
				MAX_GUESSES_PER_PERSON,
				// Bind exactly the parameters the statement uses: SQLite refuses extras.
				...(source === 'email' ? [] : [MAX_GUESSES_PER_CONNECTION]),
			)
			.run();

		if (!result.meta.changes) {
			const latest = await getState(env, { fresh: true });
			if (latest.status === 'yes') {
				return { ok: false, error: 'The pool is closed: Zack is already a dad. Better luck next baby.', code: 'closed' };
			}
			if (source === 'email') {
				return {
					ok: false,
					error: `That's ${MAX_GUESSES_PER_PERSON} guesses from this address already. Hedging is one thing; this is a portfolio.`,
					code: 'limit',
				};
			}
			const sameName = await env.DB.prepare('SELECT COUNT(*) AS n FROM guesses WHERE ip_hash = ? AND lower(name) = lower(?)')
				.bind(ipHash, checked.name)
				.first<{ n: number }>();
			if ((sameName?.n ?? 0) >= MAX_GUESSES_PER_PERSON) {
				return {
					ok: false,
					error: `That's ${MAX_GUESSES_PER_PERSON} guesses under that name already. Spreading bets is fine; a portfolio isn't.`,
					code: 'limit',
				};
			}
			return {
				ok: false,
				error: `This connection has used up its guesses. Sharing Wi-Fi? Enter by email instead (ask@${DOMAIN}, subject 'guess').`,
				code: 'limit',
			};
		}
		return { ok: true, id: Number(result.meta.last_row_id) };
	} catch (err) {
		console.error('submitGuess failed:', err);
		return { ok: false, error: 'The pool is having a moment. Please try again shortly.', code: 'unavailable' };
	}
}

// ─── Europe/London local time ↔ UTC ──────────────────────────────────────────

export interface LocalDateTime {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
	timeZone: TZ,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hourCycle: 'h23',
});

/** London wall-clock fields for an instant. */
export function londonParts(ms: number): LocalDateTime & { second: number } {
	const map: Record<string, number> = {};
	for (const part of partsFormatter.formatToParts(new Date(ms))) {
		if (part.type !== 'literal') map[part.type] = Number(part.value);
	}
	return {
		year: map.year ?? 1970,
		month: map.month ?? 1,
		day: map.day ?? 1,
		hour: (map.hour ?? 0) % 24,
		minute: map.minute ?? 0,
		second: map.second ?? 0,
	};
}

/** London's offset from UTC at an instant, in minutes (0 for GMT, 60 for BST). */
export function londonOffsetMinutes(ms: number): number {
	const p = londonParts(ms);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

function ymdParts(ymd: string): Pick<LocalDateTime, 'year' | 'month' | 'day'> {
	return { year: Number(ymd.slice(0, 4)), month: Number(ymd.slice(5, 7)), day: Number(ymd.slice(8, 10)) };
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
] as const;

function monthName(month: number): string {
	return MONTH_NAMES[month - 1] ?? 'Smarch';
}

/**
 * Convert a Europe/London wall-clock time to a UTC instant.
 *
 * - In the spring-forward gap (e.g. 01:30 on the last Sunday of March) the
 *   time doesn't exist, so this returns an error rather than guessing.
 * - In the autumn fall-back overlap (01:00-01:59 on the last Sunday of
 *   October happens twice) it picks the first occurrence (still BST), the same
 *   as Temporal's "compatible" disambiguation.
 */
export function londonLocalToUtc(local: LocalDateTime): { iso: string } | { error: string } {
	const { year, month, day, hour, minute } = local;
	if (![year, month, day, hour, minute].every(Number.isInteger)) return { error: 'That date or time has bits missing.' };
	if (year < 1970 || year > 9999) return { error: `The year ${year} is outside the pool's jurisdiction.` };
	if (month < 1 || month > 12) return { error: `There is no month number ${month}.` };
	if (day < 1 || day > daysInMonth(year, month)) {
		return { error: `There is no ${day} ${monthName(month)}${month === 2 && day === 29 ? ` in ${year}` : ''}.` };
	}
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		return { error: `${pad2(hour)}:${pad2(minute)} isn't a time, even on a night feed.` };
	}

	const wall = Date.UTC(year, month - 1, day, hour, minute);
	const offsets = new Set([londonOffsetMinutes(wall - DAY_MS), londonOffsetMinutes(wall + DAY_MS)]);
	const candidates = [...offsets]
		.map((offset) => wall - offset * 60_000)
		.filter((ms) => {
			const p = londonParts(ms);
			return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
		})
		.sort((a, b) => a - b);
	const first = candidates[0];
	if (first === undefined) {
		return {
			error: `${pad2(hour)}:${pad2(minute)} on ${day} ${monthName(month)} ${year} doesn't exist in London: the clocks jump forward an hour at 01:00. Try ${pad2(hour + 1)}:${pad2(minute)} instead.`,
		};
	}
	return { iso: new Date(first).toISOString() };
}

/** Parse an <input type="datetime-local"> value ('YYYY-MM-DDTHH:MM[:SS]') as London time. */
export function parseLondonLocalInput(value: unknown): { iso: string } | { error: string } {
	if (typeof value !== 'string') return { error: 'Pick a date and time for your guess.' };
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
	if (!m) return { error: 'Pick a date and time for your guess.' };
	return londonLocalToUtc({ year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]! });
}

/** An instant as a datetime-local value in London time ('YYYY-MM-DDTHH:MM'). */
export function toLondonLocalInput(iso: string): string {
	const p = londonParts(Date.parse(iso));
	return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

// ─── Free-text guesses (email) ───────────────────────────────────────────────

const MONTH_PATTERN =
	'(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ORDINAL = '(?:st|nd|rd|th)?';

function monthFromName(name: string): number {
	const key = name.slice(0, 3).toLowerCase();
	return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(key) + 1;
}

interface DateMatch {
	index: number;
	length: number;
	year: number | null;
	month: number;
	day: number;
	/** Set when the match carried its own time (ISO forms). */
	time?: { hour: number; minute: number };
	/** Set when the match carried an explicit UTC offset: the instant is exact. */
	exactIso?: string;
	/** Two readings for numeric dates: day/month first, month/day as a fallback. */
	alternative?: { month: number; day: number };
	/** Hour to use when no time is given ("tonight" means the evening, not midday). */
	defaultHour?: number;
}

function expandYear(y: string | undefined): number | null {
	if (!y) return null;
	const n = Number(y);
	return y.length <= 2 ? 2000 + n : n;
}

function findExplicitDate(text: string): DateMatch | null {
	const found: DateMatch[] = [];
	const add = (re: RegExp, build: (m: RegExpExecArray) => Omit<DateMatch, 'index' | 'length'> | null) => {
		const m = re.exec(text);
		if (!m) return;
		const built = build(m);
		if (built) found.push({ index: m.index, length: m[0].length, ...built });
	};

	// 2026-11-14, 2026-11-14 15:30, 2026-11-14T15:30:00Z, 2026-11-14T15:30+01:00
	add(
		/\b(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:t|\s+(?:at\s+)?)(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(z|[+-]\d{2}:?\d{2})?(?![\d:]))?/i,
		(m) => {
			const base = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
			if (m[4] === undefined) return base;
			const time = { hour: Number(m[4]), minute: Number(m[5]) };
			if (!m[7]) return { ...base, time };
			const zone = m[7].toUpperCase() === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
			const iso = `${m[1]}-${pad2(base.month)}-${pad2(base.day)}T${pad2(time.hour)}:${pad2(time.minute)}:${m[6] ?? '00'}${zone}`;
			const ms = Date.parse(iso);
			return Number.isFinite(ms) ? { ...base, time, exactIso: new Date(ms).toISOString() } : { ...base, time };
		},
	);
	// 14 Nov, 14th November, 14 of Nov 2026, 14-Nov-2026
	add(new RegExp(`\\b(\\d{1,2})${ORDINAL}(?:\\s+of)?[\\s\\-/]*${MONTH_PATTERN}\\b\\.?(?:[\\s,\\-/]+(\\d{4})(?![\\d:]))?`, 'i'), (m) => ({
		year: expandYear(m[3]),
		month: monthFromName(m[2] as string),
		day: Number(m[1]),
	}));
	// November 14, Nov 14th, Nov 14, 2026
	add(new RegExp(`\\b${MONTH_PATTERN}\\.?\\s+(?:the\\s+)?(\\d{1,2})${ORDINAL}\\b(?![:.]\\d)(?:,?\\s+(\\d{4})(?![\\d:]))?`, 'i'), (m) => ({
		year: expandYear(m[3]),
		month: monthFromName(m[1] as string),
		day: Number(m[2]),
	}));
	// 14/11, 14/11/2026, 14/11/26 (British: day first; month first only if that's the only valid reading)
	add(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/, (m) => ({
		year: expandYear(m[3]),
		day: Number(m[1]),
		month: Number(m[2]),
		alternative: { month: Number(m[1]), day: Number(m[2]) },
	}));
	// 14.11.2026, 14-11-2026 (only with a year, so "15.30" stays a time)
	add(/(?<![\d.-])(\d{1,2})[.-](\d{1,2})[.-](\d{4})(?![\d.-])/, (m) => ({
		year: Number(m[3]),
		day: Number(m[1]),
		month: Number(m[2]),
		alternative: { month: Number(m[1]), day: Number(m[2]) },
	}));

	found.sort((a, b) => a.index - b.index || b.length - a.length);
	return found[0] ?? null;
}

interface TimeMatch {
	index: number;
	length: number;
	hour: number;
	minute: number;
}

function findTime(text: string): TimeMatch | { error: string } | null {
	const found: Array<TimeMatch | ({ error: string } & { index: number })> = [];
	const meridiem = (h: number, m: number, ap: string | undefined, index: number, length: number) => {
		if (ap) {
			const pm = ap.toLowerCase().startsWith('p');
			if (h < 1 || h > 12) {
				if (pm && h >= 13 && h <= 23) return { index, length, hour: h, minute: m };
				return { index, error: `${h}${pm ? 'pm' : 'am'} isn't a time, even on a night feed.` };
			}
			return { index, length, hour: (h % 12) + (pm ? 12 : 0), minute: m };
		}
		return { index, length, hour: h, minute: m };
	};
	// 15:30, 3:30pm, 3.30 p.m., 15h30
	const hm = /(?<![\d:.])(\d{1,2})[:.h](\d{2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?(?![\d])/i.exec(text);
	if (hm) {
		const h = Number(hm[1]);
		const m = Number(hm[2]);
		if (m > 59 || (!hm[3] && h > 23)) found.push({ index: hm.index, error: `${hm[1]}:${hm[2]} isn't a time, even on a night feed.` });
		else found.push(meridiem(h, m, hm[3], hm.index, hm[0].length));
	}
	// 3pm, 11 a.m.
	const h = /(?<![\d:.])(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i.exec(text);
	if (h) found.push(meridiem(Number(h[1]), 0, h[2], h.index, h[0].length));
	// noon, midday, midnight
	const word = /\b(noon|midday|midnight)\b/i.exec(text);
	if (word) {
		const midnight = (word[1] as string).toLowerCase() === 'midnight';
		found.push({ index: word.index, length: word[0].length, hour: midnight ? 0 : 12, minute: 0 });
	}
	found.sort((a, b) => a.index - b.index);
	const first = found[0];
	if (!first) return null;
	if ('error' in first) return { error: first.error };
	return first;
}

/** Drop quoted replies and signatures so "On Fri 6 Nov at 10:30, X wrote:" doesn't become a guess. */
function stripEmailNoise(text: string): string {
	const lines: string[] = [];
	for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
		if (/^--\s*$/.test(line) || /^_{5,}\s*$/.test(line)) break;
		if (/^\s*on\b.*\bwrote:\s*$/i.test(line) || /^-{2,}\s*original message\s*-{2,}/i.test(line)) break;
		if (/^\s*>/.test(line)) continue;
		if (/^\s*(?:sent from my|get outlook for)\b/i.test(line)) continue;
		lines.push(line);
	}
	return lines.join('\n');
}

/** Blank out a matched span so later searches don't trip over it. */
function blank(text: string, index: number, length: number): string {
	return text.slice(0, index) + ' '.repeat(length) + text.slice(index + length);
}

/** Midday, when a guess gives a date but no time. */
export const DEFAULT_GUESS_HOUR = 12;
/** "Tonight" with no time means 21:00. */
const TONIGHT_HOUR = 21;

/**
 * Parse a free-text guess (e.g. from an email: "GUESS: 14 Nov 15:30, Name: Alex").
 * Times are Europe/London. Returns the guess or a human-readable error.
 *
 * Understands, among others: "14 Nov 15:30", "14/11 3pm", "2026-11-14 15:30",
 * "November 14 at 3:30pm", "Sat 14th November 2026, 9.15am", "tomorrow at noon",
 * plus an optional "Name: Alex" anywhere (its own line, or after a comma).
 * Numeric dates are British (day first); "11/14" is read month-first only
 * because there is no 14th month. No year means the next 14 November that
 * hasn't already been and gone (today counts). No time means midday.
 */
export function parseGuessText(text: string, nowIso: string): { name?: string; guessAt: string } | { error: string } {
	if (typeof text !== 'string' || !text.trim()) {
		return { error: 'That was empty. Send a date and time, like "14 Nov 15:30".' };
	}
	const nowMs = Date.parse(nowIso);
	if (!Number.isFinite(nowMs)) return { error: 'The pool has lost track of time. Please try again.' };
	let body = stripEmailNoise(text.slice(0, 5000));

	let name: string | undefined;
	const nameMatch = /(?:^|[\s,;(])name\s*[:=]\s*([^\n,;]*)/i.exec(body);
	if (nameMatch) {
		const cleaned = normaliseName((nameMatch[1] as string).replace(/^["'“‘]+|["'”’.]+$/g, ''));
		if (cleaned) name = cleaned;
		body = blank(body, nameMatch.index, nameMatch[0].length);
	}

	const today = londonDate(new Date(nowMs));
	const todayParts = ymdParts(today);
	let date: DateMatch | null = findExplicitDate(body);
	if (!date) {
		const rel = /\b(today|tonight|tomorrow)\b/i.exec(body);
		if (rel) {
			const word = (rel[1] as string).toLowerCase();
			const ymd = word === 'tomorrow' ? addDays(today, 1) : today;
			date = {
				index: rel.index,
				length: rel[0].length,
				...ymdParts(ymd),
				...(word === 'tonight' ? { defaultHour: TONIGHT_HOUR } : {}),
			};
		}
	}
	if (!date) return { error: 'I couldn\'t find a date in that. Try something like "14 Nov 15:30".' };
	if (date.exactIso) return { ...(name ? { name } : {}), guessAt: date.exactIso };

	// Pick the reading of a numeric date that exists (British first).
	const valid = (month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= 31;
	if (!valid(date.month, date.day) && date.alternative && valid(date.alternative.month, date.alternative.day)) {
		date = { ...date, month: date.alternative.month, day: date.alternative.day };
	}
	if (date.month < 1 || date.month > 12) return { error: `There is no month number ${date.month}.` };

	let year = date.year;
	if (year === null) {
		// Next occurrence of this day and month, today included.
		const md = (m: number, d: number) => m * 100 + d;
		year = md(date.month, date.day) >= md(todayParts.month, todayParts.day) ? todayParts.year : todayParts.year + 1;
		if (date.month === 2 && date.day === 29) {
			for (let i = 0; i < 8 && daysInMonth(year, 2) < 29; i++) year += 1;
		}
	}

	let time = date.time;
	if (!time) {
		// Prefer a time on the same line as the date, then anywhere else.
		const rest = blank(body, date.index, date.length);
		const lineStart = rest.lastIndexOf('\n', date.index) + 1;
		const lineEnd = rest.indexOf('\n', date.index);
		const sameLine = rest.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
		const found = findTime(sameLine) ?? findTime(rest);
		if (found && 'error' in found) return found;
		time = found ? { hour: found.hour, minute: found.minute } : { hour: date.defaultHour ?? DEFAULT_GUESS_HOUR, minute: 0 };
	}

	const converted = londonLocalToUtc({ year, month: date.month, day: date.day, hour: time.hour, minute: time.minute });
	if ('error' in converted) return converted;
	return { ...(name ? { name } : {}), guessAt: converted.iso };
}

// ─── Reading guesses ─────────────────────────────────────────────────────────

export interface GuessRecord {
	id: number;
	name: string;
	/** ISO UTC. */
	guessAt: string;
	source: 'web' | 'email';
	hidden: boolean;
	createdAt: string;
}

interface GuessRow {
	id: number;
	name: string;
	guess_at: string;
	source: string;
	hidden: number;
	created_at: string;
}

const MAX_LISTED = 5000;

function rowToGuess(row: GuessRow): GuessRecord {
	return {
		id: row.id,
		name: row.name,
		guessAt: row.guess_at,
		source: row.source === 'email' ? 'email' : 'web',
		hidden: Boolean(row.hidden),
		createdAt: row.created_at,
	};
}

/** Guesses in guess order. Hidden guesses are left out unless asked for (admin). */
export async function listGuesses(env: Env, opts: { includeHidden?: boolean } = {}): Promise<GuessRecord[]> {
	const where = opts.includeHidden ? '' : 'WHERE hidden = 0';
	const { results } = await env.DB.prepare(
		`SELECT id, name, guess_at, source, hidden, created_at FROM guesses ${where} ORDER BY guess_at ASC, id ASC LIMIT ?`,
	)
		.bind(MAX_LISTED)
		.all<GuessRow>();
	return results.map(rowToGuess);
}

/** Hide or unhide a guess (moderation). Returns false if there's no such guess. */
export async function setGuessHidden(env: Env, id: number, hidden: boolean): Promise<boolean> {
	if (!Number.isSafeInteger(id) || id <= 0) return false;
	const result = await env.DB.prepare('UPDATE guesses SET hidden = ? WHERE id = ?')
		.bind(hidden ? 1 : 0, id)
		.run();
	return result.meta.changes > 0;
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export type GuessVerdict = 'winner' | 'ranked' | 'eliminated' | 'in-the-running';

export interface LeaderboardEntry extends GuessRecord {
	/** 1-based. Final mode: by closeness. Open mode: by guess time. */
	rank: number;
	verdict: GuessVerdict;
	/** Human summary, e.g. "👑 12 minutes early" or "still in the running". */
	label: string;
	/** Final mode: guess minus the YES moment, in ms (negative = early). */
	offsetMs: number | null;
}

export interface Leaderboard {
	mode: 'final' | 'open';
	entries: LeaderboardEntry[];
	winners: LeaderboardEntry[];
	inTheRunning: number;
	eliminated: number;
}

function plural(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** "2 days, 3 hours and 5 minutes" (largest units first, zeros dropped). */
export function describeDuration(ms: number): string {
	const totalMinutes = Math.round(Math.abs(ms) / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	const parts = [days && plural(days, 'day'), hours && plural(hours, 'hour'), minutes && plural(minutes, 'minute')].filter(
		(p): p is string => Boolean(p),
	);
	if (parts.length === 0) return 'less than a minute';
	if (parts.length === 1) return parts[0] as string;
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "12 minutes early", "3 hours late", "bang on the minute". */
export function describeOffset(offsetMs: number): string {
	if (Math.abs(offsetMs) < 60_000) return 'bang on the minute';
	return `${describeDuration(offsetMs)} ${offsetMs < 0 ? 'early' : 'late'}`;
}

/**
 * Rank guesses. With status `yes`, by distance from the YES moment (ties go to
 * the earlier entry) and the closest is crowned. Otherwise in guess order, with
 * guesses already in the past marked eliminated.
 */
export function buildLeaderboard(guesses: GuessRecord[], state: SiteState, now: string): Leaderboard {
	const visible = guesses.filter((g) => !g.hidden && Number.isFinite(Date.parse(g.guessAt)));
	const nowMs = Date.parse(now);

	if (state.status === 'yes') {
		const moment = Date.parse(state.statusChangedAt);
		const entries = visible
			.map((g) => ({ g, offset: Date.parse(g.guessAt) - moment }))
			.sort(
				(a, b) =>
					Math.abs(a.offset) - Math.abs(b.offset) ||
					a.g.createdAt.localeCompare(b.g.createdAt) ||
					a.g.id - b.g.id,
			)
			.map(({ g, offset }, i): LeaderboardEntry => ({
				...g,
				rank: i + 1,
				verdict: i === 0 ? 'winner' : 'ranked',
				label: `${i === 0 ? '👑 ' : ''}${describeOffset(offset)}`,
				offsetMs: offset,
			}));
		return { mode: 'final', entries, winners: entries.slice(0, 1), inTheRunning: 0, eliminated: 0 };
	}

	const entries = [...visible]
		.sort((a, b) => Date.parse(a.guessAt) - Date.parse(b.guessAt) || a.id - b.id)
		.map((g, i): LeaderboardEntry => {
			const out = Date.parse(g.guessAt) <= nowMs;
			return {
				...g,
				rank: i + 1,
				verdict: out ? 'eliminated' : 'in-the-running',
				label: out ? 'eliminated' : 'still in the running',
				offsetMs: null,
			};
		});
	const eliminated = entries.filter((e) => e.verdict === 'eliminated').length;
	return { mode: 'open', entries, winners: [], inTheRunning: entries.length - eliminated, eliminated };
}

// ─── Histogram & crowd wisdom ────────────────────────────────────────────────

export interface HistogramDay {
	/** 'YYYY-MM-DD' (Europe/London). */
	date: string;
	count: number;
}

/** Longest continuous run of days the histogram will fill with zeros. */
export const HISTOGRAM_MAX_DAYS = 150;

/**
 * Guesses per London day, as a continuous run of days from the earliest to the
 * latest guess (stretched to include `include` dates, e.g. the due date). Spans
 * longer than HISTOGRAM_MAX_DAYS only list days that have guesses.
 */
export function guessHistogram(guesses: Array<Pick<GuessRecord, 'guessAt'>>, include: Array<string | null> = []): HistogramDay[] {
	const counts = new Map<string, number>();
	for (const g of guesses) {
		const ms = Date.parse(g.guessAt);
		if (!Number.isFinite(ms)) continue;
		const day = londonDate(new Date(ms));
		counts.set(day, (counts.get(day) ?? 0) + 1);
	}
	if (counts.size === 0) return [];
	const days = [...counts.keys(), ...include.filter((d): d is string => isYmd(d))].sort();
	const first = days[0] as string;
	const last = days[days.length - 1] as string;
	const span = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS) + 1;
	if (span > HISTOGRAM_MAX_DAYS) {
		return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
	}
	return Array.from({ length: span }, (_, i) => {
		const date = addDays(first, i);
		return { date, count: counts.get(date) ?? 0 };
	});
}

/** The crowd's median guess (ISO), or null with no guesses. */
export function medianGuess(guesses: Array<Pick<GuessRecord, 'guessAt'>>): string | null {
	const times = guesses
		.map((g) => Date.parse(g.guessAt))
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	if (times.length === 0) return null;
	const mid = Math.floor(times.length / 2);
	const ms = times.length % 2 ? (times[mid] as number) : ((times[mid - 1] as number) + (times[mid] as number)) / 2;
	return new Date(Math.round(ms)).toISOString();
}

/** "Sat 14 Nov 2026, 15:30" in London time. */
export function formatGuess(iso: string): string {
	return formatLondon(iso);
}
