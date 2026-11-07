// Date/time (and number) formatting helpers. The site's "local" time zone is Europe/London.
//
// CPU budget: on Workers Free every request gets 10 ms of CPU, and on a low-traffic site
// nearly every request lands in a fresh isolate. In workerd the first Intl call in an isolate
// (any Intl: a DateTimeFormat, a NumberFormat, toLocaleString, localeCompare) costs about
// 6-8 ms of CPU, and each further kind of Intl object about 0.5-1 ms more. So the hot paths
// never touch Intl:
//   * London's calendar date, hour and wall clock come from the fixed GMT/BST rule;
//   * the en-GB date and number formats the site uses are written by hand, byte for byte what
//     ICU 77 / CLDR 47 (Node 24 and workerd alike) produce. test/frontend-time.test.ts checks
//     them against Intl;
//   * anything else (other option sets, years outside the rule) falls back to Intl, with each
//     formatter built once per isolate and reused.

export const TZ = 'Europe/London';

export function nowIso(): string {
	return new Date().toISOString();
}

// ─── Memoised Intl formatters (the fallback) ─────────────────────────────────

/** Formatters are keyed by their options; call sites use a fixed handful, so this stays tiny. */
const MAX_CACHED_FORMATTERS = 64;
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

/** A stable cache key for an options object. Keys set to undefined count (they unset a default). */
function optionsKey(options: Intl.DateTimeFormatOptions | undefined): string {
	let key = '';
	if (options) for (const name in options) key += `|${name}=${String(options[name as keyof Intl.DateTimeFormatOptions])}`;
	return key;
}

