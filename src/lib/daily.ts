// OWNER: email agent.
// The daily post. Before YES: "Day N: still no." with one dry line (chosen deterministically
// by day number), due/overdue context and the check counter. After YES: seven "dad day" posts,
// then a final "daily service concluded" post, then silence.
//
// Everything here is pure (no I/O) so the cron, the tests and anyone curious can reason about
// exactly what goes out on any given day.

import type { SiteState, Status } from '../types';
import { daysBetween, formatLondonDate, isYmd, londonDate } from './time';

/**
 * ~30 dry one-liners for the "still no" phase. Copy rules: no gendered pronouns for anyone,
 * nothing personal about the baby, British English. Lines never start with "Still no" because
 * the title already says it.
 */
export const DAILY_LINES: readonly string[] = [
	'Zack has checked this website several times this morning, which is, technically, also you.',
	'The cot has been built, admired and slightly rebuilt. It remains unoccupied.',
	'The nappies remain in their packaging, blissfully unaware of what is coming.',
	'Zack has refreshed this page often enough to count as a load test. The site passed.',
	"Today's forecast: overwhelmingly no, with scattered outbreaks of nesting.",
	'Our monitoring confirms the answer is unchanged. Our monitoring is Zack, staring at a phone.',
	'The car seat is installed, inspected and better at its job than anyone in the car.',
	'No news is, in this specific instance, literally no news.',
	'The baby continues to operate on a schedule known only to the baby.',
	'All systems nominal. Zero dads detected.',
	'Jess would like everyone to stop asking. That is roughly why this website exists.',
	'Zack has read several books about parenting and is now an expert on the first chapter of each.',
	'The nappy stockpile has reached what can only be described as strategic reserve levels.',
	"'Any day now' has been true for quite a few days now.",
	'The pram has been folded and unfolded for practice. The pram is winning.',
	"A committee has reviewed today's status and voted unanimously for no. The committee is a cron job.",
	'This email was sent with exponential backoff. The baby appears to be using the same strategy.',
	"Zack has started referring to the kettle as 'practice for night feeds'.",
	'Please do not refresh harder. It does not help. We have checked.',
	'The muslin cloths are folded, stacked and ready. They have been ready for some time.',
	"Zack's phone has never been this well charged, or this loud.",
	'We regret to inform you that nothing has happened, again, right on schedule.',
	'You signed up for daily disappointment, and we respect your commitment.',
	'Uptime: 100%. Dad-time: 0%.',
	'Somewhere, a midwife is telling someone else that first babies are often late.',
	'The baby monitor has been tested thoroughly. It reports silence, which is accurate.',
	"Tonight's full night of sleep is a luxury Jess and Zack are being told, repeatedly, to enjoy.",
	"Zack has rehearsed saying 'I'm a dad' in the mirror. It is not yet accurate.",
	"Today's answer was computed on servers in hundreds of cities. They all agree: no.",
	'The go-bag by the door has been packed, unpacked, optimised and packed again.',
	'Zack has a spreadsheet for this. The spreadsheet also says no.',
	'This is a status update in the same way that a stopped clock is a timekeeping device.',
];

/** One line per "dad day" (index 0 is dad day 1). */
export const DAD_DAY_LINES: readonly string[] = [
	'Zack is a dad. We checked again this morning in case it had worn off. It had not.',
	'Sleep has been reclassified as a rumour. Morale remains high.',
	'Nappy changes are now performed with growing confidence and shrinking ceremony.',
	"Zack has learned that 'sleep when the baby sleeps' is advice, not a schedule.",
	'The answer remains yes. Analysts expect it to remain yes indefinitely.',
	'Zack has now changed more nappies this week than in the rest of recorded history combined.',
	'One whole week of being a dad. No refunds, no returns, no regrets. Tomorrow: one last email, then we stop.',
];

/** Number of daily "dad day" posts after YES, before the farewell. */
export const DAD_DAYS = DAD_DAY_LINES.length;

export const CONCLUDED_TITLE = 'Daily service concluded.';

export const CONCLUDED_BODY = [
	'Zack has been a dad for over a week, and the answer is now, permanently, yes. That makes this the final daily email: the only thing left to report each morning is that it is still yes, and you can safely assume that.',
	'Thank you for subscribing to daily disappointment. It paid off in the end.',
].join('\n\n');

/** "Day N" counts from launch: the launch day itself is Day 1. Never less than 1. */
export function dayNumber(launchDate: string, today: string): number {
	return Math.max(1, daysBetween(launchDate, today) + 1);
}

function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}

