import { describe, expect, it } from 'vitest';
import {
	SUGGESTED_CHECKLIST,
	dadcon,
	missingSuggestions,
	readinessCommentary,
	readinessPercent,
	reorderIds,
	summariseReadiness,
} from '../src/lib/community';

const items = (pattern: string) => [...pattern].map((ch, i) => ({ label: `Item ${i + 1}`, done: ch === 'x' }));

describe('readinessPercent', () => {
	it('is 0 for an empty list', () => {
		expect(readinessPercent(0, 0)).toBe(0);
	});

	it('rounds to the nearest whole percent', () => {
		expect(readinessPercent(1, 3)).toBe(33);
		expect(readinessPercent(2, 3)).toBe(67);
		expect(readinessPercent(1, 2)).toBe(50);
		expect(readinessPercent(1, 8)).toBe(13);
	});

	it('only says 100 when everything is done', () => {
		expect(readinessPercent(199, 200)).toBe(99);
		expect(readinessPercent(999, 1000)).toBe(99);
		expect(readinessPercent(5, 5)).toBe(100);
	});

	it('only says 0 when nothing is done', () => {
		expect(readinessPercent(1, 1000)).toBe(1);
		expect(readinessPercent(0, 1000)).toBe(0);
	});

	it('copes with nonsense', () => {
		expect(readinessPercent(-1, 5)).toBe(0);
		expect(readinessPercent(7, 5)).toBe(100);
		expect(readinessPercent(Number.NaN, 5)).toBe(0);
		expect(readinessPercent(1, Number.POSITIVE_INFINITY)).toBe(0);
	});
});

describe('summariseReadiness', () => {
	it('summarises an empty checklist', () => {
		expect(summariseReadiness([])).toEqual({ done: 0, total: 0, percent: 0, items: [] });
	});

	it('counts done items and keeps order and labels only', () => {
		const r = summariseReadiness([
			{ label: 'Car seat installed', done: true, id: 4 } as { label: string; done: boolean },
			{ label: 'Pram folded', done: false },
			{ label: 'White noise', done: true },
		]);
		expect(r.done).toBe(2);
		expect(r.total).toBe(3);
		expect(r.percent).toBe(67);
		expect(r.items).toEqual([
			{ label: 'Car seat installed', done: true },
			{ label: 'Pram folded', done: false },
			{ label: 'White noise', done: true },
		]);
	});

	it('is 100% when all done', () => {
		expect(summariseReadiness(items('xxxx')).percent).toBe(100);
	});
});

describe('dadcon', () => {
	it('maps percentages onto five levels', () => {
		expect(dadcon(0).level).toBe(5);
		expect(dadcon(19).level).toBe(5);
		expect(dadcon(20).level).toBe(4);
		expect(dadcon(49).level).toBe(4);
		expect(dadcon(50).level).toBe(3);
		expect(dadcon(79).level).toBe(3);
		expect(dadcon(80).level).toBe(2);
		expect(dadcon(99).level).toBe(2);
		expect(dadcon(100).level).toBe(1);
	});
});

describe('readinessCommentary', () => {
	const at = (percent: number) => readinessCommentary({ percent, total: 10 }, 'no');

	it('has an empty-state line', () => {
		expect(readinessCommentary({ percent: 0, total: 0 }, 'no')).toMatch(/No checklist yet/);
	});

	it('changes with the percentage', () => {
		const lines = [0, 10, 30, 50, 70, 90, 97, 100].map(at);
		expect(new Set(lines).size).toBe(lines.length);
		expect(at(0)).toMatch(/none/i);
		expect(at(100)).toMatch(/Fully ready/);
		expect(at(97)).toMatch(/car seat/);
	});

	it('uses the same line within a band', () => {
		expect(at(41)).toBe(at(59));
		expect(at(80)).toBe(at(94));
	});

	it('adds a status-specific coda', () => {
		expect(readinessCommentary({ percent: 50, total: 4 }, 'soon')).toMatch(/Labour has started/);
		expect(readinessCommentary({ percent: 50, total: 4 }, 'yes')).toMatch(/purely academic/);
		expect(readinessCommentary({ percent: 50, total: 4 }, 'no')).not.toMatch(/academic|Labour/);
	});

	it('never uses gendered pronouns', () => {
		const all = [0, 10, 30, 50, 70, 90, 97, 100].flatMap((p) =>
			(['no', 'soon', 'yes'] as const).map((s) => readinessCommentary({ percent: p, total: 10 }, s)),
		);
		all.push(readinessCommentary({ percent: 0, total: 0 }, 'no'));
		for (const line of [...all, ...SUGGESTED_CHECKLIST]) {
			expect(line).not.toMatch(/\b(he|him|his|she|her|hers|himself|herself)\b/i);
		}
	});
});

describe('reorderIds', () => {
	it('moves an item up and down', () => {
		expect(reorderIds([1, 2, 3], 2, 'up')).toEqual([2, 1, 3]);
		expect(reorderIds([1, 2, 3], 2, 'down')).toEqual([1, 3, 2]);
	});

	it('refuses to move past the ends or unknown ids', () => {
		expect(reorderIds([1, 2, 3], 1, 'up')).toBeNull();
		expect(reorderIds([1, 2, 3], 3, 'down')).toBeNull();
		expect(reorderIds([1, 2, 3], 9, 'up')).toBeNull();
		expect(reorderIds([], 1, 'down')).toBeNull();
	});

	it('does not mutate its input', () => {
		const ids = [1, 2, 3];
		reorderIds(ids, 3, 'up');
		expect(ids).toEqual([1, 2, 3]);
	});
});

describe('suggested checklist', () => {
	it('has about ten universal items', () => {
		expect(SUGGESTED_CHECKLIST.length).toBeGreaterThanOrEqual(10);
		expect(new Set(SUGGESTED_CHECKLIST).size).toBe(SUGGESTED_CHECKLIST.length);
		for (const label of SUGGESTED_CHECKLIST) expect(label.length).toBeLessThanOrEqual(120);
	});

	it('only seeds what is missing, ignoring case and spacing', () => {
		const existing = ['  car seat installed (and the manual read,  twice) ', 'Something else entirely'];
		const missing = missingSuggestions(existing);
		expect(missing).not.toContain(SUGGESTED_CHECKLIST[0]);
		expect(missing).toHaveLength(SUGGESTED_CHECKLIST.length - 1);
		expect(missingSuggestions([...SUGGESTED_CHECKLIST])).toEqual([]);
	});

	it('does not suggest duplicates within the suggestions themselves', () => {
		expect(missingSuggestions([], ['A', 'a', 'B'])).toEqual(['A', 'B']);
	});
});