/** `new Intl.DateTimeFormat(locale, options)`, built once per isolate per distinct locale + options. */
export function dateTimeFormat(locale: string, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${locale}${optionsKey(options)}`;
	let formatter = dateTimeFormats.get(key);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(locale, options);
		if (dateTimeFormats.size >= MAX_CACHED_FORMATTERS) dateTimeFormats.clear();
		dateTimeFormats.set(key, formatter);
	}
	return formatter;
}

let enGbNumbers: Intl.NumberFormat | undefined;

/** `new Intl.NumberFormat('en-GB')`, built once per isolate. */
export function numberFormat(): Intl.NumberFormat {
	enGbNumbers ??= new Intl.NumberFormat('en-GB');
	return enGbNumbers;
}

/**
 * A number the way `n.toLocaleString('en-GB')` writes it ("1,234,567"). Whole numbers, the
 * usual case (counts), are grouped by hand, which is byte-for-byte what en-GB does; anything
 * else goes through Intl.
 */
export function formatNumber(n: number): string {
	if (Number.isSafeInteger(n) && !Object.is(n, -0)) return String(n).replace(/\B(?=(\d{3})+$)/g, ',');
	return numberFormat().format(n);
}

// ─── Europe/London without Intl ──────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Years for which London's offset is computed from the rule below. Since 1996 the UK has
 * followed the EU rule: BST from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last
 * Sunday of October. Outside this range (and for invalid dates) Intl, i.e. tzdata, decides.
 */
const RULE_FIRST_YEAR = 1996;
const RULE_LAST_YEAR = 2099;

/** 01:00 UTC on the last Sunday of a month (0-based), as epoch ms. */
function lastSundayAt0100Utc(year: number, month: number): number {
	const lastDay = Date.UTC(year, month + 1, 0);
	return lastDay - new Date(lastDay).getUTCDay() * DAY_MS + HOUR_MS;
}

/** London's offset from UTC in ms at an instant (0 or 1 hour), or null to defer to Intl. */
export function londonOffsetMs(ms: number): number | null {
	const year = new Date(ms).getUTCFullYear();
	if (!(year >= RULE_FIRST_YEAR && year <= RULE_LAST_YEAR)) return null;
	return ms >= lastSundayAt0100Utc(year, 2) && ms < lastSundayAt0100Utc(year, 9) ? HOUR_MS : 0;
}

/** London wall-clock time as a Date to read with getUTC*(), or null to defer to Intl. */
function londonWallClock(ms: number): Date | null {
	const offset = londonOffsetMs(ms);
	return offset === null ? null : new Date(ms + offset);
}

const YMD_OPTIONS: Intl.DateTimeFormatOptions = { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' };
const HOUR_OPTIONS: Intl.DateTimeFormatOptions = { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' };

/** Calendar date in Europe/London as 'YYYY-MM-DD'. */
export function londonDate(d: Date = new Date()): string {
	const wall = londonWallClock(d.getTime());
	return wall ? wall.toISOString().slice(0, 10) : dateTimeFormat('en-CA', YMD_OPTIONS).format(d);
}

/** Hour of day (0-23) in Europe/London. */
export function londonHour(d: Date = new Date()): number {
	const wall = londonWallClock(d.getTime());
	return wall ? wall.getUTCHours() : Number(dateTimeFormat('en-GB', HOUR_OPTIONS).format(d)) % 24;
}

// ─── Calendar arithmetic ─────────────────────────────────────────────────────

export function isYmd(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const d = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Whole calendar days from `from` to `to` (both 'YYYY-MM-DD'). Positive if `to` is later. */
export function daysBetween(from: string, to: string): number {
	const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
	const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
	return Math.round((b - a) / 86_400_000);
}

/** Add days to a 'YYYY-MM-DD' date. */
export function addDays(ymd: string, days: number): string {
	const d = new Date(`${ymd}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

// ─── en-GB names (CLDR 47) ───────────────────────────────────────────────────

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
// Yes, "Sept": that is en-GB's abbreviation.
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'] as const;
const MONTH_LONG = [
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

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

// Readers for a Date holding a wall-clock time in its UTC fields.
const weekdayShort = (t: Date) => WEEKDAY_SHORT[t.getUTCDay()] as string;
const dayMonth = (t: Date) => `${t.getUTCDate()} ${MONTH_SHORT[t.getUTCMonth()] as string}`;
const dayMonthYear = (t: Date) => `${dayMonth(t)} ${t.getUTCFullYear()}`;
const hoursMinutes = (t: Date) => `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
const hoursMinutesSeconds = (t: Date) => `${hoursMinutes(t)}:${pad2(t.getUTCSeconds())}`;

type Shape = (wall: Date) => string;

const SHAPE_FIELDS = new Set(['timeZone', 'weekday', 'day', 'month', 'year', 'hour', 'minute', 'second']);

/**
 * The hand-written en-GB pattern for a full set of formatLondon options, or null for option
 * sets it doesn't know (those go to Intl). Covers every option set the site uses:
 *   default            "Fri, 6 Nov 2026, 21:30"      (+ second: "Fri, 6 Nov 2026, 21:30:05")
 *   no weekday/year    "6 Nov, 21:30"                (+ second: "6 Nov, 21:30:05")
 *   no time            "Fri, 6 Nov 2026"             (no weekday either: "6 Nov 2026")
 *   time only          "21:30"
 */
function shapeFor(o: Intl.DateTimeFormatOptions): Shape | null {
	for (const name in o) {
		if (!SHAPE_FIELDS.has(name) && o[name as keyof Intl.DateTimeFormatOptions] !== undefined) return null;
	}
	const { weekday, day, month, year, hour, minute, second } = o;
	if (o.timeZone !== TZ) return null;
	if (![undefined, 'short'].includes(weekday) || ![undefined, 'numeric'].includes(day) || ![undefined, 'short'].includes(month)) return null;
	if (![undefined, 'numeric'].includes(year) || ![undefined, '2-digit'].includes(hour) || ![undefined, '2-digit'].includes(minute)) return null;
	if (![undefined, '2-digit'].includes(second)) return null;
	const hasDate = day !== undefined && month !== undefined;
	const hasTime = hour !== undefined && minute !== undefined;
	if (!hasDate && (day || month || weekday || year)) return null;
	if (!hasTime && (hour || minute || second)) return null;
	const time = second ? hoursMinutesSeconds : hoursMinutes;
	if (hasDate && weekday && year) return hasTime ? (t) => `${weekdayShort(t)}, ${dayMonthYear(t)}, ${time(t)}` : (t) => `${weekdayShort(t)}, ${dayMonthYear(t)}`;
	if (hasDate && !weekday && !year && hasTime) return (t) => `${dayMonth(t)}, ${time(t)}`;
	if (hasDate && !weekday && year && !hasTime) return dayMonthYear;
	if (!hasDate && hasTime) return time;
	return null;
}

// ─── Human-readable London dates ─────────────────────────────────────────────

const LONDON_DEFAULTS: Intl.DateTimeFormatOptions = {
	timeZone: TZ,
	weekday: 'short',
	day: 'numeric',
	month: 'short',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
};

/** formatLondon's formatters by the caller's override options (call sites use a fixed few). */
const londonFormats = new Map<string, (ms: number) => string>();

function londonFormatter(opts: Intl.DateTimeFormatOptions): (ms: number) => string {
	const options = { ...LONDON_DEFAULTS, ...opts };
	const shape = shapeFor(options);
	let formatter: Intl.DateTimeFormat | undefined;
	const intl = (ms: number) => (formatter ??= new Intl.DateTimeFormat('en-GB', options)).format(ms);
	if (!shape) return intl;
	return (ms) => {
		const wall = londonWallClock(ms);
		return wall ? shape(wall) : intl(ms);
	};
}

/** Human date-time in London, e.g. "Fri, 6 Nov 2026, 21:30". */
export function formatLondon(iso: string, opts: Intl.DateTimeFormatOptions = {}): string {
	const key = optionsKey(opts);
	let format = londonFormats.get(key);
	if (!format) {
		format = londonFormatter(opts);
		if (londonFormats.size >= MAX_CACHED_FORMATTERS) londonFormats.clear();
		londonFormats.set(key, format);
	}
	return format(new Date(iso).getTime());
}

const LONDON_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
	timeZone: TZ,
	weekday: 'long',
	day: 'numeric',
	month: 'long',
	year: 'numeric',
};

/** Human date in London, e.g. "Friday, 6 November 2026". Accepts 'YYYY-MM-DD' or ISO. */
export function formatLondonDate(value: string): string {
	const ms = new Date(isYmd(value) ? `${value}T12:00:00Z` : value).getTime();
	const t = londonWallClock(ms);
	if (!t) return dateTimeFormat('en-GB', LONDON_DATE_OPTIONS).format(ms);
	return `${WEEKDAY_LONG[t.getUTCDay()] as string}, ${t.getUTCDate()} ${MONTH_LONG[t.getUTCMonth()] as string} ${t.getUTCFullYear()}`;
}

// ─── Calendar dates ('YYYY-MM-DD', no time zone involved) ────────────────────

const WEEKDAY_UTC: Intl.DateTimeFormatOptions = { weekday: 'short', timeZone: 'UTC' };
const DAY_MONTH_UTC: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };
const WEEKDAY_DAY_MONTH_UTC: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' };

/** Noon UTC on a calendar date, or null for anything that isn't one (Intl then decides). */
function calendarDate(ymd: string): Date | null {
	return isYmd(ymd) ? new Date(`${ymd}T12:00:00Z`) : null;
}

/** "Sat" for '2026-11-14'. */
export function formatWeekday(ymd: string): string {
	const t = calendarDate(ymd);
	return t ? weekdayShort(t) : dateTimeFormat('en-GB', WEEKDAY_UTC).format(new Date(`${ymd}T12:00:00Z`));
}

/** "14 Nov" for '2026-11-14'. */
export function formatDayMonth(ymd: string): string {
	const t = calendarDate(ymd);
	return t ? dayMonth(t) : dateTimeFormat('en-GB', DAY_MONTH_UTC).format(new Date(`${ymd}T12:00:00Z`));
}

/** "Sat 14 Nov" for '2026-11-14' (no comma in this one: CLDR's pattern, not ours). */
export function formatWeekdayDayMonth(ymd: string): string {
	const t = calendarDate(ymd);
	return t ? `${weekdayShort(t)} ${dayMonth(t)}` : dateTimeFormat('en-GB', WEEKDAY_DAY_MONTH_UTC).format(new Date(`${ymd}T12:00:00Z`));
}
