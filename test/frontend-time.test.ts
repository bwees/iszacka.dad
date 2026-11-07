import { describe, expect, it } from 'vitest';
import { londonParts } from '../src/lib/pool';
import { regionName } from '../src/lib/counters-geo';
import {
	dateTimeFormat,
	formatDayMonth,
	formatLondon,
	formatLondonDate,
	formatNumber,
	formatWeekday,
	formatWeekdayDayMonth,
	londonDate,
	londonHour,
	londonOffsetMs,
	numberFormat,
} from '../src/lib/time';

// The reference: what Intl (tzdata) says, as the old code computed it.
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' });
const intlDate = (d: Date) => ymd.format(d);
const intlHour = (d: Date) => Number(hour.format(d)) % 24;

/** Instants either side of every GMT/BST change from 1996 to 2060, plus a spread of ordinary ones. */
function sampleInstants(): number[] {
	const out: number[] = [];
	for (let year = 1996; year <= 2060; year++) {
		for (const month of [2, 9]) {
			// Every day in the last week of March / October, at every hour around 01:00 UTC.
			for (let day = 24; day <= 31; day++) {
				for (const minutes of [-61, -60, -1, 0, 1, 59, 60, 61]) out.push(Date.UTC(year, month, day, 1, minutes) - 1, Date.UTC(year, month, day, 1, minutes));
			}
		}
		for (let i = 0; i < 24; i++) out.push(Date.UTC(year, 0, 1) + i * 15.3 * 86_400_000 + i * 3_599_999);
	}
	// New Year's Eve in both directions, and midnight in summer (the day boundary moves).
	out.push(Date.UTC(2026, 11, 31, 23, 59, 59, 999), Date.UTC(2027, 0, 1), Date.UTC(2026, 6, 1, 22, 59, 59), Date.UTC(2026, 6, 1, 23));
	return out;
}

