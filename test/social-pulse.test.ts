import { describe, expect, it } from 'vitest';
import {
	ANXIETY_WINDOW_MINUTES,
	CHECKFEED_INTERVAL_MS,
	SocialPulse,
	anxietyLevelFor,
	anxietyReading,
	bumpBuckets,
	checkfeedMessage,
	gaugeAngle,
	milestoneAtOrBelow,
	milestoneReached,
	nextAnxietyChange,
	nextMilestone,
	parsePulseSnapshot,
	type MinuteBucket,
} from '../src/lib/social';
import type { LiveMessage } from '../src/types';

const T0 = Date.parse('2026-11-07T12:00:00Z');
const MIN = 60_000;
const types = (messages: LiveMessage[]) => messages.map((m) => m.type);

describe('milestones', () => {
	it('runs 100, 250, 500, 1k, 2.5k, 5k, 10k and on up', () => {
		const seen: number[] = [];
		for (let n = 99; seen.length < 12; n = nextMilestone(n)) if (n >= 100) seen.push(n);
		expect(seen).toEqual([100, 250, 500, 1000, 2500, 5000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000]);
	});

	it('knows the largest one reached', () => {
		expect(milestoneAtOrBelow(0)).toBe(0);
		expect(milestoneAtOrBelow(99)).toBe(0);
		expect(milestoneAtOrBelow(100)).toBe(100);
		expect(milestoneAtOrBelow(249)).toBe(100);
		expect(milestoneAtOrBelow(250)).toBe(250);
		expect(milestoneAtOrBelow(9_999)).toBe(5_000);
		expect(milestoneAtOrBelow(10_000)).toBe(10_000);
		expect(milestoneAtOrBelow(1_234_567)).toBe(1_000_000);
		expect(milestoneAtOrBelow(Number.NaN)).toBe(0);
		expect(nextMilestone(0)).toBe(100);
		expect(nextMilestone(100)).toBe(250);
		expect(nextMilestone(2_500)).toBe(5_000);
	});

	it('only celebrates a milestone not already celebrated, and only the highest of a jump', () => {
		expect(milestoneReached(0, 99)).toBeNull();
		expect(milestoneReached(0, 100)).toBe(100);
		expect(milestoneReached(100, 101)).toBeNull();
		expect(milestoneReached(100, 249)).toBeNull();
		expect(milestoneReached(100, 250)).toBe(250);
		expect(milestoneReached(250, 1_200)).toBe(1_000); // 500 and 1,000 crossed at once: one toast
		expect(milestoneReached(10_000, 9_000)).toBeNull(); // never backwards
	});
});

describe('check feed', () => {
	it('lists the busiest countries first, ties alphabetically, and sums the rest', () => {
		const tally = new Map([
			['PT', 1],
			['GB', 3],
			['FR', 1],
		]);
		expect(checkfeedMessage(tally)).toEqual({
			type: 'checkfeed',
			items: [
				{ country: 'GB', n: 3 },
				{ country: 'FR', n: 1 },
				{ country: 'PT', n: 1 },
			],
		});
		expect(checkfeedMessage(tally, 2)).toEqual({
			type: 'checkfeed',
			items: [
				{ country: 'GB', n: 3 },
				{ country: 'FR', n: 1 },
			],
			more: 1,
		});
		expect(checkfeedMessage(new Map())).toBeNull();
		expect(checkfeedMessage(new Map([['GB', 0]]))).toBeNull();
	});
});

describe('anxiety meter', () => {
	it('has levels for a small site', () => {
		expect(anxietyLevelFor(0)).toBe('calm');
		expect(anxietyLevelFor(2)).toBe('calm');
		expect(anxietyLevelFor(3)).toBe('elevated');
		expect(anxietyLevelFor(14)).toBe('elevated');
		expect(anxietyLevelFor(15)).toBe('frantic');
		expect(anxietyLevelFor(49)).toBe('frantic');
		expect(anxietyLevelFor(50)).toBe('meltdown');
	});

	it('averages checks per minute over a sliding five-minute window', () => {
		let buckets: MinuteBucket[] = [];
		for (let i = 0; i < 10; i++) buckets = bumpBuckets(buckets, T0 + i * 1000);
		expect(anxietyReading(buckets, T0 + 10_000)).toEqual({ level: 'elevated', perMinute: 2 });
		buckets = bumpBuckets(buckets, T0 + 2 * MIN, 5);
		expect(anxietyReading(buckets, T0 + 2 * MIN)).toEqual({ level: 'frantic', perMinute: 3 });
		// Five minutes on, the first ten have left the window; the later five remain.
		expect(anxietyReading(buckets, T0 + ANXIETY_WINDOW_MINUTES * MIN)).toEqual({ level: 'elevated', perMinute: 1 });
		expect(anxietyReading(buckets, T0 + 7 * MIN)).toEqual({ level: 'calm', perMinute: 0 });
		expect(bumpBuckets(buckets, T0 + 9 * MIN)).toEqual([[Math.floor((T0 + 9 * MIN) / MIN), 1]]); // old buckets pruned
	});

	it('knows when the level would next fall, and that calm cannot', () => {
		let buckets: MinuteBucket[] = [];
		buckets = bumpBuckets(buckets, T0, 20); // frantic
		buckets = bumpBuckets(buckets, T0 + 2 * MIN + 5_000, 4);
		// At T0 + 5 min the first 20 leave: 4 left, which is elevated.
		expect(nextAnxietyChange(buckets, T0 + 2 * MIN + 5_000)).toBe(T0 + 5 * MIN);
		// The later four leave once their minute (T0 + 2) is five minutes old.
		expect(nextAnxietyChange(buckets, T0 + 5 * MIN)).toBe(T0 + 7 * MIN);
		expect(nextAnxietyChange(buckets, T0 + 7 * MIN)).toBeNull();
	});

	it('points the needle through each level’s quarter of the dial', () => {
		expect(gaugeAngle({ level: 'calm', perMinute: 0 })).toBe(-85.5);
		expect(gaugeAngle({ level: 'elevated', perMinute: 0.6 })).toBe(-40.5);
		expect(gaugeAngle({ level: 'frantic', perMinute: 3 })).toBe(4.5);
		expect(gaugeAngle({ level: 'meltdown', perMinute: 500 })).toBe(85.5);
		const a = gaugeAngle({ level: 'elevated', perMinute: 1 });
		const b = gaugeAngle({ level: 'elevated', perMinute: 2.4 });
		expect(a).toBeLessThan(b);
		expect(b).toBeLessThan(0);
	});
});

