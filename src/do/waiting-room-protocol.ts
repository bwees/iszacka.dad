// OWNER: realtime agent.
// Pure helpers for the WaitingRoom live protocol: vibe allowlist + rate limiting,
// client message parsing and Server-Sent Events framing. No Workers runtime
// imports, so all of it is unit-testable under Node.

import type { ClientMessage, LiveMessage, Status } from '../types';

/** Exact frames for the hibernation auto-responder (answered without waking the object). */
export const PING_FRAME = '{"type":"ping"}';
export const PONG_FRAME = '{"type":"pong"}';

/**
 * The only emoji anyone may send. Curated for maximum supportiveness and mild
 * alarm, plus the two the homepage's vibe buttons send (💛 and ☕).
 */
export const VIBE_EMOJIS = ['👏', '🍼', '🎉', '💪', '🙏', '👶', '🥚', '❤️', '🍾', '😬', '💛', '☕'] as const;
export type VibeEmoji = (typeof VIBE_EMOJIS)[number];

/** Allowlisted emoji that also accept a single Fitzpatrick skin-tone modifier. */
const TONEABLE: ReadonlySet<VibeEmoji> = new Set<VibeEmoji>(['👏', '💪', '🙏', '👶']);
const VARIATION_SELECTOR = /️/g;
const BY_BARE: ReadonlyMap<string, VibeEmoji> = new Map(VIBE_EMOJIS.map((e) => [e.replace(VARIATION_SELECTOR, ''), e]));
const WITH_SKIN_TONE = /^(.+?)([\u{1F3FB}-\u{1F3FF}])$/u;

export interface Vibe {
	/** What gets broadcast (keeps a skin tone if one was sent). */
	emoji: string;
	/** What gets counted. */
	base: VibeEmoji;
}

/**
 * Validate a client-supplied vibe against the allowlist. Tolerates a missing or
 * extra U+FE0F (so "❤" counts as "❤️") and a skin tone on the hand/baby emoji.
 */
export function parseVibe(input: unknown): Vibe | null {
	if (typeof input !== 'string' || input.length === 0 || input.length > 16) return null;
	const bare = input.trim().replace(VARIATION_SELECTOR, '');
	const exact = BY_BARE.get(bare);
	if (exact) return { emoji: exact, base: exact };
	const toned = WITH_SKIN_TONE.exec(bare);
	if (toned) {
		const base = BY_BARE.get(toned[1] ?? '');
		if (base && TONEABLE.has(base)) return { emoji: `${base}${toned[2]}`, base };
	}
	return null;
}

/**
 * Sliding-window rate limit. Returns whether an event at `now` is allowed and the
 * pruned list of timestamps to keep (including `now` when allowed).
 */
export function slidingWindow(
	times: readonly number[],
	now: number,
	limit: number,
	windowMs: number,
): { allowed: boolean; times: number[] } {
	const recent = times.filter((t) => Number.isFinite(t) && t <= now && now - t < windowMs);
	if (recent.length >= limit) return { allowed: false, times: recent };
	recent.push(now);
	return { allowed: true, times: recent };
}

/** Longest client frame we bother parsing. A vibe is about 30 bytes. */
export const MAX_CLIENT_FRAME = 512;

/** Parse a WebSocket frame from a browser. Anything unexpected is null (and ignored). */
export function parseClientMessage(raw: string | ArrayBuffer): ClientMessage | null {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CLIENT_FRAME) return null;
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
	const { type, emoji } = data as { type?: unknown; emoji?: unknown };
	if (type === 'ping') return { type: 'ping' };
	if (type === 'vibe') return typeof emoji === 'string' ? { type: 'vibe', emoji } : { type: 'vibe' };
	return null;
}

const LINE_BREAK = /\r\n|\r|\n/;

/** One SSE event: `event: <name>` + `data: <json>` lines + a blank line. */
export function sseFrame(event: string, data: unknown): string {
	const name = event.replace(/[\r\n]/g, '');
	const json = JSON.stringify(data) ?? 'null';
	const lines = json
		.split(LINE_BREAK)
		.map((line) => `data: ${line}`)
		.join('\n');
	return `event: ${name}\n${lines}\n\n`;
}

/** A live message as an SSE event named after its type. */
export function sseMessage(msg: LiveMessage): string {
	return sseFrame(msg.type, msg);
}

/** An SSE comment block (ignored by EventSource; keeps proxies and curl awake). */
export function sseComment(text: string): string {
	return `${text
		.split(LINE_BREAK)
		.map((line) => `: ${line}`)
		.join('\n')}\n\n`;
}

