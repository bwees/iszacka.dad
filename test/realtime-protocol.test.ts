import { describe, expect, it } from 'vitest';
import {
	heartbeatText,
	parseClientMessage,
	parseVibe,
	PING_FRAME,
	PONG_FRAME,
	rankVibes,
	sendableCloseCode,
	slidingWindow,
	sseComment,
	sseFrame,
	sseMessage,
	sseOpening,
	VIBE_EMOJIS,
} from '../src/do/waiting-room-protocol';
import type { LiveMessage } from '../src/types';

describe('SSE framing', () => {
	it('formats an event with a single data line and a blank-line terminator', () => {
		expect(sseFrame('vibes', { type: 'vibes', vibes: 3, emoji: '🎉' })).toBe(
			'event: vibes\ndata: {"type":"vibes","vibes":3,"emoji":"🎉"}\n\n',
		);
	});

	it('names the event after the live message type', () => {
		const msg: LiveMessage = { type: 'viewers', viewers: 42 };
		expect(sseMessage(msg)).toBe('event: viewers\ndata: {"type":"viewers","viewers":42}\n\n');
	});

	it('keeps newlines inside strings escaped, so a payload is always one data line', () => {
		const frame = sseFrame('update', { body: 'line one\nline two\r\nthree' });
		expect(frame.split('\n').filter((l) => l.startsWith('data: '))).toHaveLength(1);
		expect(frame.endsWith('\n\n')).toBe(true);
	});

	it('strips line breaks from event names so they cannot inject fields', () => {
		expect(sseFrame('evil\ndata: pwned', 1)).toBe('event: evildata: pwned\ndata: 1\n\n');
	});

	it('serialises undefined data as null rather than producing an empty data line', () => {
		expect(sseFrame('x', undefined)).toBe('event: x\ndata: null\n\n');
	});

	it('formats comments, one colon per line', () => {
		expect(sseComment('still no')).toBe(': still no\n\n');
		expect(sseComment('a\nb')).toBe(': a\n: b\n\n');
	});

	it('opens with a greeting, a retry hint and the hello event', () => {
		const hello: Extract<LiveMessage, { type: 'hello' }> = {
			type: 'hello',
			state: { status: 'no', statusChangedAt: '2026-11-06T21:30:00.000Z', dueDate: null },
			viewers: 1,
			vibes: 0,
			checks: 7,
			reloadNonce: '',
		};
		const opening = sseOpening(hello, 5000.7);
		const [preamble, event] = opening.split('\n\n');
		expect(preamble).toBe(': Is Zack a dad? This stream will let you know.\nretry: 5000');
		expect(event).toBe(`event: hello\ndata: ${JSON.stringify(hello)}`);
		expect(opening.endsWith('\n\n')).toBe(true);
	});

	it('has a heartbeat for every status', () => {
		expect(heartbeatText('no')).toBe('still no');
		expect(heartbeatText('soon')).toContain('not yet');
		expect(heartbeatText('yes')).toBe('still yes');
	});
});

describe('vibe allowlist', () => {
	it('accepts every allowlisted emoji as-is', () => {
		for (const emoji of VIBE_EMOJIS) expect(parseVibe(emoji)).toEqual({ emoji, base: emoji });
	});

	it('tolerates a missing variation selector on the heart', () => {
		expect(parseVibe('❤')).toEqual({ emoji: '❤️', base: '❤️' });
	});

	it('accepts everything the homepage vibe buttons send', () => {
		for (const emoji of ['💛', '🍼', '🎉', '☕', '🙏', '☕️']) expect(parseVibe(emoji)).not.toBeNull();
	});

	it('accepts a skin tone on hands and babies, counting it as the base emoji', () => {
		expect(parseVibe('👏🏽')).toEqual({ emoji: '👏🏽', base: '👏' });
		expect(parseVibe('👶🏿')).toEqual({ emoji: '👶🏿', base: '👶' });
	});

	it('rejects skin tones on emoji that do not take them', () => {
		expect(parseVibe('🍼🏽')).toBeNull();
	});

	it('rejects anything else', () => {
		for (const bad of ['💩', '', 'hello', '<script>', '👏👏', '🎉'.repeat(10), 42, null, undefined, {}]) {
			expect(parseVibe(bad)).toBeNull();
		}
	});

	it('ranks vibes by count, ties in allowlist order, zeros included', () => {
		const ranked = rankVibes([
			{ emoji: '🍾', count: 3 },
			{ emoji: '👏', count: 3 },
			{ emoji: '😬', count: 9 },
			{ emoji: 'nonsense', count: 100 },
		]);
		expect(ranked.slice(0, 3)).toEqual([
			{ emoji: '😬', count: 9 },
			{ emoji: '👏', count: 3 },
			{ emoji: '🍾', count: 3 },
		]);
		expect(ranked).toHaveLength(VIBE_EMOJIS.length);
		expect(ranked.at(-1)?.count).toBe(0);
	});
});

