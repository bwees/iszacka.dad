import { describe, expect, it } from 'vitest';
import { FRUIT_BY_WEEK, babySize, formatGestation, gestationalAge } from '../src/lib/fruit';
import { addDays } from '../src/lib/time';

const DUE = '2026-12-01';

describe('gestationalAge', () => {
	it('treats the due date as exactly 40+0', () => {
		expect(gestationalAge(DUE, DUE)).toEqual({ week: 40, day: 0, totalDays: 280 });
	});

	it('counts back from the due date', () => {
		expect(gestationalAge(DUE, addDays(DUE, -1))).toMatchObject({ week: 39, day: 6 });
		expect(gestationalAge(DUE, addDays(DUE, -10))).toMatchObject({ week: 38, day: 4 });
	});

	it('is null before week 4, without a due date, or with nonsense', () => {
		expect(gestationalAge(DUE, addDays(DUE, -253))).toBeNull(); // 3+6
		expect(gestationalAge(DUE, addDays(DUE, -252))).toMatchObject({ week: 4, day: 0 });
		expect(gestationalAge(null, DUE)).toBeNull();
		expect(gestationalAge('2026-02-30', DUE)).toBeNull();
		expect(gestationalAge(DUE, 'yesterday')).toBeNull();
	});
});

describe('babySize', () => {
	it('has produce for every week from 4 to 40', () => {
		for (let week = 4; week <= 40; week++) {
			const entry = FRUIT_BY_WEEK[week];
			expect(entry, `week ${week}`).toBeDefined();
			expect(entry?.fruit.length).toBeGreaterThan(0);
			expect(entry?.emoji.length).toBeGreaterThan(0);
		}
	});

	it('starts with a poppy seed and ends with a watermelon', () => {
		expect(babySize(DUE, addDays(DUE, -252))).toMatchObject({ week: 4, day: 0, fruit: 'a poppy seed', overdue: false });
		expect(babySize(DUE, DUE)).toMatchObject({ week: 40, day: 0, fruit: 'a watermelon', emoji: '🍉', overdue: false, daysOverdue: 0 });
	});

	it('uses the whole week for days within it', () => {
		expect(babySize(DUE, addDays(DUE, -1))).toMatchObject({ week: 39, day: 6, fruit: 'a mini watermelon' });
		expect(babySize(DUE, addDays(DUE, -140))).toMatchObject({ week: 20, day: 0, fruit: 'a banana' });
		expect(babySize(DUE, addDays(DUE, -134))).toMatchObject({ week: 20, day: 6, fruit: 'a banana' });
	});

	it('switches to jokes once overdue', () => {
		expect(babySize(DUE, addDays(DUE, 1))).toMatchObject({
			week: 40,
			day: 1,
			fruit: 'a fully grown baby, frankly',
			overdue: true,
			daysOverdue: 1,
		});
		const later = babySize(DUE, addDays(DUE, 10));
		expect(later).toMatchObject({ week: 41, day: 3, overdue: true, daysOverdue: 10 });
		expect(later?.fruit).not.toBe('a fully grown baby, frankly');
		const silly = babySize(DUE, addDays(DUE, 40));
		expect(silly?.fruit).toMatch(/update the website/);
	});

	it('returns null without a due date or too early', () => {
		expect(babySize(null, DUE)).toBeNull();
		expect(babySize(DUE, addDays(DUE, -300))).toBeNull();
	});

	it('formats gestation the way maternity notes do', () => {
		expect(formatGestation({ week: 38, day: 4 })).toBe('38+4');
	});
});
