import { describe, expect, it } from 'vitest';
import { renderAscii, stripAnsi } from '../src/lib/ascii';
import {
	LIVE_FALLBACK_GOODBYE,
	LIVE_PREAMBLE,
	type LiveModel,
	SHOW_CURSOR,
	WIDTH,
	charWidth,
	cleanText,
	countdown,
	dayClock,
	displayWidth,
	liveFrameLines,
	renderFinalFrame,
	renderLiveFrame,
	truncateTo,
} from '../src/lib/ascii-live';
import {
	FIREWORKS_MS,
	FRESH_FLIP_MS,
	MAX_TERMINALS,
	TERMINAL_MAX_MS,
	TERMINAL_TICK_MS,
	isFreshFlip,
	nextTerminalTick,
	terminalExpired,
} from '../src/do/waiting-room-protocol';
import type { SiteState, Status } from '../src/types';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const state = (status: Status, extra: Partial<SiteState> = {}): SiteState => ({
	status,
	statusChangedAt: '2026-11-07T10:30:00.000Z',
	dueDate: '2026-11-20',
	...extra,
});
const model = (status: Status, extra: Partial<LiveModel> = {}): LiveModel => ({
	state: state(status),
	viewers: 12,
	terminals: 3,
	vibes: 4_321,
	checks: 98_765,
	latest: { title: 'Day 7: still no.', createdAt: '2026-11-07T09:00:00.000Z' },
	...extra,
});

/** The frame as the terminal would show it: no escapes, one string per row. */
function screen(frame: string): string[] {
	return frame
		.replace(/\u001b\][^\u0007]*\u0007/g, '')
		.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
		.replace(/\u0007/g, '')
		.split('\n');
}

describe('measuring text for a terminal', () => {
	it('counts emoji and CJK as two columns, combining marks as none', () => {
		expect(charWidth('a'.codePointAt(0) ?? 0)).toBe(1);
		expect(charWidth('👶'.codePointAt(0) ?? 0)).toBe(2);
		expect(charWidth('漢'.codePointAt(0) ?? 0)).toBe(2);
		expect(charWidth(0x301)).toBe(0);
		expect(displayWidth('no 👶')).toBe(5);
		expect(displayWidth('é')).toBe(1);
	});

	it('truncates to a width, with an ellipsis, never splitting a wide character', () => {
		expect(truncateTo('short', 10)).toBe('short');
		expect(truncateTo('a much longer headline', 10)).toBe('a much...');
		expect(displayWidth(truncateTo('👶👶👶👶👶👶', 7))).toBeLessThanOrEqual(7);
	});

	it('strips control characters and bidi overrides from outside text', () => {
		expect(cleanText('Hi\u001b[2J there\n\tfriend')).toBe('Hi [2J there friend');
		expect(cleanText('a‮b⁦c')).toBe('a b c');
		expect(cleanText('\u0007\u0000')).toBe('');
	});
});

describe('the countdown', () => {
	it('counts down to London midnight on the due date', () => {
		const [label, value] = countdown(state('no'), NOW);
		expect(label).toBe('Due in');
		expect(value).toMatch(/^12d 12:00:00 {2}\(Fri 20 Nov\)$/);
	});

	it('says so on the day, and counts the days overdue after', () => {
		expect(countdown(state('no', { dueDate: '2026-11-07' }), NOW)).toEqual(['Due', 'today. No pressure.']);
		expect(countdown(state('no', { dueDate: '2026-11-04' }), NOW)).toEqual(['Overdue', '3 days overdue. Nobody tell the baby.']);
		expect(countdown(state('no', { dueDate: '2026-11-06' }), NOW)[1]).toMatch(/^1 day overdue/);
	});

	it('copes without a due date', () => {
		expect(countdown(state('no', { dueDate: null }), NOW)[0]).toBe('Due');
	});

	it('counts labour up in hours, and fatherhood in days, hours and minutes', () => {
		expect(countdown(state('soon'), NOW)).toEqual(['In labour', '1:30:00 and counting (since 10:30)']);
		const [label, value] = countdown(state('yes', { statusChangedAt: '2026-11-05T09:15:00.000Z' }), NOW);
		expect(label).toBe('Dad for');
		expect(value.startsWith('2d 02:45')).toBe(true);
	});

	it('formats day clocks and never goes negative', () => {
		expect(dayClock(90_061_000, true)).toBe('1d 01:01:01');
		expect(dayClock(90_061_000, false)).toBe('1d 01:01');
		expect(dayClock(-5_000, true)).toBe('0d 00:00:00');
	});
});

