// The pure helpers in public/delights.js. The module only boots in a browser, so importing it
// here just hands over its exports.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Achievement {
	id: string;
	emoji: string;
	name: string;
	description: string;
	hint?: string;
	secret?: boolean;
}
interface Store {
	v: number;
	unlocked: Record<string, string>;
	queue: string[];
	vibes: number;
	pages: string[];
	days: string[];
}
interface Step {
	on: boolean;
	ms: number;
}
interface Delights {
	ACHIEVEMENTS: readonly Achievement[];
	STORE_KEY: string;
	IDLE_MS: number;
	MORSE_UNIT_MS: number;
	CORNER_TOLERANCE: number;
	isYmd(value: unknown): boolean;
	localYmd(date: Date): string;
	normalisePath(path: unknown): string;
	isLivePath(path: string): boolean;
	blankStore(): Store;
	sanitiseStore(raw: unknown): Store;
	visitAchievements(ctx: { checks: number; days: string[]; pages: string[]; hour: number; status: string; path: string }): string[];
	vibeAchievements(vibes: number): string[];
	completionistDue(unlocked: Record<string, string>): boolean;
	applyUnlocks(store: Store, ids: string[], at: string): string[];
	londonHour(date: Date): number;
	isNightFeed(status: string, hour: number): boolean;
	awayTitle(status: string, siteName: string): string;
	flashTitle(status: string, siteName: string): string | null;
	morse(text: string): string;
	morseTimeline(text: string, unit?: number): Step[];
	gregorianLong(ymd: string): string;
	julianDate(ymd: string): { year: number; month: number; day: number } | null;
	julianText(ymd: string): string;
	discordian(ymd: string): string;
	stardate(ymd: string): number;
	stardateText(ymd: string): string;
	chineseYear(yearName: string): string;
	calendarRows(ymd: string): Array<{ name: string; value: string }>;
	bounceStep(
		s: { x: number; y: number; vx: number; vy: number },
		dt: number,
		maxX: number,
		maxY: number,
		tolerance?: number,
	): { x: number; y: number; vx: number; vy: number; hitX: boolean; hitY: boolean; corner: boolean };
	summaryLine(earned: number, total: number): string;
}

const MODULE = new URL('../public/delights.js', import.meta.url).href;
const d = (await import(/* @vite-ignore */ MODULE)) as Delights;
const SOURCE = readFileSync(join(import.meta.dirname, '../public/delights.js'), 'utf8');

const NAME = 'Is Zack a Dad?';

