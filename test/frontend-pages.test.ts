import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, SiteState, Status } from '../src/types';

// pages.ts mounts fragments from other modules; stub them so these unit tests only
// exercise the frontend's own pure helpers.
vi.mock('../src/routes/subscribe', () => ({ emailSignupForm: () => '' }));
vi.mock('../src/routes/push', () => ({ pushWidget: () => '' }));
vi.mock('../src/routes/webhooks', () => ({ webhookForm: () => '' }));
const counters = vi.hoisted(() => ({ getCheckTotal: vi.fn(async () => 0) }));
vi.mock('../src/lib/counters', () => ({ getCheckTotal: counters.getCheckTotal }));
vi.mock('../src/lib/community', () => ({ getReadinessSummary: async () => ({ done: 0, total: 0, percent: 0 }) }));
const pure = vi.hoisted(() => ({
	dadForecast: vi.fn((_due: string | null, today: string, status: string) => [
		{ date: today, probability: status === 'soon' ? 0.95 : 0, label: `Forecast for ${status}`, emoji: '☀️' },
	]),
	babySize: vi.fn(() => ({ week: 39, day: 2, fruit: 'a mini watermelon', emoji: '🍉' })),
}));
vi.mock('../src/lib/forecast', () => ({ dadForecast: pure.dadForecast }));
vi.mock('../src/lib/fruit', () => ({ babySize: pure.babySize }));

const {
	countdownCopy,
	formatCount,
	formatDuration,
	geoFromRequest,
	greeting,
	londonMidnightMs,
	pageRoutes,
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

describe('GET / live numbers', () => {
	async function homeWith(env: Partial<Env>): Promise<string> {
		const app = new Hono<AppEnv>();
		app.use('*', async (c, next) => {
			c.set('state', { status: 'no', statusChangedAt: '2026-11-01T00:00:00.000Z', dueDate: null });
			await next();
		});
		app.route('/', pageRoutes);
		const res = await app.request('https://iszacka.dad/', {}, env as Env);
		expect(res.status).toBe(200);
		return res.text();
	}

	it('asks the waiting room once, for viewers, vibes and checks together', async () => {
		const room = { liveSnapshot: vi.fn(async () => ({ viewers: 3, vibes: 7, checks: 48213, reloadNonce: 'n' })), stats: vi.fn() };
		counters.getCheckTotal.mockClear();
		const page = await homeWith({ WAITING_ROOM: { idFromName: () => 'global', get: () => room } as unknown as Env['WAITING_ROOM'] });
		expect(room.liveSnapshot).toHaveBeenCalledTimes(1);
		expect(room.stats).not.toHaveBeenCalled();
		expect(counters.getCheckTotal).not.toHaveBeenCalled();
		expect(page).toContain('<p class="big-number" data-live="checks">48,213</p>');
		expect(page).toContain('<p class="big-number" data-live="viewers">3</p>');
	});

	it('falls back to getCheckTotal when the waiting room is down', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		counters.getCheckTotal.mockClear();
		counters.getCheckTotal.mockResolvedValueOnce(12);
		const page = await homeWith({});
		expect(counters.getCheckTotal).toHaveBeenCalledTimes(1);
		expect(page).toContain('<p class="big-number" data-live="checks">12</p>');
		vi.restoreAllMocks();
	});
});

describe('GET / fragment caching', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function home(state: SiteState): Promise<string> {
		const app = new Hono<AppEnv>();
		app.use('*', async (c, next) => {
			c.set('state', state);
			await next();
		});
		app.route('/', pageRoutes);
		const res = await app.request('https://iszacka.dad/', { headers: { 'accept-language': 'en-GB' } }, {} as Env);
		expect(res.status).toBe(200);
		return res.text();
	}

	const variant = (page: string, s: Status) => page.match(new RegExp(`<div class="stack" data-status-variant="${s}"( hidden)?>[^]*?</div>`))?.[0] ?? '';

	it('renders the forecast and fruit once per status, due date and London day', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.useFakeTimers({ now: new Date('2026-11-07T10:00:00Z'), toFake: ['Date'] });
		const state: SiteState = { status: 'no', statusChangedAt: '2026-11-01T00:00:00.000Z', dueDate: '2026-11-09' };
		pure.dadForecast.mockClear();
		pure.babySize.mockClear();

		const first = await home(state);
		expect(pure.dadForecast).toHaveBeenCalledTimes(3); // one strip per status
		expect(pure.babySize).toHaveBeenCalledTimes(1);
		expect(first).toContain('Forecast for no');
		expect(first).toContain('a mini watermelon');
		expect(first).toContain('The answer in');

		// Same inputs: served from the per-isolate cache, byte for byte.
		const second = await home(state);
		expect(pure.dadForecast).toHaveBeenCalledTimes(3);
		expect(pure.babySize).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);

		// A new London day re-renders.
		vi.setSystemTime(new Date('2026-11-08T10:00:00Z'));
		await home(state);
		expect(pure.dadForecast).toHaveBeenCalledTimes(6);
		expect(pure.dadForecast).toHaveBeenLastCalledWith('2026-11-09', '2026-11-08', 'yes');

		// So does a new due date.
		await home({ ...state, dueDate: '2026-11-10' });
		expect(pure.dadForecast).toHaveBeenCalledTimes(9);
	});

	it('shows the variant for the current status when the status changes', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.useFakeTimers({ now: new Date('2026-11-07T10:00:00Z'), toFake: ['Date'] });
		const no = await home({ status: 'no', statusChangedAt: '2026-11-01T00:00:00.000Z', dueDate: '2026-11-09' });
		const yes = await home({ status: 'yes', statusChangedAt: '2026-11-07T09:00:00.000Z', dueDate: '2026-11-09' });
		expect(variant(no, 'no')).not.toContain(' hidden>');
		expect(variant(no, 'yes')).toContain(' hidden>');
		expect(variant(yes, 'yes')).not.toContain(' hidden>');
		expect(variant(yes, 'no')).toContain(' hidden>');
		// The ticker, header and footer follow the status too.
		expect(no).toMatch(/<span class="t-word" lang="fr" data-by-status data-no="Non" data-soon="Pas encore" data-yes="Oui">Non<\/span>/);
		expect(yes).toMatch(/<span class="t-word" lang="fr" data-by-status data-no="Non" data-soon="Pas encore" data-yes="Oui">Oui<\/span>/);
		expect(no).toMatch(/<span class="brand-answer" data-live="word">NO<\/span>/);
		expect(yes).toMatch(/<span class="brand-answer" data-live="word">YES<\/span>/);
	});
});
