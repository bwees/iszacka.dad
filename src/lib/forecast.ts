// OWNER: fun agent.
// 7-day "dad forecast": chance of becoming a dad on each of the next 7 days.
//
// The model (approximate, deliberately simple, not medical advice):
//
//   * Spontaneous birth timing T, in days relative to the due date, is roughly
//     Normal(mean = +1 day, sd = 9 days). Real-world studies put the median a
//     day or so after the due date with a spread of about a week and a half, so
//     this is the right shape, if not the right decimal places.
//   * Each calendar day k (offset from the due date) gets the mass between
//     k - 0.5 and k + 0.5 (a continuity correction, so the modal day is due + 1).
//   * By 42 weeks (due + 14) induction happens, so all the probability left in
//     the tail beyond that lands on day 14 itself. Nothing is left after it.
//   * The forecast is conditional: P(born on day d | not born before today).
//     The seven values are disjoint events, so they sum to at most 1.
//
// Past day 14 with the site still saying "no", the model has run out of
// distribution and switches to a flat 80%-a-day hazard (it's happening, or the
// admin has forgotten to press the button). `soon` means labour is under way:
// ~95% today. `yes` means clear skies forever.

import type { Status } from '../types';
import { addDays, daysBetween, isYmd } from './time';

export interface ForecastDay {
	/** 'YYYY-MM-DD' (Europe/London). */
	date: string;
	/** 0-1 probability that the baby arrives that day, given it hasn't yet. */
	probability: number;
	/** Weather-style label, e.g. 'Scattered contractions'. */
	label: string;
	emoji: string;
}

/** Mean of spontaneous birth timing, in days after the due date. */
export const FORECAST_MEAN_DAYS = 1;
/** Standard deviation of spontaneous birth timing, in days. */
export const FORECAST_SD_DAYS = 9;
/** Days after the due date by which induction happens (42+0). */
export const INDUCTION_OFFSET_DAYS = 14;
/** Number of days in a forecast (today plus six). */
export const FORECAST_DAYS = 7;
/** Daily hazard once the model has run out of distribution (past 42+0, still "no"). */
export const BEYOND_MODEL_HAZARD = 0.8;
/** While labour is under way: chance it's today, then tomorrow, then the day after. */
export const LABOUR_PROBABILITIES: readonly number[] = [0.95, 0.049, 0.001];

export const CLEAR_SKIES = { label: 'Clear skies: already a dad', emoji: '☀️' } as const;
export const NO_DUE_DATE = { label: 'Fog: no due date on file', emoji: '🌫️' } as const;
/** Days after labour's expected end: the probability is ~0 because it will already have happened. */
export const AFTER_LABOUR = { label: 'Rainbows: almost certainly a dad by then', emoji: '🌈' } as const;

/** Labels from calm to apocalyptic. `below` is an exclusive upper bound on the probability. */
export const FORECAST_SCALE: ReadonlyArray<{ below: number; label: string; emoji: string }> = [
	{ below: 0.001, label: 'Sunny, no dads', emoji: '☀️' },
	{ below: 0.01, label: 'Mostly sunny, isolated twinges', emoji: '🌤️' },
	{ below: 0.03, label: 'Light chance of contractions', emoji: '🌦️' },
	{ below: 0.07, label: 'Scattered nappies', emoji: '⛅' },
	{ below: 0.15, label: 'Overcast, high dad pressure', emoji: '☁️' },
	{ below: 0.35, label: 'Heavy dad warning', emoji: '🌧️' },
	{ below: 0.75, label: 'Amber warning: thunderstorms of dad', emoji: '⛈️' },
	{ below: Number.POSITIVE_INFINITY, label: 'Red warning: dad imminent, take cover', emoji: '🌪️' },
];

/** Weather-style label for a probability in [0, 1]. */
export function forecastLabel(probability: number): { label: string; emoji: string } {
	const p = Number.isFinite(probability) ? probability : 0;
	const band = FORECAST_SCALE.find((b) => p < b.below) ?? (FORECAST_SCALE[FORECAST_SCALE.length - 1] as (typeof FORECAST_SCALE)[number]);
	return { label: band.label, emoji: band.emoji };
}

/**
 * Complementary error function, Numerical Recipes' Chebyshev fit (`erfcc`).
 * Fractional error below 1.2e-7 everywhere, which matters in the tails.
 */