describe('achievements', () => {
	it('has at least 15, with unique ids and complete copy', () => {
		expect(d.ACHIEVEMENTS.length).toBeGreaterThanOrEqual(15);
		const ids = d.ACHIEVEMENTS.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const a of d.ACHIEVEMENTS) {
			expect(a.id).toMatch(/^[a-z-]+$/);
			expect(a.name.length, a.id).toBeGreaterThan(2);
			expect(a.description.length, a.id).toBeGreaterThan(10);
			expect(a.emoji.length, a.id).toBeGreaterThan(0);
			if (a.secret) expect(a.hint, a.id).toBeTruthy();
		}
	});

	it('includes the ones the brief asked for', () => {
		const names = d.ACHIEVEMENTS.map((a) => a.name);
		for (const name of [
			'Concerned Relative',
			'Obsessed',
			'Night Owl',
			'Early Bird',
			'Cheat Code',
			'Good Vibes',
			'Vibe Merchant',
			'Was Here When It Flipped',
			'Bookworm',
			'Weekend Warrior',
			'Patience of a Saint',
			'Terminal Enthusiast',
			'Screensaver Survivor',
			'Torchbearer',
		]) {
			expect(names).toContain(name);
		}
	});

	it('uses no gendered pronouns and no American spellings in its copy', () => {
		const prose = d.ACHIEVEMENTS.map((a) => `${a.name} ${a.description} ${a.hint ?? ''}`).join(' ');
		expect(prose.match(/\b(he|him|his|himself|she|her|hers|herself)\b/gi) ?? []).toEqual([]);
		expect(prose.match(/\b(color|favorite|diaper|mom)\b/gi) ?? []).toEqual([]);
	});

	it('awards visit achievements from checks, hours, days, pages, status and path', () => {
		const base = { checks: 1, days: ['2026-11-04'], pages: ['/'], hour: 12, status: 'no', path: '/' };
		expect(d.visitAchievements(base)).toEqual(['curious']);
		expect(d.visitAchievements({ ...base, checks: 10 })).toContain('concerned-relative');
		expect(d.visitAchievements({ ...base, checks: 10 })).not.toContain('obsessed');
		expect(d.visitAchievements({ ...base, checks: 100 })).toEqual(expect.arrayContaining(['concerned-relative', 'obsessed']));
		expect(d.visitAchievements({ ...base, hour: 2 })).toContain('night-owl');
		expect(d.visitAchievements({ ...base, hour: 4 })).toContain('night-owl');
		expect(d.visitAchievements({ ...base, hour: 5 })).not.toContain('night-owl');
		expect(d.visitAchievements({ ...base, hour: 5 })).toContain('early-bird');
		expect(d.visitAchievements({ ...base, hour: 7 })).not.toContain('early-bird');
		// 7 Nov 2026 is a Saturday, 8 Nov a Sunday.
		expect(d.visitAchievements({ ...base, days: ['2026-11-07'] })).not.toContain('weekend-warrior');
		expect(d.visitAchievements({ ...base, days: ['2026-11-07', '2026-11-15'] })).toContain('weekend-warrior');
		const week = ['01', '02', '03', '04', '05', '06', '07'].map((day) => `2026-12-${day}`);
		expect(d.visitAchievements({ ...base, days: week })).toContain('season-ticket');
		expect(d.visitAchievements({ ...base, days: week.slice(1) })).not.toContain('season-ticket');
		const pages = Array.from({ length: 10 }, (_, i) => `/p${i}`);
		expect(d.visitAchievements({ ...base, pages })).toContain('bookworm');
		expect(d.visitAchievements({ ...base, pages: pages.slice(1) })).not.toContain('bookworm');
		expect(d.visitAchievements({ ...base, status: 'yes' })).toContain('confirmed');
		expect(d.visitAchievements({ ...base, path: '/live' })).toContain('terminal');
		expect(d.visitAchievements({ ...base, path: '/achievements' })).toContain('achievement-hunter');
	});

	it('counts vibes', () => {
		expect(d.vibeAchievements(0)).toEqual([]);
		expect(d.vibeAchievements(1)).toEqual(['good-vibes']);
		expect(d.vibeAchievements(49)).toEqual(['good-vibes']);
		expect(d.vibeAchievements(50)).toEqual(['good-vibes', 'vibe-merchant']);
	});

	it('unlocks once, ignores unknown ids, and adds Completionist at the end', () => {
		const store = d.blankStore();
		const at = '2026-11-07T12:00:00.000Z';
		expect(d.applyUnlocks(store, ['curious', 'curious', 'nonsense'], at)).toEqual(['curious']);
		expect(d.applyUnlocks(store, ['curious'], at)).toEqual([]);
		const rest = d.ACHIEVEMENTS.map((a) => a.id).filter((id) => id !== 'completionist' && id !== 'curious');
		expect(d.completionistDue(store.unlocked)).toBe(false);
		const added = d.applyUnlocks(store, rest, at);
		expect(added.at(-1)).toBe('completionist');
		expect(Object.keys(store.unlocked).length).toBe(d.ACHIEVEMENTS.length);
	});
});

