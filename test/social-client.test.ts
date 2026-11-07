import { describe, expect, it, vi } from 'vitest';
import { dadconLevel as serverDadcon } from '../src/lib/dadcon';
import { ANXIETY_LEVELS, gaugeAngle as serverGauge } from '../src/lib/social';
import { formatRate as serverRate } from '../src/routes/social';
import { addDays } from '../src/lib/time';

// public/social.js's pure helpers, under Node with just enough of a browser for it to load (it
// finds no panels and does nothing else). Some mirror server code: they must agree with it.

vi.stubGlobal('document', { documentElement: { dataset: {} }, querySelector: () => null, querySelectorAll: () => [] });
vi.stubGlobal('window', {});

interface Client {
	where(code: string): string;
	dadconLevel(status: string, dueDate: string | null, today: string): number;
	gaugeAngle(level: string, perMinute: number): number;
	formatRate(perMinute: number): string;
	feedSentence(items: Array<{ country: string; n: number }>, more?: number): string;
	milestoneText(n: number, country: string): string;
}
// @ts-expect-error: a plain browser module, with no types.
const client = (await import('../public/social.js')) as Client;

describe('social.js wording', () => {
	it('says where people are, with "the" where it belongs', () => {
		expect(client.where('GB')).toBe('in the UK');
		expect(client.where('US')).toBe('in the US');
		expect(client.where('PT')).toBe('in Portugal');
		expect(client.where('NL')).toBe('in the Netherlands');
		expect(client.where('T1')).toBe('on Tor');
		expect(client.where('XX')).toBe('somewhere undisclosed');
		expect(client.where('<b>')).toBe('somewhere undisclosed');
	});

	it('sums up who just checked', () => {
		expect(client.feedSentence([{ country: 'PT', n: 1 }])).toBe('Someone in Portugal just checked.');
		expect(
			client.feedSentence([
				{ country: 'GB', n: 3 },
				{ country: 'PT', n: 1 },
			]),
		).toBe('3 people in the UK and someone in Portugal just checked.');
		expect(
			client.feedSentence(
				[
					{ country: 'GB', n: 1200 },
					{ country: 'FR', n: 2 },
				],
				7,
			),
		).toBe('1,200 people in the UK, 2 in France and 7 elsewhere just checked.');
	});

	it('names the milestone checker', () => {
		expect(client.milestoneText(10_000, 'CA')).toBe('Someone in Canada was the 10,000th check!');
		expect(client.milestoneText(100, 'XX')).toBe('Someone, somewhere, was the 100th check!');
		expect(client.milestoneText(2_500, 'T1')).toBe('Someone on Tor was the 2,500th check!');
	});
});

describe('social.js agrees with the server', () => {
	it('on DADCON, for every day from 40 days out to 10 overdue, in every status', () => {
		const today = '2026-11-07';
		for (const status of ['no', 'soon', 'yes'] as const) {
			for (let d = -10; d <= 40; d++) {
				const dueDate = addDays(today, d);
				expect(client.dadconLevel(status, dueDate, today), `${status} ${dueDate}`).toBe(serverDadcon({ status, dueDate }, today));
			}
			expect(client.dadconLevel(status, null, today)).toBe(serverDadcon({ status, dueDate: null }, today));
		}
	});

	it("on the gauge's needle and the rate", () => {
		for (const level of ANXIETY_LEVELS) {
			for (const perMinute of [0, 0.2, 0.6, 1, 2.9, 3, 7.5, 10, 14, 20, 99]) {
				expect(client.gaugeAngle(level, perMinute), `${level} ${perMinute}`).toBe(serverGauge({ level, perMinute }));
				expect(client.formatRate(perMinute)).toBe(serverRate(perMinute));
			}
		}
	});
});