/** The opening of every stream: a greeting, the reconnect delay, then the hello event. */
export function sseOpening(hello: Extract<LiveMessage, { type: 'hello' }>, retryMs: number): string {
	const retry = Math.max(0, Math.floor(retryMs));
	return `: Is Zack a dad? This stream will let you know.\nretry: ${retry}\n\n${sseMessage(hello)}`;
}

/** Heartbeat comment text. The brief said ": still no"; we were thorough. */
export function heartbeatText(status: Status): string {
	switch (status) {
		case 'no':
			return 'still no';
		case 'soon':
			return 'still not yet (but it is happening)';
		case 'yes':
			return 'still yes';
	}
}

const SENDABLE_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014]);

/** Close codes like 1005/1006 are receive-only; echo anything sendable, else 1000. */
export function sendableCloseCode(code: number): number {
	return SENDABLE_CLOSE_CODES.has(code) || (code >= 3000 && code <= 4999) ? code : 1000;
}

/** RPC `details()`: everything the waiting room knows, for /stats. */
export interface WaitingRoomDetails {
	/** WebSockets + SSE streams. */
	viewers: number;
	sockets: number;
	streams: number;
	vibes: number;
	/** Every allowlisted emoji with its all-time count, most popular first. */
	vibesByEmoji: Array<{ emoji: VibeEmoji; count: number }>;
	/** When this waiting room first opened its doors (ISO). */
	openSince: string | null;
}

/** Every allowlisted emoji with its count (0 if never sent), most popular first, ties in allowlist order. */
export function rankVibes(rows: ReadonlyArray<{ emoji: string; count: number }>): Array<{ emoji: VibeEmoji; count: number }> {
	const counts = new Map<VibeEmoji, number>();
	for (const row of rows) {
		const vibe = parseVibe(row.emoji);
		if (vibe && Number.isFinite(row.count)) counts.set(vibe.base, (counts.get(vibe.base) ?? 0) + Math.max(0, row.count));
	}
	return VIBE_EMOJIS.map((emoji, order) => ({ emoji, count: counts.get(emoji) ?? 0, order }))
		.sort((a, b) => b.count - a.count || a.order - b.order)
		.map(({ emoji, count }) => ({ emoji, count }));
}

// ── Abuse budgets and bookkeeping (pure) ─────────────────────────────────────

/** Frames one socket may send per window. The real client sends ~1 vibe per 650ms at most. */
export const FRAME_BUDGET = 30;
export const FRAME_WINDOW_MS = 10_000;

/**
 * Fixed-window frame budget for one socket. Every inbound frame counts (junk included), because
 * every frame wakes the object and is billed. Returns whether this frame is within budget and
 * the window to store back on the socket.
 */
export function frameBudget(
	window: { start: number; frames: number },
	now: number,
	budget = FRAME_BUDGET,
	windowMs = FRAME_WINDOW_MS,
): { allowed: boolean; start: number; frames: number } {
	const fresh = !Number.isFinite(window.start) || now - window.start >= windowMs || now < window.start;
	const start = fresh ? now : window.start;
	const frames = (fresh ? 0 : Math.max(0, window.frames)) + 1;
	return { allowed: frames <= budget, start, frames };
}

/** Stored vibe counts plus not-yet-flushed deltas, as rows for rankVibes. */
export function mergeVibeCounts(
	rows: ReadonlyArray<{ emoji: string; count: number }>,
	pending: ReadonlyMap<string, number>,
): Array<{ emoji: string; count: number }> {
	const out = new Map<string, number>();
	for (const row of rows) out.set(row.emoji, (out.get(row.emoji) ?? 0) + (Number(row.count) || 0));
	for (const [emoji, n] of pending) out.set(emoji, (out.get(emoji) ?? 0) + n);
	return [...out].map(([emoji, count]) => ({ emoji, count }));
}

/**
 * A new client's hello is built from reads that take a moment (D1). If a broadcast arrived
 * while they were in flight, it is newer than anything read, so it wins. `before`/`after` are
 * the broadcast sequence numbers either side of the reads.
 */
export function preferBroadcast<T>(read: T, pushed: T | undefined, before: number, after: number): T {
	return after !== before && pushed !== undefined ? pushed : read;
}

/** Whether an SSE stream has outlived `maxMs` (only previews cap their streams). */
export function streamExpired(openedAt: number, now: number, maxMs: number | null): boolean {
	return maxMs !== null && now - openedAt >= maxMs;
}
