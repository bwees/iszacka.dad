import { describe, expect, it, vi } from 'vitest';

// pages.ts mounts fragments from other modules; stub them so these unit tests only
// exercise the frontend's own pure helpers.
vi.mock('../src/routes/subscribe', () => ({ emailSignupForm: () => '' }));
vi.mock('../src/routes/push', () => ({ pushWidget: () => '' }));
vi.mock('../src/routes/webhooks', () => ({ webhookForm: () => '' }));
vi.mock('../src/lib/counters', () => ({ getCheckTotal: async () => 0 }));
vi.mock('../src/lib/community', () => ({ getReadiness: async () => ({ done: 0, total: 0, percent: 0, items: [] }) }));
vi.mock('../src/lib/forecast', () => ({ dadForecast: () => [] }));
vi.mock('../src/lib/fruit', () => ({ babySize: () => null }));

const {
	countdownCopy,
	formatCount,
	formatDuration,
	geoFromRequest,
	greeting,
	londonMidnightMs,
	withArticle,
} = await import('../src/routes/pages');

const reqWithCf = (cf: Record<string, unknown> | undefined) => Object.assign(new Request('https://iszacka.dad/'), { cf }) as Request;

describe('formatDuration', () => {
	it('pads hours, minutes and seconds and omits zero days', () => {
		expect(formatDuration(0)).toBe('00h 00m 00s');
		expect(formatDuration(-5000)).toBe('00h 00m 00s');
		expect(formatDuration(65_000)).toBe('00h 01m 05s');
	});

	it('includes days when there are any', () => {
		expect(formatDuration(((3 * 24 + 4) * 3600 + 12 * 60 + 5) * 1000)).toBe('3d 04h 12m 05s');
	});
});

describe('formatCount', () => {
	it('uses British thousands separators and tolerates junk', () => {
		expect(formatCount(48213)).toBe('48,213');
		expect(formatCount(Number.NaN)).toBe('0');
		expect(formatCount(-3)).toBe('0');
		expect(formatCount(2.9)).toBe('2');
	});
});

describe('londonMidnightMs', () => {
	it('is 00:00 UTC in winter (GMT)', () => {
		expect(londonMidnightMs('2026-12-01')).toBe(Date.UTC(2026, 11, 1));
	});

	it('is 23:00 UTC the day before in summer (BST)', () => {
		expect(londonMidnightMs('2026-07-01')).toBe(Date.UTC(2026, 5, 30, 23));
	});
});

describe('countdownCopy', () => {
	const now = new Date('2026-11-06T12:00:00Z');

	it('counts up from the flip once Zack is a dad', () => {
		const c = countdownCopy({ status: 'yes', statusChangedAt: '2026-11-03T07:47:55Z', dueDate: '2026-11-20' }, now);
		expect(c.mode).toBe('dad');
		expect(c.label).toBe('Dad for');
		expect(c.value).toBe('3d 04h 12m 05s');
	});

	it('counts labour time while it is happening', () => {
		const c = countdownCopy({ status: 'soon', statusChangedAt: '2026-11-06T10:30:00Z', dueDate: null }, now);
		expect(c.mode).toBe('labour');
		expect(c.value).toBe('01h 30m 00s');
	});

	it('stands by without a due date', () => {
		expect(countdownCopy({ status: 'no', statusChangedAt: '', dueDate: null }, now).mode).toBe('no-due');
	});

	it('counts down to London midnight on the due date', () => {
		const c = countdownCopy({ status: 'no', statusChangedAt: '', dueDate: '2026-11-08' }, now);
		expect(c.mode).toBe('until-due');
		expect(c.value).toBe('1d 12h 00m 00s');
		expect(c.note).toMatch(/Sunday,? 8 November 2026/); // ICU versions differ on the comma
	});

	it('handles the due date itself', () => {
		const c = countdownCopy({ status: 'no', statusChangedAt: '', dueDate: '2026-11-06' }, now);
		expect(c.mode).toBe('due-today');
		expect(c.value).toBe('12h 00m 00s');
	});

	it('reports days overdue, singular and plural', () => {
		expect(countdownCopy({ status: 'no', statusChangedAt: '', dueDate: '2026-11-05' }, now).label).toBe('1 day overdue');
		const c = countdownCopy({ status: 'no', statusChangedAt: '', dueDate: '2026-11-01' }, now);
		expect(c.mode).toBe('overdue');
		expect(c.label).toBe('5 days overdue');
		expect(c.value).toBe('5d 12h 00m 00s');
	});
});

describe('geoFromRequest / greeting', () => {
	it('reads city, country and colo from request.cf', () => {
		const geo = geoFromRequest(reqWithCf({ city: 'Lisbon', country: 'PT', colo: 'LIS' }));
		expect(geo).toEqual({ city: 'Lisbon', country: 'Portugal', countryCode: 'PT', colo: 'LIS' });
		expect(greeting(geo)).toBe('Hello, visitor from Lisbon, Portugal.');
	});

	it('tolerates missing metadata (local dev)', () => {
		const geo = geoFromRequest(new Request('https://iszacka.dad/'));
		expect(geo).toEqual({ city: null, country: null, countryCode: null, colo: null });
		expect(greeting(geo)).toBe('Hello, visitor from parts unknown.');
	});

	it('handles Tor, unknown countries and odd values', () => {
		expect(geoFromRequest(reqWithCf({ country: 'T1' })).country).toBe('the Tor network');
		expect(geoFromRequest(reqWithCf({ country: 'XX' })).country).toBeNull();
		expect(geoFromRequest(reqWithCf({ country: 42, city: ['x'] }))).toMatchObject({ city: null, country: null });
		expect(geoFromRequest(reqWithCf({ city: 'Bad\u0000\u001fTown' })).city).toBe('BadTown');
		expect(greeting(geoFromRequest(reqWithCf({ country: 'FR' })))).toBe('Hello, visitor from France.');
	});
});

describe('withArticle', () => {
	it('picks a or an and leaves existing articles alone', () => {
		expect(withArticle('watermelon')).toBe('a watermelon');
		expect(withArticle('avocado')).toBe('an avocado');
		expect(withArticle('a large lime')).toBe('a large lime');
		expect(withArticle('  the moon ')).toBe('the moon');
	});
});