describe('the live frame', () => {
	for (const status of ['no', 'soon', 'yes'] as const) {
		it(`fits in ${WIDTH} columns with the box closed (${status})`, () => {
			const rows = screen(renderLiveFrame(model(status), { now: NOW, frame: 3 }));
			for (const row of rows) expect(displayWidth(row), JSON.stringify(row)).toBeLessThanOrEqual(WIDTH);
			const top = rows.findIndex((r) => r.includes('╭'));
			const bottom = rows.findIndex((r) => r.includes('╰'));
			expect(top).toBeGreaterThan(0);
			expect(bottom).toBeGreaterThan(top);
			const widths = new Set(rows.slice(top, bottom + 1).map((r) => displayWidth(r)));
			expect(widths.size).toBe(1); // every box row is the same width, so the right border lines up
		});
	}

	it('homes the cursor, clears each line and below, and never clears the whole screen mid-stream', () => {
		const frame = renderLiveFrame(model('no'), { now: NOW, frame: 0 });
		expect(frame).toContain('\u001b[H');
		expect(frame).toContain('\u001b[K');
		expect(frame.endsWith('\u001b[J')).toBe(true);
		expect(frame).not.toContain('\u001b[2J');
		expect(LIVE_PREAMBLE).toContain('\u001b[?25l'); // the cursor hides once, on connect
		expect(LIVE_PREAMBLE).toContain('\u001b[2J');
	});

	it('shows the answer in block letters and every number in the box', () => {
		const text = screen(renderLiveFrame(model('no'), { now: NOW, frame: 0 })).join('\n');
		expect(text).toContain('███╗   ██╗'); // the N of NO
		expect(text).toContain('Zack is not a dad');
		expect(text).toMatch(/Due in\s+12d 12:00:00/);
		expect(text).toMatch(/Watching\s+12 \(3 in terminals, like you\)/);
		expect(text).toMatch(/Vibes\s+4,321 sent/);
		expect(text).toMatch(/Asked\s+98,765 times\. Still no\./);
		expect(text).toMatch(/Latest\s+Day 7: still no\. \(7 Nov, 09:00\)/);
		expect(text).toMatch(/London\s+12:00:00 GMT, Sat 7 Nov/);
	});

	it('knows British Summer Time', () => {
		const text = screen(renderLiveFrame(model('no'), { now: Date.parse('2026-07-01T12:00:00Z'), frame: 0 })).join('\n');
		expect(text).toMatch(/London\s+13:00:00 BST/);
	});

	it('words the audience for one terminal, and copes with no update yet', () => {
		const text = screen(renderLiveFrame(model('no', { viewers: 1, terminals: 1, latest: null }), { now: NOW, frame: 0 })).join('\n');
		expect(text).toContain('just you, in a terminal');
		expect(text).toContain('Nothing yet.');
	});

	it('never lets an update title escape into the terminal', () => {
		const frame = renderLiveFrame(model('no', { latest: { title: 'Evil\u001b]0;pwned\u0007\u001b[31m title', createdAt: '2026-11-07T09:00:00.000Z' } }), { now: NOW, frame: 0 });
		expect(frame).not.toContain('pwned\u0007');
		expect(frame).not.toContain('\u001b[31m');
		const long = screen(renderLiveFrame(model('no', { latest: { title: 'x'.repeat(500), createdAt: '2026-11-07T09:00:00.000Z' } }), { now: NOW, frame: 0 }));
		for (const row of long) expect(displayWidth(row)).toBeLessThanOrEqual(WIDTH);
	});

	it('runs hazard tape while it is happening, and moves it along each frame', () => {
		const a = screen(renderLiveFrame(model('soon'), { now: NOW, frame: 0 }));
		const b = screen(renderLiveFrame(model('soon'), { now: NOW, frame: 1 }));
		expect(a.join('\n')).toContain('CAUTION: DAD UNDER CONSTRUCTION');
		expect(a.join('\n')).toContain('NOT YET. BUT VERY NEARLY.');
		const noTape = screen(renderLiveFrame(model('no'), { now: NOW, frame: 0 })).join('\n');
		expect(noTape).not.toContain('CAUTION');
		// The same text, different colours: the stripes moved.
		const raw0 = renderLiveFrame(model('soon'), { now: NOW, frame: 0 });
		const raw1 = renderLiveFrame(model('soon'), { now: NOW, frame: 1 });
		expect(a).toEqual(b);
		expect(raw0).not.toBe(raw1);
	});

	it('sets off fireworks after YES, then settles on a static celebration', () => {
		const still = renderLiveFrame(model('yes'), { now: NOW, frame: 0 });
		const early = renderLiveFrame(model('yes'), { now: NOW, frame: 0, fireworksAt: 300 });
		const later = renderLiveFrame(model('yes'), { now: NOW, frame: 0, fireworksAt: 2_000 });
		expect(early).not.toBe(later);
		expect(still).not.toBe(later);
		// The static frame is the same every time: one render serves every terminal.
		expect(renderLiveFrame(model('yes'), { now: NOW, frame: 9 })).toBe(still);
		for (const t of [0, 450, 1_000, 5_000, FIREWORKS_MS - 1]) {
			for (const row of screen(renderLiveFrame(model('yes'), { now: NOW, frame: 0, fireworksAt: t }))) {
				expect(displayWidth(row)).toBeLessThanOrEqual(WIDTH);
			}
		}
	});

	it('rings the bell only when asked (the moment itself)', () => {
		expect(renderLiveFrame(model('yes'), { now: NOW, frame: 0, bell: true }).startsWith('\u0007')).toBe(true);
		expect(renderLiveFrame(model('yes'), { now: NOW, frame: 0 }).startsWith('\u0007')).toBe(false);
	});

	it('says goodbye after the time limit, with the cursor back', () => {
		const final = renderFinalFrame(model('no'), { now: NOW, frame: 0 });
		const text = screen(final).join('\n');
		expect(text).toContain("That's your 15 minutes. Still no.");
		expect(text).toContain('Run it again: curl -N iszacka.dad/live');
		expect(final).toContain(SHOW_CURSOR);
		expect(LIVE_FALLBACK_GOODBYE).toContain('curl -N iszacka.dad/live');
		expect(LIVE_FALLBACK_GOODBYE).toContain(SHOW_CURSOR);
	});

	it('renders a preview for the web page without "like you"', () => {
		const lines = liveFrameLines(model('no'), { now: NOW, frame: 0, preview: true });
		const text = lines.map((l) => l.map(([, t]) => t).join('')).join('\n');
		expect(text).not.toContain('like you');
		expect(text).toMatch(/Watching\s+12 people/);
	});
});