function erfc(x: number): number {
	const z = Math.abs(x);
	const t = 1 / (1 + 0.5 * z);
	const r =
		t *
		Math.exp(
			-z * z -
				1.26551223 +
				t *
					(1.00002368 +
						t *
							(0.37409196 +
								t *
									(0.09678418 +
										t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
		);
	return x >= 0 ? r : 2 - r;
}

/** Standard normal upper tail, P(Z > z). */
function upperTail(z: number): number {
	return 0.5 * erfc(z / Math.SQRT2);
}

/** P(T >= offset - 0.5) for the untruncated normal: the mass from day `offset` onwards. */
function normalSurvival(offset: number): number {
	return upperTail((offset - 0.5 - FORECAST_MEAN_DAYS) / FORECAST_SD_DAYS);
}

/**
 * Unconditional probability of arriving on the day `offset` days after the due
 * date (negative = early). Day 14 carries the induction lump; later days are 0.
 */
export function birthProbabilityOnDay(offset: number): number {
	if (!Number.isInteger(offset) || offset > INDUCTION_OFFSET_DAYS) return 0;
	if (offset === INDUCTION_OFFSET_DAYS) return normalSurvival(offset);
	return Math.max(0, normalSurvival(offset) - normalSurvival(offset + 1));
}

/** Probability of not having arrived before the day `offset` days after the due date. */
export function survivalFromDay(offset: number): number {
	if (!Number.isInteger(offset) || offset > INDUCTION_OFFSET_DAYS) return 0;
	return normalSurvival(offset);
}

function clamp01(p: number): number {
	return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
}

function day(date: string, probability: number, label?: { label: string; emoji: string }): ForecastDay {
	const p = clamp01(probability);
	const l = label ?? forecastLabel(p);
	return { date, probability: p, label: l.label, emoji: l.emoji };
}

/**
 * The 7-day forecast from `today` ('YYYY-MM-DD', Europe/London). Each day's
 * probability is P(born that day | not born before today).
 */
export function dadForecast(dueDate: string | null, today: string, status: Status): ForecastDay[] {
	if (!isYmd(today)) return [];
	const dates = Array.from({ length: FORECAST_DAYS }, (_, i) => addDays(today, i));

	if (status === 'yes') return dates.map((d) => day(d, 0, CLEAR_SKIES));
	if (status === 'soon') {
		return dates.map((d, i) => {
			const p = LABOUR_PROBABILITIES[i];
			return p === undefined ? day(d, 0, AFTER_LABOUR) : day(d, p);
		});
	}
	if (!isYmd(dueDate)) return dates.map((d) => day(d, 0, NO_DUE_DATE));

	const start = daysBetween(dueDate, today);
	if (start > INDUCTION_OFFSET_DAYS) {
		// Beyond the model: a constant hazard, so P(day i) = h(1-h)^i.
		return dates.map((d, i) => day(d, BEYOND_MODEL_HAZARD * (1 - BEYOND_MODEL_HAZARD) ** i));
	}
	const survival = survivalFromDay(start);
	return dates.map((d, i) => day(d, survival > 0 ? birthProbabilityOnDay(start + i) / survival : 0));
}

// ─── Status page model (/status) ─────────────────────────────────────────────
// The statuspage.io parody, derived from `status_history` + the due date. Pure,
// so it can be tested without a database.

export type Health = 'operational' | 'degraded' | 'partial' | 'major' | 'maintenance';

export const HEALTH_LABEL: Record<Health, string> = {
	operational: 'Operational',
	degraded: 'Degraded performance',
	partial: 'Partial outage',
	major: 'Major outage',
	maintenance: 'Under maintenance',
};

export interface HistoryEntry {
	status: Status;
	/** ISO UTC. */
	at: string;
}

export interface DayStatus {
	/** 'YYYY-MM-DD' (Europe/London). */
	date: string;
	/** Status at the end of that day (or now, for today); null before the site existed. */
	status: Status | null;
}

export const UPTIME_DAYS = 90;

const londonDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });

function londonYmd(iso: string): string | null {
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? londonDay.format(new Date(ms)) : null;
}

/** Valid history entries, oldest first. */
function cleanHistory(history: readonly HistoryEntry[]): HistoryEntry[] {
	return history
		.filter((h) => Number.isFinite(Date.parse(h.at)) && (h.status === 'no' || h.status === 'soon' || h.status === 'yes'))
		.map((h, i) => ({ h, i }))
		.sort((a, b) => Date.parse(a.h.at) - Date.parse(b.h.at) || a.i - b.i)
		.map(({ h }) => h);
}

/** One entry per London day for the last `days` days (oldest first), ending today. */
export function dailyStatuses(history: readonly HistoryEntry[], today: string, days = UPTIME_DAYS): DayStatus[] {
	if (!isYmd(today) || days < 1) return [];
	const entries = cleanHistory(history).map((h) => ({ status: h.status, day: londonYmd(h.at) as string }));
	const out: DayStatus[] = [];
	let cursor = 0;
	let current: Status | null = null;
	for (let i = days - 1; i >= 0; i--) {
		const date = addDays(today, -i);
		while (cursor < entries.length && (entries[cursor] as { day: string }).day <= date) {
			current = (entries[cursor] as { status: Status }).status;
			cursor++;
		}
		out.push({ date, status: current });
	}
	return out;
}

/** Milliseconds spent in each status between `from` and `to` (ISO). */
export function timeInStatus(history: readonly HistoryEntry[], from: string, to: string): Record<Status, number> {
	const totals: Record<Status, number> = { no: 0, soon: 0, yes: 0 };
	const start = Date.parse(from);
	const end = Date.parse(to);
	if (!(end > start)) return totals;
	const entries = cleanHistory(history);
	entries.forEach((entry, i) => {
		const next = entries[i + 1];
		const a = Math.max(start, Date.parse(entry.at));
		const b = Math.min(end, next ? Date.parse(next.at) : end);
		if (b > a) totals[entry.status] += b - a;
	});
	return totals;
}

/** Fraction (0-1) of tracked time in the given statuses over the last `days` days; null with no data. */
export function uptimeFraction(history: readonly HistoryEntry[], now: string, statuses: readonly Status[], days = UPTIME_DAYS): number | null {
	const totals = timeInStatus(history, new Date(Date.parse(now) - days * 86_400_000).toISOString(), now);
	const tracked = totals.no + totals.soon + totals.yes;
	if (tracked <= 0) return null;
	return statuses.reduce((sum, s) => sum + totals[s], 0) / tracked;
}

/** "12.34%", truncated rather than rounded so 99.999% never claims to be 100.00%. */
export function formatPercent(fraction: number | null): string {
	if (fraction === null || !Number.isFinite(fraction)) return '—';
	const clamped = Math.min(1, Math.max(0, fraction));
	return `${(Math.floor(clamped * 10_000) / 100).toFixed(2)}%`;
}

/** Patience on a given day: worse the further past the due date, and fully restored by YES. */
export function patienceHealth(status: Status, dueDate: string | null, date: string): Health {
	if (status === 'yes' || !isYmd(dueDate) || !isYmd(date)) return 'operational';
	const overdue = daysBetween(dueDate, date);
	if (overdue <= 0) return 'operational';
	if (overdue <= 3) return 'degraded';
	if (overdue <= 9) return 'partial';
	return 'major';
}

/** Which bar class (from the UI kit) shows a health colour: green, amber, red or grey. */
export function healthBarClass(health: Health | null): 'bar-yes' | 'bar-soon' | 'bar-no' | 'bar-none' {
	if (health === null) return 'bar-none';
	if (health === 'operational') return 'bar-yes';
	if (health === 'major') return 'bar-no';
	return 'bar-soon';
}

export interface StatusComponent {
	name: string;
	health: Health;
	/** Short status text shown in the pill. */
	label: string;
	/** One dry sentence of detail. */
	note: string;
}

/** Every component on the status page, for the current state. */
export function statusComponents(state: { status: Status; dueDate: string | null }, today: string): StatusComponent[] {
	const { status } = state;
	const overdue = isYmd(state.dueDate) && isYmd(today) ? daysBetween(state.dueDate, today) : null;
	const patience = patienceHealth(status, state.dueDate, today);
	const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

	const patienceNote =
		status === 'yes'
			? 'Fully restored. Nobody remembers the waiting any more.'
			: overdue === null
				? 'No due date on file, so nothing to be impatient about. Yet.'
				: overdue < 0
					? `${days(-overdue)} until the due date. Patience is holding.`
					: overdue === 0
						? 'Due today. Patience is being tested as we speak.'
						: overdue <= 3
							? `${days(overdue)} overdue. Mild sighing detected.`
							: overdue <= 9
								? `${days(overdue)} overdue. Everyone is asking. Please stop asking.`
								: `${days(overdue)} overdue. Patience has left the building.`;

	return [
		{
			name: 'Dad Service',
			health: status === 'yes' ? 'operational' : status === 'soon' ? 'degraded' : 'major',
			label: status === 'yes' ? 'Operational' : status === 'soon' ? 'Degraded: in progress' : 'Major outage',
			note:
				status === 'yes'
					? 'Zack is a dad. Service restored after roughly nine months of planned works.'
					: status === 'soon'
						? 'Labour has started. The dad deployment is rolling out now.'
						: 'Zack is not a dad. Engineers (Jess and Zack) are aware and working on it.',
		},
		{
			name: 'Nappy Supply',
			health: 'operational',
			label: 'Operational',
			note:
				status === 'yes'
					? 'Operational. Consumption rate: alarming.'
					: 'Stockpiled. Several hundred units on standby, by conservative estimates not enough.',
		},
		{
			name: 'Sleep',
			health: status === 'yes' ? 'major' : 'operational',
			label: status === 'yes' ? 'Major outage' : 'Operational',
			note:
				status === 'yes'
					? 'Down. Estimated time to full recovery: about eighteen years.'
					: status === 'soon'
						? 'Technically still operational. Enjoy it while it lasts.'
						: 'Eight hours a night, taken entirely for granted.',
		},
		{
			name: 'Patience',
			health: patience,
			label: HEALTH_LABEL[patience],
			note: patienceNote,
		},
		{
			name: 'Text Message Response Time',
			health: status === 'yes' ? 'partial' : status === 'soon' ? 'major' : 'operational',
			label: status === 'yes' ? 'Partial outage' : status === 'soon' ? 'Major outage' : 'Operational',
			note:
				status === 'yes'
					? 'Replies may take 3 to 5 working days and consist mostly of photos of a sleeping baby.'
					: status === 'soon'
						? 'Not responding. Please do not take it personally. Please do not text.'
						: 'Replies are instant and, frankly, a bit too available.',
		},
		{
			name: 'Dad Jokes',
			health: status === 'yes' ? 'operational' : 'maintenance',
			label: status === 'yes' ? 'Operational' : 'Under maintenance',
			note:
				status === 'yes'
					? 'Now shipping to production daily, whether you like it or not.'
					: 'Pre-release builds only. Puns are in closed beta.',
		},
		{
			name: 'Hot Drinks',
			health: status === 'yes' ? 'degraded' : 'operational',
			label: status === 'yes' ? 'Degraded performance' : 'Operational',
			note: status === 'yes' ? 'Every cup is now drunk cold, if at all.' : 'Tea is drunk at the correct temperature.',
		},
		{
			name: 'Notification Pipeline',
			health: 'operational',
			label: 'Operational',
			note: 'Email, push, webhooks, feeds, DNS and the Dad Ledger are standing by to over-share.',
		},
	];
}

export type IncidentPhase = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export interface IncidentUpdate {
	phase: IncidentPhase;
	at: string;
	/** e.g. "Investigating: Zack is not a dad". */
	title: string;
	body: string;
}

export interface Incident {
	title: string;
	startedAt: string;
	resolvedAt: string | null;
	/** Newest first, like every status page. */
	updates: IncidentUpdate[];
}

export const PHASE_LABEL: Record<IncidentPhase, string> = {
	investigating: 'Investigating',
	identified: 'Identified',
	monitoring: 'Monitoring',
	resolved: 'Resolved',
};

/**
 * Incidents from the status history, newest first. Each run from "no" to "yes"
 * is one incident: Investigating (not a dad) → Identified (labour started) →
 * Resolved (a dad). Admin about-turns become Monitoring updates or new incidents.
 */
export function buildIncidents(history: readonly HistoryEntry[]): Incident[] {
	const incidents: Incident[] = [];
	let open: Incident | null = null;
	let previous: Status | null = null;
	const push = (incident: Incident, phase: IncidentPhase, at: string, title: string, body: string) => {
		incident.updates.push({ phase, at, title: `${PHASE_LABEL[phase]}: ${title}`, body });
	};

	for (const entry of cleanHistory(history)) {
		if (entry.status === previous) continue;
		if (!open) {
			const reopened = previous === 'yes';
			open = { title: reopened ? 'Zack is, somehow, not a dad again' : 'Zack is not a dad', startedAt: entry.at, resolvedAt: null, updates: [] };
			incidents.push(open);
			if (entry.status === 'no') {
				push(
					open,
					'investigating',
					entry.at,
					reopened ? 'Zack is not a dad (again?)' : 'Zack is not a dad',
					reopened
						? 'The answer has reverted to NO. This is almost certainly an admin mis-click rather than a refund. We are investigating.'
						: 'We are aware that Zack is not a dad. Engineers (Jess and Zack) are working on it. Expect a long investigation.',
				);
			}
		}
		if (entry.status === 'soon') {
			push(open, 'identified', entry.at, 'labour has started', 'The root cause has been identified as a baby. A fix is being deployed. Please stand by.');
		} else if (entry.status === 'yes') {
			push(open, 'resolved', entry.at, 'Zack is a dad', 'This incident has been resolved. Zack is a dad. Sleep has been moved to a separate, much longer incident.');
			open.resolvedAt = entry.at;
			open = null;
		} else if (previous === 'soon') {
			push(open, 'monitoring', entry.at, 'false alarm', 'Labour has paused or was a false alarm. Zack remains not a dad. We continue to monitor the situation closely.');
		}
		previous = entry.status;
	}
	for (const incident of incidents) incident.updates.reverse();
	return incidents.reverse();
}