describe('London date and hour without Intl', () => {
	it('agree with tzdata around every clock change since 1996', () => {
		let checked = 0;
		for (const ms of sampleInstants()) {
			const d = new Date(ms);
			expect(londonDate(d), d.toISOString()).toBe(intlDate(d));
			expect(londonHour(d), d.toISOString()).toBe(intlHour(d));
			checked++;
		}
		expect(checked).toBeGreaterThan(18_000);
	});

	it('knows the 2026 changes', () => {
		expect(londonOffsetMs(Date.UTC(2026, 2, 29, 0, 59, 59))).toBe(0);
		expect(londonOffsetMs(Date.UTC(2026, 2, 29, 1))).toBe(3_600_000);
		expect(londonOffsetMs(Date.UTC(2026, 9, 25, 0, 59, 59))).toBe(3_600_000);
		expect(londonOffsetMs(Date.UTC(2026, 9, 25, 1))).toBe(0);
		expect(londonDate(new Date('2026-07-01T23:30:00Z'))).toBe('2026-07-02');
		expect(londonHour(new Date('2026-07-01T23:30:00Z'))).toBe(0);
	});

	it('defers to Intl outside the rule (British Standard Time in 1970) and on invalid dates', () => {
		expect(londonOffsetMs(0)).toBeNull();
		expect(londonHour(new Date(0))).toBe(intlHour(new Date(0)));
		expect(londonDate(new Date(0))).toBe(intlDate(new Date(0)));
		expect(londonOffsetMs(Number.NaN)).toBeNull();
		expect(() => londonDate(new Date(Number.NaN))).toThrow(RangeError);
	});

	it('pool wall-clock parts agree with Intl', () => {
		const parts = new Intl.DateTimeFormat('en-GB', {
			timeZone: 'Europe/London',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		});
		for (const ms of sampleInstants().filter((_, i) => i % 7 === 0)) {
			const want = Object.fromEntries(parts.formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
			expect(londonParts(ms), new Date(ms).toISOString()).toEqual({ ...want, hour: (want.hour ?? 0) % 24 });
		}
	});
});

/**
 * The hand-written en-GB formats are byte-for-byte what ICU 77 / CLDR 47 produces, which is
 * what both Node 24 and workerd ship (checked against workerd directly). On a different CLDR
 * the comparison with Intl is skipped: the fixed examples below still pin the output.
 */
const SAME_CLDR = (process.versions.cldr ?? '').split('.')[0] === '47';

describe('hand-written London formats', () => {
	const fresh = (iso: string, opts: Intl.DateTimeFormatOptions = {}) =>
		new Intl.DateTimeFormat('en-GB', {
			timeZone: 'Europe/London',
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			...opts,
		}).format(new Date(iso));
	// Every option set used anywhere in src/, plus ones that must fall back to Intl.
	const sets: Intl.DateTimeFormatOptions[] = [
		{},
		{ weekday: undefined, year: undefined },
		{ weekday: undefined, year: undefined, second: '2-digit' },
		{ second: '2-digit' },
		{ hour: undefined, minute: undefined },
		{ weekday: undefined, day: undefined, month: undefined, year: undefined },
		{ weekday: undefined, hour: undefined, minute: undefined },
		// Fallbacks: shapes not written by hand.
		{ weekday: undefined },
		{ year: undefined },
		{ hour12: true },
		{ month: 'long' },
		{ timeZoneName: 'short' },
		{ timeZone: 'UTC' },
	];
	/** Every month, weekday and hour, both sides of each clock change, midnight and New Year. */
	const instants = (() => {
		const out: string[] = [];
		for (let i = 0; i < 400; i++) out.push(new Date(Date.UTC(2026, 0, 1) + i * 22.7 * 3_600_000 + i * 61_000 + (i % 60) * 1000).toISOString());
		for (const t of ['2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:59Z', '2026-10-25T01:00:00Z', '2026-07-01T23:00:00Z', '2026-12-31T23:59:59Z', '2027-01-01T00:00:00Z', '1970-01-01T00:00:00Z', '2150-06-01T12:00:00Z'])
			out.push(new Date(t).toISOString());
		return out;
	})();

	it('writes the formats the site uses', () => {
		const iso = '2026-09-06T20:30:05.000Z'; // 21:30:05 BST, a Sunday in Sept
		expect(formatLondon(iso)).toBe('Sun, 6 Sept 2026, 21:30');
		expect(formatLondon(iso, { second: '2-digit' })).toBe('Sun, 6 Sept 2026, 21:30:05');
		expect(formatLondon(iso, { weekday: undefined, year: undefined })).toBe('6 Sept, 21:30');
		expect(formatLondon(iso, { weekday: undefined, year: undefined, second: '2-digit' })).toBe('6 Sept, 21:30:05');
		expect(formatLondon(iso, { hour: undefined, minute: undefined })).toBe('Sun, 6 Sept 2026');
		expect(formatLondon(iso, { weekday: undefined, hour: undefined, minute: undefined })).toBe('6 Sept 2026');
		expect(formatLondon(iso, { weekday: undefined, day: undefined, month: undefined, year: undefined })).toBe('21:30');
		expect(formatLondon('2026-11-30T23:05:00Z', { weekday: undefined, day: undefined, month: undefined, year: undefined })).toBe('23:05');
		expect(formatLondon('2026-06-30T23:05:00Z', { weekday: undefined, year: undefined })).toBe('1 Jul, 00:05');
		expect(formatLondonDate('2026-11-08')).toBe('Sunday, 8 November 2026');
		expect(formatLondonDate('2026-07-01T23:30:00Z')).toBe('Thursday, 2 July 2026');
		expect(formatWeekday('2026-11-14')).toBe('Sat');
		expect(formatDayMonth('2026-09-04')).toBe('4 Sept');
		expect(formatWeekdayDayMonth('2026-11-14')).toBe('Sat 14 Nov');
	});

	it.runIf(SAME_CLDR)('matches Intl for every option set, instant and month', () => {
		for (const round of [1, 2]) {
			for (const opts of sets) {
				for (const iso of instants) expect(formatLondon(iso, opts), `${iso} ${JSON.stringify(Object.entries(opts))} round ${round}`).toBe(fresh(iso, opts));
			}
		}
		const long = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
		for (const iso of instants) expect(formatLondonDate(iso), iso).toBe(long.format(new Date(iso)));
		const utc = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' });
		for (let i = 0; i < 800; i++) {
			const ymd = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
			const noon = new Date(`${ymd}T12:00:00Z`);
			expect(formatLondonDate(ymd)).toBe(long.format(noon));
			expect(formatWeekday(ymd)).toBe(utc({ weekday: 'short' }).format(noon));
			expect(formatDayMonth(ymd)).toBe(utc({ day: 'numeric', month: 'short' }).format(noon));
			expect(formatWeekdayDayMonth(ymd)).toBe(utc({ weekday: 'short', day: 'numeric', month: 'short' }).format(noon));
		}
	});

	it('still throws on invalid dates, as Intl did', () => {
		expect(() => formatLondon('not a date')).toThrow(RangeError);
		expect(() => formatLondonDate('not a date')).toThrow(RangeError);
		expect(() => formatWeekday('nonsense')).toThrow(RangeError);
		// Not a calendar date, so Intl decides, exactly as before (V8 reads it as 2 March).
		expect(formatWeekday('2026-02-30')).toBe(new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date('2026-02-30T12:00:00Z')));
	});

	it('tells "unset this default" apart from "no override"', () => {
		// JSON.stringify would drop the undefined keys and confuse these two.
		const iso = '2026-11-06T21:30:05.000Z';
		expect(formatLondon(iso, {})).not.toBe(formatLondon(iso, { weekday: undefined }));
		expect(formatLondon(iso, { weekday: undefined })).toBe(fresh(iso, { weekday: undefined }));
	});

	it('builds each Intl fallback formatter once', () => {
		const a = dateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });
		const b = dateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });
		const c = dateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' });
		expect(b).toBe(a);
		expect(c).not.toBe(a);
		expect(numberFormat()).toBe(numberFormat());
	});
});