describe('the store', () => {
	it('survives anything localStorage might hold', () => {
		for (const junk of [null, undefined, 42, 'x', [], { unlocked: 'no' }, { pages: 'all' }, { vibes: -3 }, { vibes: 1.5 }]) {
			expect(d.sanitiseStore(junk)).toEqual(d.blankStore());
		}
	});

	it('keeps known unlocks, drops unknown ones and caps the lists', () => {
		const raw = JSON.parse(
			JSON.stringify({
				unlocked: { curious: '2026-11-07T00:00:00.000Z', bogus: 'x', obsessed: 7, ['__proto__']: 'x' },
				queue: ['curious', 'curious', 'obsessed', 'bogus'],
				vibes: 12,
				pages: ['/', '/', 'not-a-path', ...Array.from({ length: 80 }, (_, i) => `/p${i}`)],
				days: ['2026-11-07', '2026-02-30', 'yesterday', '2026-11-07'],
			}),
		);
		const s = d.sanitiseStore(raw);
		expect(s.unlocked).toEqual({ curious: '2026-11-07T00:00:00.000Z' });
		expect(s.queue).toEqual(['curious']);
		expect(s.vibes).toBe(12);
		expect(s.pages.length).toBe(40);
		expect(s.pages).not.toContain('not-a-path');
		expect(s.days).toEqual(['2026-11-07']);
		expect(Object.getPrototypeOf(s.unlocked)).toBe(Object.prototype);
	});

	it('normalises paths', () => {
		expect(d.normalisePath('/')).toBe('/');
		expect(d.normalisePath('/updates/')).toBe('/updates');
		expect(d.normalisePath('//')).toBe('/');
		expect(d.normalisePath(undefined)).toBe('/');
		expect(d.normalisePath(`/${'x'.repeat(500)}`).length).toBe(200);
		expect(d.isLivePath('/live')).toBe(true);
		expect(d.isLivePath('/live/ws')).toBe(true);
		expect(d.isLivePath('/lively')).toBe(false);
	});

	it('reads local dates in local time', () => {
		expect(d.localYmd(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
		expect(d.isYmd('2026-02-29')).toBe(false);
		expect(d.isYmd('2028-02-29')).toBe(true);
	});
});

describe('London time without Intl', () => {
	it('knows GMT from BST, including the changeover moments', () => {
		expect(d.londonHour(new Date('2026-12-01T02:30:00Z'))).toBe(2);
		expect(d.londonHour(new Date('2026-07-01T01:30:00Z'))).toBe(2);
		expect(d.londonHour(new Date('2026-07-01T23:30:00Z'))).toBe(0);
		// Clocks go forward at 01:00 UTC on 29 March 2026 and back at 01:00 UTC on 25 October.
		expect(d.londonHour(new Date('2026-03-29T00:59:00Z'))).toBe(0);
		expect(d.londonHour(new Date('2026-03-29T01:00:00Z'))).toBe(2);
		expect(d.londonHour(new Date('2026-10-25T00:59:00Z'))).toBe(1);
		expect(d.londonHour(new Date('2026-10-25T01:00:00Z'))).toBe(1);
		expect(d.londonHour(new Date('2026-10-25T02:00:00Z'))).toBe(2);
	});

	it('matches Intl for every hour of a year', () => {
		const intl = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' });
		for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3_600_000) {
			const date = new Date(t + 1_800_000);
			expect(d.londonHour(date), date.toISOString()).toBe(Number(intl.format(date)));
		}
	});

	it('only does night feeds after YES, from 02:00 to 05:00', () => {
		expect(d.isNightFeed('yes', 2)).toBe(true);
		expect(d.isNightFeed('yes', 4)).toBe(true);
		expect(d.isNightFeed('yes', 5)).toBe(false);
		expect(d.isNightFeed('yes', 1)).toBe(false);
		expect(d.isNightFeed('soon', 3)).toBe(false);
		expect(d.isNightFeed('no', 3)).toBe(false);
	});
});

describe('away titles', () => {
	it('fits the status', () => {
		expect(d.awayTitle('no', NAME)).toBe('(still no) Is Zack a Dad?');
		expect(d.awayTitle('soon', NAME)).toContain(NAME);
		expect(d.awayTitle('yes', NAME)).toContain(NAME);
		expect(d.awayTitle('nonsense', NAME)).toBe('(still no) Is Zack a Dad?');
	});

	it('only flashes for news', () => {
		expect(d.flashTitle('yes', NAME)).toBe('‼️ YES — Is Zack a Dad?');
		expect(d.flashTitle('soon', NAME)).toBe("🐣 IT'S HAPPENING — Is Zack a Dad?");
		expect(d.flashTitle('no', NAME)).toBeNull();
	});
});

describe('Morse code', () => {
	it('encodes the answers', () => {
		expect(d.morse('NO')).toBe('-. ---');
		expect(d.morse('YES')).toBe('-.-- . ...');
		expect(d.morse('NOT YET')).toBe('-. --- - / -.-- . -');
		expect(d.morse('n~o')).toBe('-. ---');
	});

	it('times dots, dashes and gaps in units', () => {
		const u = 250;
		expect(d.morseTimeline('NO', u)).toEqual([
			{ on: true, ms: 3 * u },
			{ on: false, ms: u },
			{ on: true, ms: u },
			{ on: false, ms: 3 * u },
			{ on: true, ms: 3 * u },
			{ on: false, ms: u },
			{ on: true, ms: 3 * u },
			{ on: false, ms: u },
			{ on: true, ms: 3 * u },
			{ on: false, ms: 7 * u },
		]);
		expect(d.MORSE_UNIT_MS).toBe(250);
	});

	it('never flashes more than twice in any second (WCAG 2.3.1 allows three)', () => {
		for (const text of ['NO', 'NOT YET', 'YES', 'SOS', 'EEEEE HI 5']) {
			const steps = d.morseTimeline(text);
			// Two loops back to back, as torch mode plays them.
			const onsets: number[] = [];
			let t = 0;
			for (const step of [...steps, ...steps]) {
				if (step.on) onsets.push(t);
				t += step.ms;
			}
			for (let i = 2; i < onsets.length; i++) {
				expect((onsets[i] ?? 0) - (onsets[i - 2] ?? 0), text).toBeGreaterThanOrEqual(1000);
			}
			// Every off gap is at least one unit, so on-periods never merge into a strobe.
			for (const step of steps) expect(step.ms).toBeGreaterThanOrEqual(d.MORSE_UNIT_MS);
			expect(steps.at(-1)).toEqual({ on: false, ms: 7 * d.MORSE_UNIT_MS });
		}
	});
});

describe('other calendars', () => {
	it('writes the Gregorian date out without Intl', () => {
		expect(d.gregorianLong('2026-11-20')).toBe('Friday 20 November 2026');
		expect(d.gregorianLong('nope')).toBe('');
	});

	it('converts to the Julian calendar', () => {
		expect(d.julianDate('2026-11-20')).toEqual({ year: 2026, month: 11, day: 7 });
		expect(d.julianDate('1582-10-15')).toEqual({ year: 1582, month: 10, day: 5 });
		expect(d.julianDate('2000-01-01')).toEqual({ year: 1999, month: 12, day: 19 });
		expect(d.julianText('2026-11-20')).toBe('7 November 2026');
		expect(d.julianDate('2026-13-01')).toBeNull();
	});

	it('knows its Discordian seasons, weekdays and holydays', () => {
		expect(d.discordian('2026-01-01')).toBe('Sweetmorn, Chaos 1, 3192 YOLD');
		expect(d.discordian('2026-01-05')).toBe('Setting Orange, Chaos 5, 3192 YOLD (Mungday)');
		expect(d.discordian('2026-02-19')).toBe('Setting Orange, Chaos 50, 3192 YOLD (Chaoflux)');
		expect(d.discordian('2026-11-20')).toBe('Prickle-Prickle, The Aftermath 32, 3192 YOLD');
		expect(d.discordian('2026-12-31')).toBe('Setting Orange, The Aftermath 73, 3192 YOLD');
		expect(d.discordian('2028-02-29')).toBe("St. Tib's Day, 3194 YOLD");
		expect(d.discordian('2028-03-01')).toBe(d.discordian('2026-03-01').replace('3192', '3194'));
	});

	it('computes the TrekGuide-style stardate', () => {
		expect(d.stardate('2323-01-01')).toBe(0);
		expect(d.stardate('2364-01-01')).toBe(41_000);
		expect(d.stardateText('2026-11-20')).toBe('−296115.1');
		expect(d.stardateText('nope')).toBe('');
	});

	it('names Chinese years', () => {
		expect(d.chineseYear('bing-wu')).toBe('Fire Horse');
		expect(d.chineseYear('ding-wei')).toBe('Fire Goat');
		expect(d.chineseYear('wu-zi')).toBe('Earth Rat');
		expect(d.chineseYear('nonsense')).toBe('');
		expect(d.chineseYear('constructor-toString')).toBe('');
	});

	it('builds every row, Intl calendars included', () => {
		const rows = d.calendarRows('2026-11-20');
		expect(rows.map((r) => r.name)).toEqual([
			'Hebrew',
			'Islamic (Umm al-Qura)',
			'Persian (Solar Hijri)',
			'Chinese',
			'Julian (Old Style)',
			'Discordian',
			'Stardate',
		]);
		const byName = Object.fromEntries(rows.map((r) => [r.name, r.value]));
		expect(byName.Hebrew).toBe('10 Kislev 5787');
		expect(byName['Persian (Solar Hijri)']).toContain('Aban 1405');
		expect(byName.Chinese).toBe('Day 12 of the Tenth Month, year of the Fire Horse');
		expect(d.calendarRows('')).toEqual([]);
	});
});

describe('the bouncing answer', () => {
	it('moves and reflects off walls', () => {
		const s = d.bounceStep({ x: 50, y: 50, vx: 100, vy: -100 }, 0.1, 500, 300);
		expect(s).toMatchObject({ x: 60, y: 40, hitX: false, hitY: false, corner: false });
		const wall = d.bounceStep({ x: 495, y: 150, vx: 100, vy: 100 }, 0.1, 500, 300);
		expect(wall).toMatchObject({ x: 500, vx: -100, hitX: true, hitY: false, corner: false });
	});

	it('calls a corner when both walls arrive together', () => {
		const exact = d.bounceStep({ x: 498, y: 298, vx: 100, vy: 100 }, 0.05, 500, 300);
		expect(exact).toMatchObject({ x: 500, y: 300, vx: -100, vy: -100, hitX: true, hitY: true, corner: true });
		const near = d.bounceStep({ x: 498, y: 294, vx: 100, vy: 100 }, 0.03, 500, 300);
		expect(near.hitX).toBe(true);
		expect(near.corner).toBe(true); // y ends 3 px from the floor, within the tolerance
		const miss = d.bounceStep({ x: 498, y: 200, vx: 100, vy: 100 }, 0.03, 500, 300);
		expect(miss).toMatchObject({ hitX: true, corner: false });
		expect(d.CORNER_TOLERANCE).toBeLessThanOrEqual(5);
	});

	it('eventually finds a corner on a long enough watch', () => {
		let s = { x: 0, y: 37, vx: 180, vy: 180 };
		let corners = 0;
		let bounces = 0;
		for (let i = 0; i < 60 * 60 * 30; i++) {
			const next = d.bounceStep(s, 1 / 60, 1100, 640);
			if (next.hitX || next.hitY) bounces++;
			if (next.corner) corners++;
			s = next;
		}
		expect(bounces).toBeGreaterThan(100);
		expect(corners).toBeGreaterThan(0);
		expect(corners).toBeLessThan(bounces / 5);
	});
});

describe('the summary line', () => {
	it('has something to say at every stage', () => {
		const total = d.ACHIEVEMENTS.length;
		const lines = new Set([0, 1, 5, total - 1, total].map((n) => d.summaryLine(n, total)));
		expect(lines.size).toBe(5);
	});
});

describe('delights.js source', () => {
	it('stays a browser module that does nothing at import outside a browser', () => {
		expect(SOURCE).toContain("if (typeof window !== 'undefined' && typeof document !== 'undefined'");
		expect(d.STORE_KEY).toBe('iszackadad:delights');
		expect(d.IDLE_MS).toBe(60_000);
	});

	it('never writes HTML from strings', () => {
		expect(SOURCE).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/);
	});

	it('never hands replaceChildren a null (the DOM would print it as the text "null")', () => {
		const calls: string[] = [];
		for (let at = SOURCE.indexOf('replaceChildren('); at !== -1; at = SOURCE.indexOf('replaceChildren(', at + 1)) {
			let depth = 0;
			let end = at + 'replaceChildren'.length;
			for (; end < SOURCE.length; end++) {
				if (SOURCE[end] === '(') depth++;
				else if (SOURCE[end] === ')' && --depth === 0) break;
			}
			calls.push(SOURCE.slice(at, end + 1));
		}
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) expect(call).not.toMatch(/\?\s*null\b|:\s*null\b/);
	});

	it('makes no network requests', () => {
		expect(SOURCE).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource/);
	});

	it('respects reduced motion for the screensaver', () => {
		expect(SOURCE).toMatch(/reducedMotion\(\)/);
		expect(SOURCE).toContain('prefers-reduced-motion: reduce');
	});
});
