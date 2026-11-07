import { describe, expect, it } from 'vitest';
import { DADCON_LEVELS, dadcon, dadconLevel } from '../src/lib/dadcon';

const TODAY = '2026-11-07';
const due = (dueDate: string | null) => ({ status: 'no' as const, dueDate });

describe('dadconLevel', () => {
	it('is 5 with no due date, or one more than 28 days away', () => {
		expect(dadconLevel(due(null), TODAY)).toBe(5);
		expect(dadconLevel(due('not-a-date'), TODAY)).toBe(5);
		expect(dadconLevel(due('2026-12-06'), TODAY)).toBe(5); // 29 days
	});

	it('is 4 from 28 days out to 8', () => {
		expect(dadconLevel(due('2026-12-05'), TODAY)).toBe(4); // 28 days
		expect(dadconLevel(due('2026-11-15'), TODAY)).toBe(4); // 8 days
	});

	it('is 3 for the last week, due date included', () => {
		expect(dadconLevel(due('2026-11-14'), TODAY)).toBe(3); // 7 days
		expect(dadconLevel(due('2026-11-08'), TODAY)).toBe(3);
		expect(dadconLevel(due(TODAY), TODAY)).toBe(3);
	});

	it('is 2 once overdue', () => {
		expect(dadconLevel(due('2026-11-06'), TODAY)).toBe(2);
		expect(dadconLevel(due('2026-10-01'), TODAY)).toBe(2);
	});

	it('is 1 while it is happening and 0 once Zack is a dad, whatever the due date', () => {
		expect(dadconLevel({ status: 'soon', dueDate: '2027-01-01' }, TODAY)).toBe(1);
		expect(dadconLevel({ status: 'soon', dueDate: null }, TODAY)).toBe(1);
		expect(dadconLevel({ status: 'yes', dueDate: '2026-10-01' }, TODAY)).toBe(0);
	});

	it('counts days in London dates across the clocks going back', () => {
		expect(dadconLevel(due('2026-10-29'), '2026-10-22')).toBe(3); // BST → GMT on the 25th
		expect(dadconLevel(due('2026-10-30'), '2026-10-22')).toBe(4);
	});
});

describe('dadcon', () => {
	it('names every level once, 5 down to 0', () => {
		expect(DADCON_LEVELS.map((l) => l.level)).toEqual([5, 4, 3, 2, 1, 0]);
		expect(dadcon({ status: 'soon', dueDate: null }, TODAY).name).toBe("IT'S HAPPENING");
		expect(dadcon({ status: 'yes', dueDate: null }, TODAY).name).toBe('DAD');
	});

	it('uses no pronouns for anyone', () => {
		for (const { name, description } of DADCON_LEVELS) {
			expect(`${name} ${description}`).not.toMatch(/\b(he|him|his|she|her|hers)\b/i);
		}
	});
});
