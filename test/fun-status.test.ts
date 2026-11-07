import { describe, expect, it } from 'vitest';
import {
	buildIncidents,
	dailyStatuses,
	formatPercent,
	healthBarClass,
	patienceHealth,
	statusComponents,
	timeInStatus,
	uptimeFraction,
	type HistoryEntry,
} from '../src/lib/forecast';

const born: HistoryEntry[] = [
	{ status: 'no', at: '2026-11-01T09:00:00.000Z' },
	{ status: 'soon', at: '2026-11-20T03:00:00.000Z' },
	{ status: 'yes', at: '2026-11-20T15:00:00.000Z' },
];

describe('dailyStatuses', () => {
	it('is grey before the site existed and uses the end-of-day status after', () => {
		const days = dailyStatuses(born, '2026-11-22', 90);
		expect(days).toHaveLength(90);
		expect(days[days.length - 1]).toEqual({ date: '2026-11-22', status: 'yes' });
		const byDate = new Map(days.map((d) => [d.date, d.status]));
		expect(byDate.get('2026-10-31')).toBeNull();
		expect(byDate.get('2026-11-01')).toBe('no');
		expect(byDate.get('2026-11-19')).toBe('no');
		// Labour and birth on the same day: the day ends as "yes".
		expect(byDate.get('2026-11-20')).toBe('yes');
	});

	it('uses London days, not UTC days', () => {
		// 23:30 UTC on 14 June is 00:30 on 15 June in London, so the 14th ends as "no".
		const history: HistoryEntry[] = [
			{ status: 'no', at: '2027-06-01T09:00:00.000Z' },
			{ status: 'yes', at: '2027-06-14T23:30:00.000Z' },
		];
		const byDate = new Map(dailyStatuses(history, '2027-06-16', 10).map((d) => [d.date, d.status]));
		expect(byDate.get('2027-06-14')).toBe('no');
		expect(byDate.get('2027-06-15')).toBe('yes');
	});

	it('copes with nothing at all', () => {
		expect(dailyStatuses([], '2026-11-06', 3)).toEqual([
			{ date: '2026-11-04', status: null },
			{ date: '2026-11-05', status: null },
			{ date: '2026-11-06', status: null },
		]);
		expect(dailyStatuses(born, 'not-a-date')).toEqual([]);
	});
});