describe('region names', () => {
	// workerd's ICU data names these differently from Node's; the table follows workerd, which is
	// what production ran before (and so what the pages said).
	const WORKERD = { FK: 'Falkland Islands (Islas Malvinas)', HK: 'Hong Kong', MO: 'Macao', PS: 'Palestine' } as Record<string, string>;

	it('knows the usual suspects', () => {
		expect(regionName('GB')).toBe('United Kingdom');
		expect(regionName('PT')).toBe('Portugal');
		expect(regionName('CI')).toBe('Côte d’Ivoire');
		expect(regionName('TR')).toBe('Türkiye');
		expect(regionName('HK')).toBe('Hong Kong');
		expect(regionName('AA')).toBeNull();
		expect(regionName('gb')).toBeNull();
		expect(regionName('GBR')).toBeNull();
		expect(regionName('')).toBeNull();
	});

	it.runIf(SAME_CLDR)('matches Intl.DisplayNames for every two-letter code (bar workerd’s four)', () => {
		const dn = new Intl.DisplayNames(['en-GB'], { type: 'region' });
		for (let a = 65; a <= 90; a++) {
			for (let b = 65; b <= 90; b++) {
				const code = String.fromCharCode(a, b);
				const intl = dn.of(code);
				expect(regionName(code), code).toBe(WORKERD[code] ?? (intl && intl !== code ? intl : null));
			}
		}
	});
});

describe('formatNumber', () => {
	it('writes numbers exactly as toLocaleString("en-GB") does', () => {
		const values = [0, -0, 1, 7, 12, 999, 1000, 1001, 12_345, 99_999, 100_000, 123_456_789, -1, -999, -1000, -1_234_567, Number.MAX_SAFE_INTEGER, 1e21, 2.5, 1234.5678, 0.0001, -0.5];
		for (let n = 0; n < 2_000_000; n += 997) values.push(n);
		for (const n of values) expect(formatNumber(n), String(n)).toBe(n.toLocaleString('en-GB'));
	});
});