describe('SocialPulse', () => {
	it('sends a lone check straight away, then holds the rest for one broadcast every 3 s', () => {
		const pulse = new SocialPulse();
		const first = pulse.check('GB', T0, true);
		expect(first.messages).toEqual([{ type: 'checkfeed', items: [{ country: 'GB', n: 1 }] }]);
		expect(first.wakeAt).toBeNull();
		const second = pulse.check('PT', T0 + 500, true);
		expect(second.messages).toEqual([]);
		expect(second.wakeAt).toBe(T0 + CHECKFEED_INTERVAL_MS);
		// Three checks in a minute: the meter rises at once (the feed still waits its turn).
		const third = pulse.check('GB', T0 + 900, true);
		expect(third.messages).toEqual([{ type: 'anxiety', level: 'elevated', perMinute: 0.6 }]);
		expect(third.wakeAt).toBe(T0 + CHECKFEED_INTERVAL_MS);
		const early = pulse.tick(T0 + 2_000, true);
		expect(early.messages).toEqual([]);
		expect(early.wakeAt).toBe(T0 + CHECKFEED_INTERVAL_MS);
		const due = pulse.tick(T0 + CHECKFEED_INTERVAL_MS, true);
		// The two held back: the first went out on its own.
		expect(due.messages).toEqual([
			{
				type: 'checkfeed',
				items: [
					{ country: 'GB', n: 1 },
					{ country: 'PT', n: 1 },
				],
			},
		]);
		expect(due.wakeAt).toBe(T0 + 5 * MIN); // when the meter falls back to calm
	});

	it('keeps no feed and asks for no alarms when nobody is watching', () => {
		const pulse = new SocialPulse();
		for (let i = 0; i < 20; i++) {
			const out = pulse.check('GB', T0 + i * 100, false);
			expect(out.wakeAt).toBeNull();
			expect(types(out.messages).filter((t) => t === 'checkfeed')).toEqual([]);
		}
		expect(pulse.reading(T0 + 2_000)).toEqual({ level: 'frantic', perMinute: 4 });
		expect(pulse.tick(T0 + 5_000, false)).toEqual({ messages: [], wakeAt: null });
	});

	it('broadcasts the meter only when its level changes, falling as well as rising', () => {
		const pulse = new SocialPulse();
		const levels: string[] = [];
		const collect = (messages: LiveMessage[]) => {
			for (const m of messages) if (m.type === 'anxiety') levels.push(m.level);
		};
		for (let i = 0; i < 16; i++) collect(pulse.check('FR', T0 + i * 1000, true).messages);
		expect(levels).toEqual(['elevated', 'frantic']);
		collect(pulse.tick(T0 + 30_000, true).messages);
		expect(levels).toEqual(['elevated', 'frantic']);
		const out = pulse.tick(T0 + 5 * MIN, true);
		collect(out.messages);
		expect(levels).toEqual(['elevated', 'frantic', 'calm']);
		expect(out.wakeAt).toBeNull();
	});

	it('saves the window only when it changed, and picks up where it left off', () => {
		const pulse = new SocialPulse();
		expect(pulse.snapshot(T0)).toBeNull();
		for (let i = 0; i < 4; i++) pulse.check('GB', T0 + i, false);
		const saved = pulse.snapshot(T0 + 10);
		expect(saved).not.toBeNull();
		expect(pulse.snapshot(T0 + 20)).toBeNull();
		const woken = new SocialPulse(saved);
		expect(woken.reading(T0 + 1_000)).toEqual({ level: 'elevated', perMinute: 0.8 });
		// It remembers it already said "elevated", so it doesn't say it again.
		expect(types(woken.check('GB', T0 + 2_000, false).messages)).toEqual([]);
	});

	it('ignores junk snapshots', () => {
		expect(parsePulseSnapshot(undefined)).toBeNull();
		expect(parsePulseSnapshot('not json')).toBeNull();
		expect(parsePulseSnapshot(JSON.stringify({ level: 'panic', buckets: [] }))).toBeNull();
		expect(parsePulseSnapshot(JSON.stringify({ level: 'calm', buckets: [[1, 2], ['x', 1], [3, -1], 'no'] }))).toEqual({
			level: 'calm',
			buckets: [[1, 2]],
		});
		expect(new SocialPulse('{"level":"meltdown"').reading(T0)).toEqual({ level: 'calm', perMinute: 0 });
	});
});
