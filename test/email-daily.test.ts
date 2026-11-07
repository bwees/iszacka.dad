import { describe, expect, it } from 'vitest';
import {
	CONCLUDED_TITLE,
	DAD_DAYS,
	DAD_DAY_LINES,
	DAILY_LINES,
	checksContext,
	dadDayLine,
	dailyLine,
	dayNumber,
	dueContext,
	planDailyPost,
} from '../src/lib/daily';
import type { SiteState } from '../src/types';

const GENDERED = /\b(he|she|him|her|hers|his|himself|herself)\b/i;

describe('daily lines', () => {
	it('has around thirty lines, none gendered, none starting with "Still no"', () => {
		expect(DAILY_LINES.length).toBeGreaterThanOrEqual(28);
		for (const line of [...DAILY_LINES, ...DAD_DAY_LINES]) {
			expect(line).not.toMatch(GENDERED);
			expect(line).not.toMatch(/^still no/i);
		}
	});

	it('is deterministic by day number', () => {
		expect(dailyLine(47)).toBe(dailyLine(47));
		expect(dailyLine(1)).toBe(DAILY_LINES[0]);
	});

	it('uses every line exactly once per cycle and never repeats on consecutive days', () => {
		const n = DAILY_LINES.length;
		const cycle = Array.from({ length: n }, (_, i) => dailyLine(i + 1));
		expect(new Set(cycle).size).toBe(n);
		for (let day = 1; day < 3 * n; day++) expect(dailyLine(day)).not.toBe(dailyLine(day + 1));
		expect(dailyLine(n + 5)).toBe(dailyLine(5));
	});

	it('copes with silly day numbers', () => {
		expect(DAILY_LINES).toContain(dailyLine(0));
		expect(DAILY_LINES).toContain(dailyLine(-3));
		expect(dadDayLine(0)).toBe(DAD_DAY_LINES[0]);
		expect(dadDayLine(99)).toBe(DAD_DAY_LINES[DAD_DAYS - 1]);
	});

	it('counts days from launch, launch day being Day 1', () => {
		expect(dayNumber('2026-11-01', '2026-11-01')).toBe(1);
		expect(dayNumber('2026-11-01', '2026-11-06')).toBe(6);
		expect(dayNumber('2026-11-10', '2026-11-06')).toBe(1);
	});
});

describe('due context', () => {
	it.each([
		[null, /no official due date/],
		['2026-11-20', /^14 days until the due date \(Friday,? 20 November 2026\)/],
		['2026-11-08', /^2 days until/],
		['2026-11-07', /tomorrow/],
		['2026-11-06', /Today is the due date/],
		['2026-11-05', /One day overdue/],
		['2026-11-01', /^5 days overdue/],
	])('due %s', (due, pattern) => {
		expect(dueContext(due, '2026-11-06')).toMatch(pattern);
	});

	it('formats checks with thousands separators', () => {
		expect(checksContext(12345)).toBe('The answer has been checked 12,345 times. It has not budged.');
		expect(checksContext(0)).toBeNull();
		expect(checksContext(null)).toBeNull();
	});
});

describe('planDailyPost', () => {
	const no: SiteState = { status: 'no', statusChangedAt: '2026-09-21T10:00:00.000Z', dueDate: '2026-11-20' };

	it('posts "Day N: still no." with the line, due context and checks', () => {
		const plan = planDailyPost({ today: '2026-11-06', launchDate: '2026-09-21', state: no, checks: 1500, concluded: false });
		expect(plan).toMatchObject({ action: 'post', phase: 'waiting', day: 47, title: 'Day 47: still no.', status: 'no' });
		if (plan.action !== 'post') throw new Error('expected a post');
		const [line, due, checks] = plan.body.split('\n\n');
		expect(line).toBe(dailyLine(47));
		expect(due).toMatch(/^14 days until the due date/);
		expect(checks).toBe('The answer has been checked 1,500 times. It has not budged.');
	});

	it('acknowledges labour in progress', () => {
		const plan = planDailyPost({ today: '2026-11-06', launchDate: '2026-11-06', state: { ...no, status: 'soon' }, concluded: false });
		expect(plan).toMatchObject({ action: 'post', title: "Day 1: still no (but it's happening).", status: 'soon' });
	});

	it('runs seven dad days after YES, then a farewell, then stops', () => {
		const yes: SiteState = { status: 'yes', statusChangedAt: '2026-11-10T14:00:00.000Z', dueDate: '2026-11-20' };
		const on = (today: string, concluded = false) => planDailyPost({ today, launchDate: '2026-09-21', state: yes, concluded });

		expect(on('2026-11-10')).toMatchObject({ action: 'skip' });
		for (let n = 1; n <= DAD_DAYS; n++) {
			const today = `2026-11-${String(10 + n).padStart(2, '0')}`;
			expect(on(today)).toMatchObject({ action: 'post', phase: 'dad-day', day: n, title: `Dad day ${n}: still yes.`, body: DAD_DAY_LINES[n - 1] });
		}
		expect(on('2026-11-18')).toMatchObject({ action: 'post', phase: 'concluded', title: CONCLUDED_TITLE });
		// A missed day doesn't lose the farewell; once sent, silence.
		expect(on('2026-11-25')).toMatchObject({ action: 'post', phase: 'concluded' });
		expect(on('2026-11-25', true)).toMatchObject({ action: 'skip' });
	});

	it('uses the London date of the YES (a 23:30 UTC yes in summer is the next London day)', () => {
		const yes: SiteState = { status: 'yes', statusChangedAt: '2026-06-01T23:30:00.000Z', dueDate: null };
		expect(planDailyPost({ today: '2026-06-02', launchDate: '2026-01-01', state: yes, concluded: false })).toMatchObject({ action: 'skip' });
		expect(planDailyPost({ today: '2026-06-03', launchDate: '2026-01-01', state: yes, concluded: false })).toMatchObject({ day: 1 });
	});
});