/**
 * Walk the list with a stride that's coprime to its length, so every line is used exactly once
 * per cycle and consecutive days never get neighbouring lines.
 */
const STRIDE = [7, 11, 13, 17, 19, 23, 29, 1].find((s) => gcd(s, DAILY_LINES.length) === 1) ?? 1;

/** The line for a given day number (1-based). Deterministic. */
export function dailyLine(day: number): string {
	const n = DAILY_LINES.length;
	const index = ((((Math.trunc(day) - 1) * STRIDE) % n) + n) % n;
	return DAILY_LINES[index] as string;
}

/** The "dad day" line (1..DAD_DAYS). Clamped. */
export function dadDayLine(n: number): string {
	const index = Math.min(Math.max(Math.trunc(n), 1), DAD_DAYS) - 1;
	return DAD_DAY_LINES[index] as string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Due / overdue context, e.g. "13 days until the due date (Friday 20 November 2026)." */
export function dueContext(dueDate: string | null, today: string): string {
	if (!dueDate || !isYmd(dueDate)) {
		return 'There is no official due date, which has not stopped anyone from guessing.';
	}
	const d = daysBetween(today, dueDate);
	if (d > 1) {
		return `${plural(d, 'day')} until the due date (${formatLondonDate(dueDate)}). Not that anyone is counting. Everyone is counting.`;
	}
	if (d === 1) return 'The due date is tomorrow. Nobody is calm.';
	if (d === 0) return 'Today is the due date. Only about one baby in twenty-five arrives on theirs, so: probably not today either.';
	if (d === -1) return 'One day overdue. The baby has been informed and does not care.';
	return `${plural(-d, 'day')} overdue. The baby is clearly not reading these emails.`;
}

/** "The answer has been checked 12,345 times. It has not budged." */
export function checksContext(checks: number | null | undefined): string | null {
	if (typeof checks !== 'number' || !Number.isFinite(checks) || checks <= 0) return null;
	const formatted = new Intl.NumberFormat('en-GB').format(Math.trunc(checks));
	return checks === 1
		? 'The answer has been checked exactly once. It did not budge.'
		: `The answer has been checked ${formatted} times. It has not budged.`;
}

const SOON_LINE =
	'Labour is under way, so this is still technically a no, in the same way that a kettle that has just boiled is technically not yet tea. This may well be the last one of these.';

export interface DailyInput {
	/** Today in Europe/London, 'YYYY-MM-DD'. */
	today: string;
	/** London date the site launched (first status_history row). Day 1. */
	launchDate: string;
	state: SiteState;
	/** Total checks of the answer, if known. */
	checks?: number | null;
	/** True if the farewell post for the current YES has already gone out. */
	concluded: boolean;
}

export type DailyPhase = 'waiting' | 'dad-day' | 'concluded';

export type DailyPlan =
	| { action: 'post'; phase: DailyPhase; day: number; title: string; body: string; status: Status }
	| { action: 'skip'; reason: string };

function safeLondonDate(iso: string, fallback: string): string {
	const t = Date.parse(iso);
	return Number.isNaN(t) ? fallback : londonDate(new Date(t));
}

/** Decide what (if anything) the daily cron posts today. Pure. */
export function planDailyPost(input: DailyInput): DailyPlan {
	const { today, state } = input;

	if (state.status === 'yes') {
		const yesDate = safeLondonDate(state.statusChangedAt, today);
		const n = daysBetween(yesDate, today);
		if (n <= 0) return { action: 'skip', reason: 'the big news went out today; no daily post needed' };
		if (n <= DAD_DAYS) {
			return {
				action: 'post',
				phase: 'dad-day',
				day: n,
				title: `Dad day ${n}: still yes.`,
				body: dadDayLine(n),
				status: 'yes',
			};
		}
		if (input.concluded) return { action: 'skip', reason: 'daily service has concluded' };
		return { action: 'post', phase: 'concluded', day: n, title: CONCLUDED_TITLE, body: CONCLUDED_BODY, status: 'yes' };
	}

	const day = dayNumber(input.launchDate, today);
	const paragraphs = [
		state.status === 'soon' ? SOON_LINE : dailyLine(day),
		dueContext(state.dueDate, today),
		checksContext(input.checks),
	].filter((p): p is string => Boolean(p));
	return {
		action: 'post',
		phase: 'waiting',
		day,
		title: state.status === 'soon' ? `Day ${day}: still no (but it's happening).` : `Day ${day}: still no.`,
		body: paragraphs.join('\n\n'),
		status: state.status,
	};
}
