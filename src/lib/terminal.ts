// OWNER: terminal agent.
// Text for terminals that isn't the live dashboard: the Unix .plan file (GET /.plan) and the
// grandad estimate (GET /is-zack-a-grandad, page and curl). Pure.

import type { SiteState } from '../types';
import { asciiPaint, asciiPoster } from './ascii';
import { londonMidnightUtc } from './feeds-api';
import { DOMAIN } from './site';
import { daysBetween, formatLondon, formatLondonDate, formatNumber, londonDate } from './time';

// ─── /.plan ──────────────────────────────────────────────────────────────────

/** Days from the start of a pregnancy (by the usual reckoning) to the due date. */
export const PREGNANCY_DAYS = 280;
const BAR_CELLS = 20;

/** How far along the plan is, 0 to 1, or null without a due date. Never quite 1 before YES. */
export function planProgress(state: SiteState, today: string): number | null {
	if (state.status === 'yes') return 1;
	if (state.status === 'soon') return 0.99;
	if (!state.dueDate) return null;
	const elapsed = PREGNANCY_DAYS - daysBetween(today, state.dueDate);
	return Math.min(0.99, Math.max(0, elapsed / PREGNANCY_DAYS));
}

export function progressBar(progress: number, cells = BAR_CELLS): string {
	const filled = Math.round(Math.min(1, Math.max(0, progress)) * cells);
	return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)}`;
}

/** The year the new plan (sleep) completes: about nineteen years after it starts. */
export function sleepEta(state: SiteState): number {
	return new Date(state.statusChangedAt).getUTCFullYear() + 19;
}

/** GET /.plan: what `finger zack@iszacka.dad` would say, if anyone still ran fingerd. */
export function renderPlan(state: SiteState, now: Date): string {
	const today = londonDate(now);
	const yes = state.status === 'yes';
	const header = [
		`Login: zack${' '.repeat(29)}Name: Zack`,
		`Directory: /home/zack${' '.repeat(19)}Shell: ${yes ? '/bin/sleep-deprived' : '/bin/expectant'}`,
		`On since ${formatLondon(now.toISOString())} (London), idle 0:00 (${yes ? 'no chance' : 'nervously'})`,
		yes ? 'New mail: congratulations, mostly.' : 'No mail. Plenty of advice.',
		'Plan:',
	];
	if (yes) {
		return [...header, `Plan: complete. New plan: sleep (ETA: ${sleepEta(state)}).`, `Dad since ${formatLondon(state.statusChangedAt)}.`, ''].join('\n');
	}
	const progress = planProgress(state, today);
	const percent = progress === null ? '??' : String(Math.floor(progress * 100));
	const eta = state.status === 'soon' ? 'imminent' : 'soon';
	const lines = [...header, `Plan: become a dad. Progress: ${progressBar(progress ?? 0)} ${percent}%. ETA: ${eta}.`];
	if (state.status === 'soon') {
		lines.push(`Labour started ${formatLondon(state.statusChangedAt)}. The progress bar is doing its best.`);
	} else if (!state.dueDate) {
		lines.push('Due date: not announced. The progress bar is guessing.');
	} else {
		const days = daysBetween(today, state.dueDate);
		const when = formatLondonDate(state.dueDate);
		if (days > 0) lines.push(`Due ${when} (${formatNumber(days)} day${days === 1 ? '' : 's'} to go).`);
		else if (days === 0) lines.push(`Due today, ${when}. The last 1% is the hardest.`);
		else lines.push(`Due ${when} (${formatNumber(-days)} day${days === -1 ? '' : 's'} ago). The last 1% is the hardest.`);
	}
	lines.push(`Live: curl -N ${DOMAIN}/live`, '');
	return lines.join('\n');
}

// ─── /is-zack-a-grandad ──────────────────────────────────────────────────────

/** One generation, by a demographer we did not consult. */
export const GENERATION_YEARS = 30;
/** The error bars. Generous, like all good estimates. */
export const GRANDAD_ERROR_YEARS = 15;

export interface GrandadEstimate {
	/** The estimated moment (ISO), or null with nothing to estimate from. */
	at: string | null;
	/** What it's counted from: the YES moment, or the due date. */
	basis: 'yes' | 'due' | null;
	/** Whole days from now until then (negative once it's passed); null without an estimate. */
	days: number | null;
	/** The answer itself. Not yet, for a good while. */
	answer: 'Not yet.' | 'Possibly?';
}

function addYears(ms: number, years: number): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

export function grandadEstimate(state: SiteState, now: Date): GrandadEstimate {
	let from: number | null = null;
	let basis: GrandadEstimate['basis'] = null;
	if (state.status === 'yes') {
		from = Date.parse(state.statusChangedAt);
		basis = 'yes';
	} else if (state.dueDate) {
		from = londonMidnightUtc(state.dueDate);
		basis = 'due';
	}
	if (from === null || !Number.isFinite(from)) return { at: null, basis: null, days: null, answer: 'Not yet.' };
	const at = new Date(addYears(from, GENERATION_YEARS)).toISOString();
	const days = daysBetween(londonDate(now), londonDate(new Date(at)));
	return { at, basis, days, answer: days > 0 ? 'Not yet.' : 'Possibly?' };
}

/** The sentence under the answer. */
export function grandadSentence(state: SiteState): string {
	if (state.status === 'yes') return 'Zack is a dad. Grandad is a separate project, scheduled for later.';
	if (state.status === 'soon') return 'Zack is about to become a dad, which is step one of two.';
	return 'Zack is not a grandad. Zack is not even a dad yet.';
}

/** "Thursday, 20 November 2056", give or take. */
export function grandadWhen(estimate: GrandadEstimate): string {
	return estimate.at ? formatLondonDate(estimate.at) : 'unknown';
}

/** The headline estimate, worded with all the confidence it deserves. */
export function grandadSummary(estimate: GrandadEstimate): string {
	if (!estimate.at || estimate.days === null) return 'Unknown. One generation at a time: a due date first.';
	if (estimate.days <= 0) return 'Any day now, statistically. Do check with the baby, who is by now a grown-up.';
	const years = Math.round(estimate.days / 365.25);
	return `In about ${formatNumber(estimate.days)} days (${years === 1 ? 'a year' : `${years} years`}, give or take ${GRANDAD_ERROR_YEARS}).`;
}

export function grandadMethod(estimate: GrandadEstimate): string {
	const from = estimate.basis === 'yes' ? 'the moment Zack became a dad' : 'the due date';
	return `${from} + one generation (${GENERATION_YEARS} years)`;
}

/** `curl iszacka.dad/is-zack-a-grandad`. */
export function renderGrandadAscii(state: SiteState, now: Date, color = true): string {
	const estimate = grandadEstimate(state, now);
	const { bold, dim } = asciiPaint('soon', color);
	const facts = [
		bold(grandadSentence(state)),
		'',
		`${dim('Estimate:   ')}${grandadWhen(estimate)}${estimate.at ? ` (±${GRANDAD_ERROR_YEARS} years)` : ''}`,
		`${dim('Countdown:  ')}${grandadSummary(estimate)}`,
		...(estimate.at ? [`${dim('Method:     ')}${grandadMethod(estimate)}`] : []),
		`${dim('Confidence: ')}low. Consulted: nobody, least of all the baby.`,
		'',
		`${dim('Meanwhile:  ')}curl ${DOMAIN}`,
	];
	return asciiPoster({ kicker: 'Is Zack a grandad?', word: estimate.answer === 'Not yet.' ? 'NOT YET' : 'YES', status: estimate.answer === 'Not yet.' ? 'soon' : 'yes', facts, color });
}