describe('sliding-window rate limit', () => {
	it('allows five in ten seconds, then refuses', () => {
		let times: number[] = [];
		for (let i = 0; i < 5; i++) {
			const r = slidingWindow(times, 1_000 + i, 5, 10_000);
			expect(r.allowed).toBe(true);
			times = r.times;
		}
		const sixth = slidingWindow(times, 1_010, 5, 10_000);
		expect(sixth.allowed).toBe(false);
		expect(sixth.times).toHaveLength(5);
	});

	it('forgets events once they leave the window', () => {
		const partly = slidingWindow([0, 1, 2, 3, 4], 10_002, 5, 10_000);
		expect(partly).toEqual({ allowed: true, times: [3, 4, 10_002] });
		const fully = slidingWindow([0, 1, 2, 3, 4], 10_004, 5, 10_000);
		expect(fully).toEqual({ allowed: true, times: [10_004] });
	});

	it('ignores nonsense timestamps (future or non-finite)', () => {
		const r = slidingWindow([Number.NaN, Number.POSITIVE_INFINITY, 99_999], 50, 1, 10_000);
		expect(r).toEqual({ allowed: true, times: [50] });
	});
});

describe('client messages', () => {
	it('parses pings and vibes', () => {
		expect(parseClientMessage(PING_FRAME)).toEqual({ type: 'ping' });
		expect(parseClientMessage('{"type":"vibe","emoji":"🎉"}')).toEqual({ type: 'vibe', emoji: '🎉' });
		expect(parseClientMessage('{"type":"vibe","emoji":7}')).toEqual({ type: 'vibe' });
	});

	it('ignores binary, junk, oversized and unknown frames', () => {
		expect(parseClientMessage(new ArrayBuffer(4))).toBeNull();
		expect(parseClientMessage('not json')).toBeNull();
		expect(parseClientMessage('[]')).toBeNull();
		expect(parseClientMessage('null')).toBeNull();
		expect(parseClientMessage('{"type":"admin"}')).toBeNull();
		expect(parseClientMessage(JSON.stringify({ type: 'vibe', emoji: 'x'.repeat(600) }))).toBeNull();
	});

	it('uses the exact frames the auto-responder expects', () => {
		expect(JSON.parse(PING_FRAME)).toEqual({ type: 'ping' });
		expect(JSON.parse(PONG_FRAME)).toEqual({ type: 'pong' });
		expect(JSON.stringify({ type: 'ping' })).toBe(PING_FRAME);
	});
});

describe('close codes', () => {
	it('echoes sendable codes and replaces receive-only ones', () => {
		expect(sendableCloseCode(1000)).toBe(1000);
		expect(sendableCloseCode(1001)).toBe(1001);
		expect(sendableCloseCode(4000)).toBe(4000);
		expect(sendableCloseCode(1005)).toBe(1000);
		expect(sendableCloseCode(1006)).toBe(1000);
		expect(sendableCloseCode(1015)).toBe(1000);
		expect(sendableCloseCode(0)).toBe(1000);
	});
});

describe('abuse budgets and hello reconciliation', () => {
	it('closes a socket once it goes over its frame budget', async () => {
		const { frameBudget, FRAME_BUDGET, FRAME_WINDOW_MS } = await import('../src/do/waiting-room-protocol');
		let window = { start: 0, frames: 0 };
		const t0 = 1_000_000;
		for (let i = 0; i < FRAME_BUDGET; i++) {
			const next = frameBudget(window, t0 + i);
			expect(next.allowed).toBe(true);
			window = { start: next.start, frames: next.frames };
		}
		expect(frameBudget(window, t0 + 100).allowed).toBe(false);
		// A new window starts afresh.
		expect(frameBudget(window, t0 + FRAME_WINDOW_MS)).toMatchObject({ allowed: true, frames: 1 });
		// Old attachments without the fields start a fresh window too.
		expect(frameBudget({ start: Number.NaN, frames: 0 }, t0).allowed).toBe(true);
	});

	it('adds unflushed vibes to the stored counts', async () => {
		const { mergeVibeCounts, rankVibes } = await import('../src/do/waiting-room-protocol');
		const merged = mergeVibeCounts([{ emoji: '🍼', count: 3 }], new Map([['🍼', 2], ['🎉', 1]]));
		const ranked = rankVibes(merged);
		expect(ranked[0]).toEqual({ emoji: '🍼', count: 5 });
		expect(ranked.find((v) => v.emoji === '🎉')?.count).toBe(1);
	});

	it('lets a broadcast that raced the hello win', async () => {
		const { preferBroadcast } = await import('../src/do/waiting-room-protocol');
		expect(preferBroadcast('no (read)', 'yes (pushed)', 4, 5)).toBe('yes (pushed)');
		expect(preferBroadcast('no (read)', 'yes (pushed)', 5, 5)).toBe('no (read)');
		expect(preferBroadcast('no (read)', undefined, 4, 5)).toBe('no (read)');
	});

	it('only caps stream lifetimes when asked to (previews)', async () => {
		const { streamExpired } = await import('../src/do/waiting-room-protocol');
		const minute = 60_000;
		expect(streamExpired(0, 5 * minute, 5 * minute)).toBe(true);
		expect(streamExpired(0, 4 * minute, 5 * minute)).toBe(false);
		expect(streamExpired(0, 365 * 24 * 60 * minute, null)).toBe(false);
	});
});
