import { describe, expect, it } from 'vitest';
import {
	MAX_GUESSES_PER_PERSON,
	buildLeaderboard,
	describeDuration,
	describeOffset,
	guessHistogram,
	guessWindow,
	londonLocalToUtc,
	londonOffsetMinutes,
	medianGuess,
	normaliseName,
	parseGuessText,
	parseLondonLocalInput,
	toLondonLocalInput,
	validateGuess,
	type GuessRecord,
} from '../src/lib/pool';
import type { SiteState } from '../src/types';

// Friday 6 November 2026, 21:00 in London (GMT).
const NOW = '2026-11-06T21:00:00.000Z';

const ok = (result: ReturnType<typeof parseGuessText>) => {
	if ('error' in result) throw new Error(`expected a guess, got: ${result.error}`);
	return result;
};
const err = (result: ReturnType<typeof parseGuessText>) => {
	if (!('error' in result)) throw new Error(`expected an error, got: ${JSON.stringify(result)}`);
	return result.error;
};

describe('Europe/London ↔ UTC', () => {
	it('knows GMT from BST', () => {
		expect(londonOffsetMinutes(Date.parse('2026-12-01T12:00:00Z'))).toBe(0);
		expect(londonOffsetMinutes(Date.parse('2027-06-01T12:00:00Z'))).toBe(60);
	});

	it('converts winter and summer wall-clock times', () => {
		expect(londonLocalToUtc({ year: 2026, month: 11, day: 14, hour: 15, minute: 30 })).toEqual({ iso: '2026-11-14T15:30:00.000Z' });
		expect(londonLocalToUtc({ year: 2027, month: 6, day: 14, hour: 15, minute: 30 })).toEqual({ iso: '2027-06-14T14:30:00.000Z' });
	});

	it('spring forward: 01:00-01:59 does not exist on 28 March 2027', () => {
		expect(londonLocalToUtc({ year: 2027, month: 3, day: 28, hour: 0, minute: 59 })).toEqual({ iso: '2027-03-28T00:59:00.000Z' });
		const gap = londonLocalToUtc({ year: 2027, month: 3, day: 28, hour: 1, minute: 30 });
		expect('error' in gap && gap.error).toMatch(/doesn't exist in London/);
		expect('error' in gap && gap.error).toMatch(/02:30/);
		expect(londonLocalToUtc({ year: 2027, month: 3, day: 28, hour: 2, minute: 0 })).toEqual({ iso: '2027-03-28T01:00:00.000Z' });
	});

	it('fall back: 01:00-01:59 happens twice on 31 October 2027, and the first (BST) wins', () => {
		expect(londonLocalToUtc({ year: 2027, month: 10, day: 31, hour: 0, minute: 30 })).toEqual({ iso: '2027-10-30T23:30:00.000Z' });
		expect(londonLocalToUtc({ year: 2027, month: 10, day: 31, hour: 1, minute: 30 })).toEqual({ iso: '2027-10-31T00:30:00.000Z' });
		expect(londonLocalToUtc({ year: 2027, month: 10, day: 31, hour: 2, minute: 0 })).toEqual({ iso: '2027-10-31T02:00:00.000Z' });
	});

	it('rejects dates and times that do not exist', () => {
		expect(londonLocalToUtc({ year: 2026, month: 11, day: 31, hour: 10, minute: 0 })).toEqual({ error: 'There is no 31 November.' });
		expect(londonLocalToUtc({ year: 2027, month: 2, day: 29, hour: 10, minute: 0 })).toEqual({ error: 'There is no 29 February in 2027.' });
		expect('error' in londonLocalToUtc({ year: 2026, month: 11, day: 14, hour: 24, minute: 0 })).toBe(true);
	});

	it('round-trips datetime-local values', () => {
		expect(parseLondonLocalInput('2026-11-14T15:30')).toEqual({ iso: '2026-11-14T15:30:00.000Z' });
		expect(parseLondonLocalInput('2027-06-14T15:30')).toEqual({ iso: '2027-06-14T14:30:00.000Z' });
		expect(toLondonLocalInput('2027-06-14T14:30:00.000Z')).toBe('2027-06-14T15:30');
		expect(toLondonLocalInput('2027-10-31T00:30:00.000Z')).toBe('2027-10-31T01:30');
		expect('error' in parseLondonLocalInput('next tuesday')).toBe(true);
		expect('error' in parseLondonLocalInput(undefined)).toBe(true);
	});
});

describe('parseGuessText', () => {
	it.each([
		['14 Nov 15:30', '2026-11-14T15:30:00.000Z'],
		['14/11 3pm', '2026-11-14T15:00:00.000Z'],
		['2026-11-14 15:30', '2026-11-14T15:30:00.000Z'],
		['November 14 at 3:30pm', '2026-11-14T15:30:00.000Z'],
		['Sat 14th November 2026, 9.15am', '2026-11-14T09:15:00.000Z'],
		['14 Nov 3:30 p.m.', '2026-11-14T15:30:00.000Z'],
		['3pm on the 14th of November', '2026-11-14T15:00:00.000Z'],
		['14/11/2026 15:30', '2026-11-14T15:30:00.000Z'],
		['14/11/26 15:30', '2026-11-14T15:30:00.000Z'],
		['14.11.2026 15:30', '2026-11-14T15:30:00.000Z'],
		['nov 14th 08:05', '2026-11-14T08:05:00.000Z'],
		['14 Nov 12am', '2026-11-14T00:00:00.000Z'],
		['14 Nov 12pm', '2026-11-14T12:00:00.000Z'],
		['14 Nov noon', '2026-11-14T12:00:00.000Z'],
		['14 Nov', '2026-11-14T12:00:00.000Z'],
		['tomorrow at 9am', '2026-11-07T09:00:00.000Z'],
		['tonight', '2026-11-06T21:00:00.000Z'],
		['2026-11-14T15:30:00Z', '2026-11-14T15:30:00.000Z'],
		['2026-11-14T15:30+01:00', '2026-11-14T14:30:00.000Z'],
	])('reads %j', (text, iso) => {
		expect(ok(parseGuessText(text, NOW)).guessAt).toBe(iso);
	});

	it('reads a "Name:" line, or a name after a comma', () => {
		expect(parseGuessText('14 Nov 15:30\nName: Alex', NOW)).toEqual({ name: 'Alex', guessAt: '2026-11-14T15:30:00.000Z' });
		expect(parseGuessText('GUESS: 14 Nov 15:30, Name: Alex', NOW)).toEqual({ name: 'Alex', guessAt: '2026-11-14T15:30:00.000Z' });
		expect(parseGuessText('name = "Sam the Great"\r\n20/11 at 18:45', NOW)).toEqual({
			name: 'Sam the Great',
			guessAt: '2026-11-20T18:45:00.000Z',
		});
		expect(ok(parseGuessText('14 Nov 15:30', NOW)).name).toBeUndefined();
	});

	it('uses BST for summer guesses', () => {
		expect(ok(parseGuessText('14 Jun 15:30', NOW)).guessAt).toBe('2027-06-14T14:30:00.000Z');
	});

	it('picks the next occurrence when the year is left out', () => {
		// 1 November has gone this year, so next year's.
		expect(ok(parseGuessText('1 Nov 10:00', NOW)).guessAt).toBe('2027-11-01T10:00:00.000Z');
		// Today counts as this year (and submitGuess will say it's in the past).
		expect(ok(parseGuessText('6 Nov 10:00', NOW)).guessAt).toBe('2026-11-06T10:00:00.000Z');
		// 29 February: the next one that exists.
		expect(ok(parseGuessText('29 Feb 10:00', NOW)).guessAt).toBe('2028-02-29T10:00:00.000Z');
		// January is next year.
		expect(ok(parseGuessText('3 Jan 07:00', NOW)).guessAt).toBe('2027-01-03T07:00:00.000Z');
	});

	it('handles DST edges in text', () => {
		expect(err(parseGuessText('28 Mar 2027 01:30', NOW))).toMatch(/doesn't exist/);
		expect(ok(parseGuessText('28 Mar 2027 02:30', NOW)).guessAt).toBe('2027-03-28T01:30:00.000Z');
		expect(ok(parseGuessText('31 Oct 2027 01:30', NOW)).guessAt).toBe('2027-10-31T00:30:00.000Z');
		expect(ok(parseGuessText('31/10/2027 1:30am', NOW)).guessAt).toBe('2027-10-31T00:30:00.000Z');
		expect(ok(parseGuessText('31 Oct 2027 02:30', NOW)).guessAt).toBe('2027-10-31T02:30:00.000Z');
	});

	it('is British about numeric dates, but forgiving when only one reading exists', () => {
		expect(ok(parseGuessText('1/12 10:00', NOW)).guessAt).toBe('2026-12-01T10:00:00.000Z');
		expect(ok(parseGuessText('11/14 15:30', NOW)).guessAt).toBe('2026-11-14T15:30:00.000Z');
	});

	it('ignores quoted replies and signatures', () => {
		const text = '15 Nov 09:00\n\nOn Fri, 6 Nov 2026 at 10:30, Someone wrote:\n> 20 Nov 10:00\n';
		expect(ok(parseGuessText(text, NOW)).guessAt).toBe('2026-11-15T09:00:00.000Z');
		const signed = 'My guess: 16 Nov 4pm\n-- \nSent at 10:30 from the office';
		expect(ok(parseGuessText(signed, NOW)).guessAt).toBe('2026-11-16T16:00:00.000Z');
		expect(err(parseGuessText('> 14 Nov 15:30', NOW))).toMatch(/couldn't find a date/);
	});

	it('explains what went wrong', () => {
		expect(err(parseGuessText('', NOW))).toMatch(/empty/);
		expect(err(parseGuessText('whenever, honestly', NOW))).toMatch(/couldn't find a date/);
		expect(err(parseGuessText('31 Nov 10:00', NOW))).toBe('There is no 31 November.');
		expect(err(parseGuessText('31/11 10:00', NOW))).toBe('There is no 31 November.');
		expect(err(parseGuessText('14 Nov 25:00', NOW))).toMatch(/isn't a time/);
		expect(err(parseGuessText('14 Nov 13am', NOW))).toMatch(/isn't a time/);
		expect(err(parseGuessText('14/13 10:00', NOW))).toMatch(/no month number 13|There is no/);
	});
});

const state = (over: Partial<SiteState> = {}): SiteState => ({
	status: 'no',
	statusChangedAt: '2026-11-01T00:00:00.000Z',
	dueDate: '2026-12-01',
	...over,
});

describe('validateGuess', () => {
	it('accepts a sensible guess and normalises it', () => {
		expect(validateGuess({ name: '  Alex   the   Bold ', guessAt: '2026-11-20T10:00:00Z' }, state(), NOW)).toEqual({
			name: 'Alex the Bold',
			guessAt: '2026-11-20T10:00:00.000Z',
		});
	});

	it('wants a 1-40 character name (counting emoji as one)', () => {
		const at = '2026-11-20T10:00:00Z';
		expect(validateGuess({ name: '   ', guessAt: at }, state(), NOW)).toHaveProperty('error');
		expect(validateGuess({ name: 'x'.repeat(40), guessAt: at }, state(), NOW)).toHaveProperty('name');
		expect(validateGuess({ name: 'x'.repeat(41), guessAt: at }, state(), NOW)).toHaveProperty('error');
		expect(validateGuess({ name: '🍼'.repeat(40), guessAt: at }, state(), NOW)).toHaveProperty('name');
		expect(validateGuess({ name: 'http://spam.example', guessAt: at }, state(), NOW)).toHaveProperty('error');
		expect(validateGuess({ name: 'me@example.com', guessAt: at }, state(), NOW)).toHaveProperty('error');
	});

	it('strips bidi overrides and control characters but keeps emoji sequences', () => {
		expect(normaliseName('Al‮ex\u0000')).toBe('Al ex');
		expect(normaliseName('👨‍🍼 Sam')).toBe('👨‍🍼 Sam');
	});

	it('wants a valid ISO time in the future', () => {
		expect(validateGuess({ name: 'A', guessAt: 'tomorrow' }, state(), NOW)).toHaveProperty('error');
		expect(validateGuess({ name: 'A', guessAt: '2026-11-06T20:59:00Z' }, state(), NOW)).toHaveProperty('error');
		expect(validateGuess({ name: 'A', guessAt: NOW }, state(), NOW)).toHaveProperty('error');
		expect(validateGuess({ name: 'A', guessAt: '2026-11-06T21:01:00Z' }, state(), NOW)).toHaveProperty('guessAt');
	});

	it('enforces due-60 to due+30 in London days', () => {
		const later = state({ dueDate: '2027-03-01' });
		// Window: 31 Dec 2026 to 31 Mar 2027.
		expect(validateGuess({ name: 'A', guessAt: '2026-12-30T23:59:00Z' }, later, NOW)).toHaveProperty('error');
		expect(validateGuess({ name: 'A', guessAt: '2026-12-31T00:00:00Z' }, later, NOW)).toHaveProperty('guessAt');
		// 31 March 2027 23:30 BST is 22:30 UTC: still the 31st in London.
		expect(validateGuess({ name: 'A', guessAt: '2027-03-31T22:30:00Z' }, later, NOW)).toHaveProperty('guessAt');
		// 23:30 UTC is 00:30 on 1 April in London: too late.
		const tooLate = validateGuess({ name: 'A', guessAt: '2027-03-31T23:30:00Z' }, later, NOW);
		expect('error' in tooLate && tooLate.error).toMatch(/Too late/);
	});

	it('allows the next 120 days without a due date', () => {
		const noDue = state({ dueDate: null });
		expect(validateGuess({ name: 'A', guessAt: '2027-03-05T20:00:00Z' }, noDue, NOW)).toHaveProperty('guessAt');
		expect(validateGuess({ name: 'A', guessAt: '2027-03-06T21:01:00Z' }, noDue, NOW)).toHaveProperty('error');
	});

	it('closes the pool once Zack is a dad', () => {
		const result = validateGuess({ name: 'A', guessAt: '2026-11-20T10:00:00Z' }, state({ status: 'yes' }), NOW);
		expect('error' in result && result.error).toMatch(/closed/);
	});

	it('describes the window', () => {
		const w = guessWindow(state(), NOW);
		expect(w.startDate).toBe('2026-10-02');
		expect(w.endDate).toBe('2026-12-31');
		expect(w.notAfter).toBe('2026-12-31T23:59:00.000Z');
		expect(MAX_GUESSES_PER_PERSON).toBe(3);
	});
});

const guess = (id: number, name: string, guessAt: string, extra: Partial<GuessRecord> = {}): GuessRecord => ({
	id,
	name,
	guessAt,
	source: 'web',
	hidden: false,
	createdAt: `2026-11-0${Math.min(id, 9)}T00:00:00.000Z`,
	...extra,
});

describe('buildLeaderboard', () => {
	const guesses = [
		guess(1, 'Early', '2026-11-10T09:00:00.000Z'),
		guess(2, 'Close', '2026-11-20T15:00:00.000Z'),
		guess(3, 'Closer', '2026-11-20T13:50:00.000Z'),
		guess(4, 'Late', '2026-12-10T09:00:00.000Z'),
		guess(5, 'Hidden', '2026-11-20T14:00:00.000Z', { hidden: true }),
	];

	it('ranks by distance from the YES moment and crowns the winner', () => {
		const board = buildLeaderboard(guesses, state({ status: 'yes', statusChangedAt: '2026-11-20T14:00:00.000Z' }), '2026-11-21T00:00:00.000Z');
		expect(board.mode).toBe('final');
		expect(board.entries.map((e) => e.name)).toEqual(['Closer', 'Close', 'Early', 'Late']);
		expect(board.winners.map((e) => e.name)).toEqual(['Closer']);
		expect(board.entries[0]).toMatchObject({ rank: 1, verdict: 'winner', offsetMs: -10 * 60_000 });
		expect(board.entries[0]?.label).toBe('👑 10 minutes early');
		expect(board.entries[1]?.label).toBe('1 hour late');
		expect(board.entries.some((e) => e.name === 'Hidden')).toBe(false);
	});

	it('breaks ties in favour of whoever guessed first', () => {
		const tie = [
			guess(7, 'Second', '2026-11-20T14:10:00.000Z', { createdAt: '2026-11-05T00:00:00.000Z' }),
			guess(8, 'First', '2026-11-20T13:50:00.000Z', { createdAt: '2026-11-02T00:00:00.000Z' }),
		];
		const board = buildLeaderboard(tie, state({ status: 'yes', statusChangedAt: '2026-11-20T14:00:00.000Z' }), NOW);
		expect(board.winners[0]?.name).toBe('First');
	});

	it('lists open pools by guess time, eliminating the past', () => {
		const board = buildLeaderboard(guesses, state(), '2026-11-15T00:00:00.000Z');
		expect(board.mode).toBe('open');
		expect(board.entries.map((e) => [e.name, e.verdict])).toEqual([
			['Early', 'eliminated'],
			['Closer', 'in-the-running'],
			['Close', 'in-the-running'],
			['Late', 'in-the-running'],
		]);
		expect(board.entries[0]?.label).toBe('eliminated');
		expect(board.entries[1]?.label).toBe('still in the running');
		expect(board.eliminated).toBe(1);
		expect(board.inTheRunning).toBe(3);
		expect(board.winners).toEqual([]);
	});
});

describe('durations and offsets', () => {
	it('reads like a person wrote it', () => {
		expect(describeOffset(0)).toBe('bang on the minute');
		expect(describeOffset(-59_000)).toBe('bang on the minute');
		expect(describeOffset(-60_000)).toBe('1 minute early');
		expect(describeOffset(3 * 3_600_000 + 5 * 60_000)).toBe('3 hours and 5 minutes late');
		expect(describeDuration(2 * 86_400_000 + 3_600_000 + 60_000)).toBe('2 days, 1 hour and 1 minute');
		expect(describeDuration(10_000)).toBe('less than a minute');
	});
});

describe('guessHistogram', () => {
	it('buckets by London day and fills gaps with zeros', () => {
		const days = guessHistogram([
			{ guessAt: '2026-11-14T10:00:00.000Z' },
			{ guessAt: '2026-11-14T23:30:00.000Z' }, // GMT: still the 14th
			{ guessAt: '2026-11-17T09:00:00.000Z' },
		]);
		expect(days).toEqual([
			{ date: '2026-11-14', count: 2 },
			{ date: '2026-11-15', count: 0 },
			{ date: '2026-11-16', count: 0 },
			{ date: '2026-11-17', count: 1 },
		]);
	});

	it('uses BST for summer days', () => {
		// 23:30 UTC on 14 June is 00:30 on 15 June in London.
		expect(guessHistogram([{ guessAt: '2027-06-14T23:30:00.000Z' }])).toEqual([{ date: '2027-06-15', count: 1 }]);
	});

	it('stretches to include the due date, and is empty without guesses', () => {
		const days = guessHistogram([{ guessAt: '2026-11-14T10:00:00.000Z' }], ['2026-11-16', null]);
		expect(days.map((d) => d.date)).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
		expect(guessHistogram([], ['2026-11-16'])).toEqual([]);
	});

	it('goes sparse rather than drawing hundreds of empty days', () => {
		const days = guessHistogram([{ guessAt: '2026-01-01T10:00:00.000Z' }, { guessAt: '2026-12-01T10:00:00.000Z' }]);
		expect(days).toHaveLength(2);
	});
});

describe('medianGuess', () => {
	it('finds the middle', () => {
		expect(medianGuess([])).toBeNull();
		expect(medianGuess([{ guessAt: '2026-11-20T10:00:00.000Z' }])).toBe('2026-11-20T10:00:00.000Z');
		expect(
			medianGuess([
				{ guessAt: '2026-11-20T10:00:00.000Z' },
				{ guessAt: '2026-11-20T12:00:00.000Z' },
				{ guessAt: '2026-11-01T00:00:00.000Z' },
				{ guessAt: '2026-12-31T00:00:00.000Z' },
			]),
		).toBe('2026-11-20T11:00:00.000Z');
	});
});
