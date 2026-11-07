// OWNER: social agent.
// The live, social side of checking: who just checked (by country), round-number milestones
// and the global anxiety meter. Everything here is pure (no Workers runtime imports), so the
// WaitingRoom can call it from its existing per-check work and tests can run it under Node.
//
// Costs, on Workers Free: nothing here writes to D1 or makes a request. Per check it is a few
// Map/array operations in the WaitingRoom's memory. Broadcasts only happen when someone is
// listening, a check feed goes out at most every CHECKFEED_INTERVAL_MS, and the anxiety meter
// only asks for an alarm at the (few) moments its level would drop, and only while a viewer is
// connected, so a quiet site costs no extra alarms at all.

import type { AnxietyLevel, AnxietyReading, LiveMessage } from '../types';

// ── Check feed ───────────────────────────────────────────────────────────────

/** Checks are grouped into one `checkfeed` broadcast at most this often. */
export const CHECKFEED_INTERVAL_MS = 3_000;
/** Countries named in one broadcast; the rest are summed into `more`. */
export const CHECKFEED_MAX_ITEMS = 8;

export type CheckfeedMessage = Extract<LiveMessage, { type: 'checkfeed' }>;

/** One feed broadcast from a country → count tally: busiest first, ties alphabetical. */
export function checkfeedMessage(tally: ReadonlyMap<string, number>, max = CHECKFEED_MAX_ITEMS): CheckfeedMessage | null {
	const items = [...tally]
		.filter(([, n]) => Number.isFinite(n) && n > 0)
		.map(([country, n]) => ({ country, n: Math.floor(n) }))
		.sort((a, b) => b.n - a.n || (a.country < b.country ? -1 : a.country > b.country ? 1 : 0));
	if (items.length === 0) return null;
	const shown = items.slice(0, Math.max(1, max));
	const more = items.slice(shown.length).reduce((sum, item) => sum + item.n, 0);
	return more > 0 ? { type: 'checkfeed', items: shown, more } : { type: 'checkfeed', items: shown };
}

// ── Milestones ───────────────────────────────────────────────────────────────

/** The first milestone. After it: 250, 500, 1,000, 2,500, 5,000, 10,000, 25,000… */
export const MILESTONE_FLOOR = 100;
const MILESTONE_STEPS = [1, 2.5, 5] as const;

/** The largest milestone that is at most `n`, or 0 below the first. */
export function milestoneAtOrBelow(n: number): number {
	if (!Number.isFinite(n) || n < MILESTONE_FLOOR) return 0;
	let best = 0;
	for (let power = MILESTONE_FLOOR; power <= n; power *= 10) {
		for (const step of MILESTONE_STEPS) {
			const value = step * power;
			if (value <= n) best = value;
		}
	}
	return best;
}

/** The first milestone strictly above `n`. */
export function nextMilestone(n: number): number {
	if (!Number.isFinite(n) || n < MILESTONE_FLOOR) return MILESTONE_FLOOR;
	for (let power = MILESTONE_FLOOR; ; power *= 10) {
		for (const step of MILESTONE_STEPS) {
			const value = step * power;
			if (value > n) return value;
		}
	}
}

/**
 * The milestone a total has reached that hasn't been celebrated yet, or null. `last` is the
 * last one celebrated. If several were crossed at once (the total jumped), only the highest
 * counts: nobody wants four toasts at a time.
 */
export function milestoneReached(last: number, total: number): number | null {
	const reached = milestoneAtOrBelow(total);
	return reached > 0 && reached > last ? reached : null;
}

// ── Anxiety meter ────────────────────────────────────────────────────────────

/** The meter averages over this many minutes (the current one included). */
export const ANXIETY_WINDOW_MINUTES = 5;
const MINUTE_MS = 60_000;

/**
 * Checks in the window at which each level starts, highest first. Pitched for a small site:
 * three checks in five minutes is already more than strictly healthy.
 */
export const ANXIETY_THRESHOLDS: ReadonlyArray<readonly [AnxietyLevel, number]> = [
	['meltdown', 50], // 10 a minute
	['frantic', 15], // 3 a minute
	['elevated', 3], // 0.6 a minute
];

export const ANXIETY_LEVELS: readonly AnxietyLevel[] = ['calm', 'elevated', 'frantic', 'meltdown'];