describe('terminal timing', () => {
	it('ticks on 5-second boundaries', () => {
		expect(TERMINAL_TICK_MS).toBeGreaterThanOrEqual(5_000);
		expect(nextTerminalTick(10_000)).toBe(15_000);
		expect(nextTerminalTick(12_345)).toBe(15_000);
		expect(nextTerminalTick(14_999)).toBe(15_000);
	});

	it('gives each terminal 15 minutes, and caps them at 50', () => {
		expect(TERMINAL_MAX_MS).toBe(15 * 60_000);
		expect(MAX_TERMINALS).toBe(50);
		expect(terminalExpired(0, TERMINAL_MAX_MS - 1)).toBe(false);
		expect(terminalExpired(0, TERMINAL_MAX_MS)).toBe(true);
	});

	it('celebrates a flip to YES exactly once', () => {
		const yes = { status: 'yes' as const, statusChangedAt: '2026-11-07T12:00:00.000Z' };
		const at = Date.parse(yes.statusChangedAt);
		expect(isFreshFlip('soon', yes, at, null)).toBe(true);
		expect(isFreshFlip('no', yes, at + 60 * 60_000, null)).toBe(true); // heard live: whenever it says it happened
		expect(isFreshFlip('soon', yes, at, yes.statusChangedAt)).toBe(false); // already celebrated
		expect(isFreshFlip('yes', yes, at, null)).toBe(false); // it was yes already
		expect(isFreshFlip('soon', { ...yes, status: 'soon' }, at, null)).toBe(false);
	});

	it('after a wake, only celebrates a flip that is still fresh', () => {
		const yes = { status: 'yes' as const, statusChangedAt: '2026-11-07T12:00:00.000Z' };
		const at = Date.parse(yes.statusChangedAt);
		expect(isFreshFlip(null, yes, at + 30_000, null)).toBe(true);
		expect(isFreshFlip(null, yes, at + FRESH_FLIP_MS + 1, null)).toBe(false);
		expect(isFreshFlip(null, { ...yes, statusChangedAt: 'nonsense' }, at, null)).toBe(false);
	});
});

describe('the one-shot curl poster', () => {
	it('points at the live dashboard', () => {
		const text = stripAnsi(renderAscii(state('no'), { checks: 3, now: new Date(NOW) }));
		expect(text).toContain('curl -N iszacka.dad/live');
	});
});
