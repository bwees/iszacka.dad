import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/lib/ascii';
import { renderSitemap } from '../src/lib/feeds-text';
import {
	GENERATION_YEARS,
	PREGNANCY_DAYS,
	grandadEstimate,
	grandadSummary,
	planProgress,
	progressBar,
	renderGrandadAscii,
	renderPlan,
	sleepEta,
} from '../src/lib/terminal';
import type { SiteState, Status } from '../src/types';

const NOW = new Date('2026-11-07T12:00:00Z');
const state = (status: Status, extra: Partial<SiteState> = {}): SiteState => ({
	status,
	statusChangedAt: '2026-11-07T10:30:00.000Z',
	dueDate: '2026-11-20',
	...extra,
});

describe('/.plan', () => {
	it('works out progress from the due date, never quite finishing before YES', () => {
		expect(planProgress(state('no', { dueDate: '2026-11-07' }), '2026-11-07')).toBe(0.99);
		expect(planProgress(state('no'), '2026-11-07')).toBeCloseTo((PREGNANCY_DAYS - 13) / PREGNANCY_DAYS);
		expect(planProgress(state('no', { dueDate: '2027-08-14' }), '2026-11-07')).toBe(0); // further off than a pregnancy
		expect(planProgress(state('no', { dueDate: '2026-10-01' }), '2026-11-07')).toBe(0.99); // overdue
		expect(planProgress(state('no', { dueDate: null }), '2026-11-07')).toBeNull();
		expect(planProgress(state('soon'), '2026-11-07')).toBe(0.99);
		expect(planProgress(state('yes'), '2026-11-07')).toBe(1);
	});

	it('draws a bar of a fixed width', () => {
		expect(progressBar(0)).toBe('░'.repeat(20));
		expect(progressBar(1)).toBe('█'.repeat(20));
		expect(progressBar(0.5, 6)).toBe('███░░░');
		expect(progressBar(7)).toBe('█'.repeat(20));
	});

	it('is a plan to become a dad, with a progress bar and an ETA', () => {
		const plan = renderPlan(state('no'), NOW);
		expect(plan).toMatch(/^Login: zack\s+Name: Zack$/m);
		expect(plan).toMatch(/^Plan: become a dad\. Progress: [█░]{20} 95%\. ETA: soon\.$/m);
		expect(plan).toContain('13 days to go');
		expect(plan).toContain('curl -N iszacka.dad/live');
		expect(plan.endsWith('\n')).toBe(true);
	});

	it('copes without a due date, overdue, and in labour', () => {
		expect(renderPlan(state('no', { dueDate: null }), NOW)).toContain('Progress: ░░░░░░░░░░░░░░░░░░░░ ??%');
		expect(renderPlan(state('no', { dueDate: '2026-11-04' }), NOW)).toContain('3 days ago');
		expect(renderPlan(state('soon'), NOW)).toMatch(/ETA: imminent\./);
	});

	it('is complete after YES, with a new plan', () => {
		const plan = renderPlan(state('yes'), NOW);
		expect(plan).toContain('Plan: complete. New plan: sleep (ETA: 2045).');
		expect(plan).not.toContain('Progress:');
		expect(sleepEta(state('yes'))).toBe(2045);
	});

	it('uses no gendered pronouns', () => {
		for (const status of ['no', 'soon', 'yes'] as const) {
			expect(renderPlan(state(status), NOW)).not.toMatch(/\b(he|him|his|she|her|hers)\b/i);
		}
	});
});

describe('/is-zack-a-grandad', () => {
	it('estimates one generation after the due date before YES', () => {
		const estimate = grandadEstimate(state('no'), NOW);
		expect(estimate.basis).toBe('due');
		expect(estimate.answer).toBe('Not yet.');
		expect(estimate.at?.startsWith(`${2026 + GENERATION_YEARS}-11-20`) || estimate.at?.startsWith(`${2026 + GENERATION_YEARS}-11-19`)).toBe(true);
		expect(estimate.days).toBeGreaterThan(29 * 365);
	});

	it('counts from the YES moment once there is one', () => {
		const estimate = grandadEstimate(state('yes', { statusChangedAt: '2026-11-08T03:14:00.000Z' }), NOW);
		expect(estimate.basis).toBe('yes');
		expect(estimate.at).toBe('2056-11-08T03:14:00.000Z');
	});

	it('has nothing to estimate from without a due date', () => {
		const estimate = grandadEstimate(state('no', { dueDate: null }), NOW);
		expect(estimate).toEqual({ at: null, basis: null, days: null, answer: 'Not yet.' });
		expect(grandadSummary(estimate)).toMatch(/^Unknown/);
	});

	it('words the estimate absurdly, with error bars', () => {
		const summary = grandadSummary(grandadEstimate(state('no'), NOW));
		expect(summary).toMatch(/^In about [\d,]+ days \(30 years, give or take 15\)\.$/);
	});

	it('eventually allows that it might have happened', () => {
		const later = new Date('2060-01-01T00:00:00Z');
		expect(grandadEstimate(state('no'), later).answer).toBe('Possibly?');
	});

	it('has a curl version: NOT YET in block letters and a box of facts', () => {
		const text = stripAnsi(renderGrandadAscii(state('no'), NOW));
		expect(text).toContain('Is Zack a grandad?');
		expect(text).toContain('╚═╝  ╚═══╝'); // the N
		expect(text).toContain('Estimate:');
		expect(text).toContain('±15 years');
		expect(text).toContain('Zack is not even a dad yet');
		expect(renderGrandadAscii(state('no'), NOW, false)).not.toContain('\u001b[');
	});
});

describe('the sitemap', () => {
	it('lists the terminal pages a browser can read', () => {
		const xml = renderSitemap({ siteUrl: 'https://iszacka.dad', state: state('no'), updates: [] });
		expect(xml).toContain('<loc>https://iszacka.dad/live</loc>');
		expect(xml).toContain('<loc>https://iszacka.dad/is-zack-a-grandad</loc>');
	});
});