export function isAnxietyLevel(value: unknown): value is AnxietyLevel {
	return typeof value === 'string' && (ANXIETY_LEVELS as readonly string[]).includes(value);
}

export function anxietyLevelFor(checksInWindow: number): AnxietyLevel {
	for (const [level, min] of ANXIETY_THRESHOLDS) if (checksInWindow >= min) return level;
	return 'calm';
}

/** Checks per minute, one bucket per minute: [minute since the epoch, checks]. */
export type MinuteBucket = [minute: number, count: number];

const minuteOf = (ms: number) => Math.floor(ms / MINUTE_MS);

/** The buckets still inside the window at `now`. */
export function pruneBuckets(buckets: readonly MinuteBucket[], now: number): MinuteBucket[] {
	const oldest = minuteOf(now) - ANXIETY_WINDOW_MINUTES;
	return buckets.filter(([minute]) => minute > oldest && minute <= minuteOf(now));
}

/** Add `n` checks at `now`. Returns the new (pruned) buckets. */
export function bumpBuckets(buckets: readonly MinuteBucket[], now: number, n = 1): MinuteBucket[] {
	const minute = minuteOf(now);
	const kept = pruneBuckets(buckets, now);
	const current = kept.find(([m]) => m === minute);
	if (current) current[1] += n;
	else kept.push([minute, n]);
	return kept;
}

export function windowCount(buckets: readonly MinuteBucket[], now: number): number {
	return pruneBuckets(buckets, now).reduce((sum, [, count]) => sum + count, 0);
}

export function anxietyReading(buckets: readonly MinuteBucket[], now: number): AnxietyReading {
	const count = windowCount(buckets, now);
	return { level: anxietyLevelFor(count), perMinute: Math.round((count / ANXIETY_WINDOW_MINUTES) * 10) / 10 };
}

/**
 * When the level would next change if nobody else checked: the first minute boundary at
 * which enough old checks have left the window. Null when it can't fall any further.
 */
export function nextAnxietyChange(buckets: readonly MinuteBucket[], now: number): number | null {
	const level = anxietyReading(buckets, now).level;
	if (level === 'calm') return null;
	const minute = minuteOf(now);
	for (let k = 1; k <= ANXIETY_WINDOW_MINUTES; k++) {
		const at = (minute + k) * MINUTE_MS;
		if (anxietyReading(buckets, at).level !== level) return at;
	}
	return (minute + ANXIETY_WINDOW_MINUTES) * MINUTE_MS;
}

/** Checks in the window at which the gauge's needle reaches the far right. */
const GAUGE_FULL_SCALE = 100;

/**
 * Where the gauge's needle points, in degrees from straight up: each level has a 45° quarter
 * of the dial (calm far left, meltdown far right) and the needle moves through it with the
 * rate. public/social.js does the same sums.
 */
export function gaugeAngle(reading: AnxietyReading): number {
	const count = Math.max(0, (Number(reading.perMinute) || 0) * ANXIETY_WINDOW_MINUTES);
	const starts = [0, ...[...ANXIETY_THRESHOLDS].reverse().map(([, min]) => min), GAUGE_FULL_SCALE];
	const index = Math.max(0, ANXIETY_LEVELS.indexOf(reading.level));
	const lo = starts[index] ?? 0;
	const hi = starts[index + 1] ?? GAUGE_FULL_SCALE;
	const within = Math.min(1, Math.max(0, (count - lo) / (hi - lo || 1)));
	const angle = -90 + 45 * (index + 0.1 + within * 0.8);
	return Math.round(angle * 10) / 10;
}

// ── The WaitingRoom's tracker ────────────────────────────────────────────────

export interface PulseOutput {
	/** Broadcast these, in order. */
	messages: LiveMessage[];
	/** Look in again (alarm) no later than this, or null for no need. */
	wakeAt: number | null;
}

const earliest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/**
 * Per-WaitingRoom state for the check feed and the anxiety meter. The room calls `check()` for
 * every counted check, `tick()` from its alarm, and saves `snapshot()` (the anxiety window, a
 * few bytes) when it may be about to hibernate, which forgets memory.
 */
export class SocialPulse {
	#feed = new Map<string, number>();
	#feedSentAt = 0;
	#buckets: MinuteBucket[] = [];
	/** The level as last evaluated (and broadcast, if anyone was listening). */
	#level: AnxietyLevel = 'calm';
	#unsaved = false;

