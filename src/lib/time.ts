// Date/time helpers. The site's "local" time zone is Europe/London.

export const TZ = 'Europe/London';

export function nowIso(): string {
	return new Date().toISOString();
}

const ymdFormatter = new Intl.DateTimeFormat('en-CA', {
	timeZone: TZ,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

const hourFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });

/** Calendar date in Europe/London as 'YYYY-MM-DD'. */
export function londonDate(d: Date = new Date()): string {
	return ymdFormatter.format(d);
}

/** Hour of day (0-23) in Europe/London. */
export function londonHour(d: Date = new Date()): number {
	return Number(hourFormatter.format(d)) % 24;
}

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

/** Human date-time in London, e.g. "Fri 6 Nov 2026, 21:30". */
export function formatLondon(iso: string, opts: Intl.DateTimeFormatOptions = {}): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: TZ,
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		...opts,
	}).format(new Date(iso));
}

/** Human date in London, e.g. "Friday 6 November 2026". Accepts 'YYYY-MM-DD' or ISO. */
export function formatLondonDate(value: string): string {
	const iso = isYmd(value) ? `${value}T12:00:00Z` : value;
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: TZ,
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
	}).format(new Date(iso));
}