describe('uptime', () => {
	it('adds up time in each status', () => {
		const totals = timeInStatus(born, '2026-11-20T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
		expect(totals.no).toBe(3 * 3_600_000);
		expect(totals.soon).toBe(12 * 3_600_000);
		expect(totals.yes).toBe(9 * 3_600_000);
	});

	it('reports the dad fraction since records began', () => {
		const fraction = uptimeFraction(born, '2026-11-21T00:00:00.000Z', ['yes']);
		expect(fraction).toBeGreaterThan(0);
		expect(fraction).toBeLessThan(0.05);
		expect(uptimeFraction([], '2026-11-21T00:00:00.000Z', ['yes'])).toBeNull();
		expect(uptimeFraction(born.slice(0, 1), '2026-11-06T00:00:00.000Z', ['yes'])).toBe(0);
	});

	it('formats percentages without rounding up to perfection', () => {
		expect(formatPercent(0)).toBe('0.00%');
		expect(formatPercent(1)).toBe('100.00%');
		expect(formatPercent(0.99999)).toBe('99.99%');
		expect(formatPercent(0.123456)).toBe('12.34%');
		expect(formatPercent(null)).toBe('—');
	});

	it('maps health to the UI kit bar colours', () => {
		expect(healthBarClass(null)).toBe('bar-none');
		expect(healthBarClass('operational')).toBe('bar-yes');
		expect(healthBarClass('degraded')).toBe('bar-soon');
		expect(healthBarClass('major')).toBe('bar-no');
	});
});

describe('statusComponents', () => {
	const find = (status: 'no' | 'soon' | 'yes', name: string, dueDate: string | null = '2026-12-01', today = '2026-11-20') =>
		statusComponents({ status, dueDate }, today).find((c) => c.name === name);

	it('runs Dad Service from major outage to operational', () => {
		expect(find('no', 'Dad Service')).toMatchObject({ health: 'major', label: 'Major outage' });
		expect(find('soon', 'Dad Service')).toMatchObject({ health: 'degraded', label: 'Degraded: in progress' });
		expect(find('yes', 'Dad Service')).toMatchObject({ health: 'operational', label: 'Operational' });
	});

	it('keeps nappies operational and takes sleep down after yes', () => {
		for (const s of ['no', 'soon', 'yes'] as const) expect(find(s, 'Nappy Supply')?.health).toBe('operational');
		expect(find('no', 'Sleep')?.health).toBe('operational');
		expect(find('soon', 'Sleep')?.health).toBe('operational');
		expect(find('yes', 'Sleep')).toMatchObject({ health: 'major', label: 'Major outage' });
	});

	it('degrades patience as the days overdue pile up', () => {
		expect(find('no', 'Patience', '2026-12-01', '2026-11-20')?.health).toBe('operational');
		expect(find('no', 'Patience', '2026-12-01', '2026-12-01')?.health).toBe('operational');
		expect(find('no', 'Patience', '2026-12-01', '2026-12-03')?.health).toBe('degraded');
		expect(find('no', 'Patience', '2026-12-01', '2026-12-07')?.health).toBe('partial');
		expect(find('no', 'Patience', '2026-12-01', '2026-12-15')?.health).toBe('major');
		expect(find('yes', 'Patience', '2026-12-01', '2026-12-15')?.health).toBe('operational');
		expect(find('no', 'Patience', null)?.health).toBe('operational');
		expect(patienceHealth('soon', '2026-12-01', '2026-12-15')).toBe('major');
		expect(patienceHealth('no', '2026-12-01', 'not-a-date')).toBe('operational');
	});

	it('has a few more components of its own, all with copy', () => {
		const all = statusComponents({ status: 'no', dueDate: null }, '2026-11-20');
		expect(all.length).toBeGreaterThanOrEqual(6);
		for (const c of all) {
			expect(c.label).toBeTruthy();
			expect(c.note).toBeTruthy();
			expect(c.note).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
		}
	});
});

describe('buildIncidents', () => {
	it('opens with an investigation', () => {
		const [incident, ...rest] = buildIncidents(born.slice(0, 1));
		expect(rest).toEqual([]);
		expect(incident).toMatchObject({ title: 'Zack is not a dad', resolvedAt: null });
		expect(incident?.updates.map((u) => u.title)).toEqual(['Investigating: Zack is not a dad']);
	});

	it('goes investigating → identified → resolved, newest first', () => {
		const [incident] = buildIncidents(born);
		expect(incident?.resolvedAt).toBe('2026-11-20T15:00:00.000Z');
		expect(incident?.updates.map((u) => u.title)).toEqual([
			'Resolved: Zack is a dad',
			'Identified: labour has started',
			'Investigating: Zack is not a dad',
		]);
	});

	it('treats labour stopping as monitoring, and a yes → no as a new incident', () => {
		const falseAlarm: HistoryEntry[] = [
			{ status: 'no', at: '2026-11-01T09:00:00.000Z' },
			{ status: 'soon', at: '2026-11-10T09:00:00.000Z' },
			{ status: 'no', at: '2026-11-10T19:00:00.000Z' },
		];
		expect(buildIncidents(falseAlarm)[0]?.updates[0]?.phase).toBe('monitoring');

		const oops: HistoryEntry[] = [...born, { status: 'no', at: '2026-11-20T15:05:00.000Z' }];
		const incidents = buildIncidents(oops);
		expect(incidents).toHaveLength(2);
		expect(incidents[0]?.title).toMatch(/again/);
		expect(incidents[0]?.resolvedAt).toBeNull();
		expect(incidents[1]?.resolvedAt).toBe('2026-11-20T15:00:00.000Z');
	});

	it('ignores repeats and junk', () => {
		const noisy = [born[0], born[0], { status: 'maybe', at: 'whenever' }, born[1], born[2]] as HistoryEntry[];
		expect(buildIncidents(noisy)[0]?.updates).toHaveLength(3);
	});
});