	constructor(saved?: unknown) {
		const restored = parsePulseSnapshot(saved);
		if (restored) {
			this.#buckets = restored.buckets;
			this.#level = restored.level;
		}
	}

	/** One counted check from `country` (already normalised). */
	check(country: string, now: number, listening: boolean): PulseOutput {
		const messages: LiveMessage[] = [];
		this.#buckets = bumpBuckets(this.#buckets, now);
		this.#unsaved = true;
		const anxiety = this.#evaluate(now);
		if (anxiety) messages.push(anxiety);
		let wakeAt: number | null = null;
		if (listening) {
			this.#feed.set(country, (this.#feed.get(country) ?? 0) + 1);
			if (now - this.#feedSentAt >= CHECKFEED_INTERVAL_MS || now < this.#feedSentAt) {
				const feed = this.#takeFeed(now);
				if (feed) messages.push(feed);
			} else {
				wakeAt = this.#feedSentAt + CHECKFEED_INTERVAL_MS;
			}
		}
		return { messages, wakeAt: earliest(wakeAt, this.#decayAt(now, listening)) };
	}

	/** The alarm's turn: send a held-back feed, and let the meter fall when the room goes quiet. */
	tick(now: number, listening: boolean): PulseOutput {
		const messages: LiveMessage[] = [];
		let wakeAt: number | null = null;
		if (this.#feed.size > 0) {
			if (!listening) this.#feed.clear();
			else if (now - this.#feedSentAt >= CHECKFEED_INTERVAL_MS || now < this.#feedSentAt) {
				const feed = this.#takeFeed(now);
				if (feed) messages.push(feed);
			} else wakeAt = this.#feedSentAt + CHECKFEED_INTERVAL_MS;
		}
		const anxiety = this.#evaluate(now);
		if (anxiety) messages.push(anxiety);
		return { messages, wakeAt: earliest(wakeAt, this.#decayAt(now, listening)) };
	}

	/** The meter right now (for a new client's hello). */
	reading(now: number): AnxietyReading {
		return anxietyReading(this.#buckets, now);
	}

	/** The anxiety window to store, if it changed since the last call; else null. */
	snapshot(now: number): string | null {
		if (!this.#unsaved) return null;
		this.#unsaved = false;
		this.#buckets = pruneBuckets(this.#buckets, now);
		return JSON.stringify({ level: this.#level, buckets: this.#buckets });
	}

	/** A level change since the last evaluation, as a message; null if it hasn't changed. */
	#evaluate(now: number): LiveMessage | null {
		const reading = anxietyReading(this.#buckets, now);
		if (reading.level === this.#level) return null;
		this.#level = reading.level;
		this.#unsaved = true;
		return { type: 'anxiety', ...reading };
	}

	#takeFeed(now: number): CheckfeedMessage | null {
		const msg = checkfeedMessage(this.#feed);
		this.#feed.clear();
		this.#feedSentAt = now;
		return msg;
	}

	/** Only an audience needs telling that the meter fell, so only then is an alarm worth it. */
	#decayAt(now: number, listening: boolean): number | null {
		return listening ? nextAnxietyChange(this.#buckets, now) : null;
	}
}

/** A stored snapshot, validated; null if it isn't one. */
export function parsePulseSnapshot(saved: unknown): { level: AnxietyLevel; buckets: MinuteBucket[] } | null {
	if (typeof saved !== 'string' || saved.length > 2_000) return null;
	let data: unknown;
	try {
		data = JSON.parse(saved);
	} catch {
		return null;
	}
	if (typeof data !== 'object' || data === null) return null;
	const { level, buckets } = data as { level?: unknown; buckets?: unknown };
	if (!isAnxietyLevel(level) || !Array.isArray(buckets)) return null;
	const clean: MinuteBucket[] = [];
	for (const bucket of buckets.slice(0, ANXIETY_WINDOW_MINUTES + 1)) {
		if (!Array.isArray(bucket)) continue;
		const [minute, count] = bucket as unknown[];
		if (Number.isSafeInteger(minute) && Number.isSafeInteger(count) && (count as number) > 0) clean.push([minute as number, count as number]);
	}
	return { level, buckets: clean };
}
