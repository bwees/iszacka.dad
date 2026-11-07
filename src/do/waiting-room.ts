// OWNER: realtime agent.
// The single global Durable Object holding every live WebSocket (and SSE) client.
//
// WebSockets use the Hibernation API: the object can be evicted from memory while
// thousands of sockets stay connected, and pings are answered by the runtime's
// auto-responder without waking it. Per-socket data (vibe rate limit, frame budget) lives
// in the socket attachment so it survives hibernation. Every other inbound frame wakes the
// object and is billed, so a socket that sends junk, or more than FRAME_BUDGET frames per
// window, is closed (1003/1008); each client (IP, or IPv6 /64, hashed with a per-object
// salt and kept only as a socket tag) may hold MAX_SOCKETS_PER_CLIENT sockets.
//
// SSE streams are ordinary streaming responses, so while any are open the object stays
// awake (that's the price of supporting `curl -N`). One open stream keeps the production
// object awake around the clock: about 10,800 of the Workers Free plan's 13,000 GB-s a day.
// Preview environments close streams after PREVIEW_STREAM_MAX_MS so a forgotten
// `curl -N` against a PR preview can't use up the account's allowance.
//
// One alarm does several jobs: it coalesces viewer-count broadcasts (~1s), flushes vibe
// counts to SQLite (one upsert per emoji, not one per vibe), writes waiting checks to D1, and
// sends SSE heartbeats (~15s) while streams exist.
//
// Checks: every counted request sends one tiny `recordCheck` RPC here (src/lib/counters.ts),
// so the Worker does no D1 work for it. Checks are tallied in memory and written to D1's
// checks_* tables in one batch (one upsert per distinct key) at most every CHECK_FLUSH_MS; the
// same batch reads back D1's total, which plus whatever is still waiting is the running total
// that `checks` broadcasts, hellos and the `checkTotal` RPC report, with no SUM per call. The
// first check after a wake is written straight away, which is also how the total is learned.
// Hibernation forgets memory after ~10 s of quiet, so while checks wait the alarm looks in
// every CHECK_TICK_MS, and writes them as soon as traffic goes quiet. A restart (deploy) can
// still lose the few seconds' worth that were waiting; that's fine for a vanity counter.
//
// Social (src/lib/social.ts): each counted check also feeds a per-country `checkfeed` broadcast
// (at most every 3 s, only while someone is watching), a five-minute anxiety meter (an `anxiety`
// broadcast when its level changes) and round-number `milestone`s. All of it rides on the
// existing per-check work; the only extra alarms are the held-back feed and the moments the
// meter's level falls, and only while a viewer is connected.
//
// Storage: SQLite-backed. `vibes` holds all-time counts per emoji; the sync KV holds the
// opening date, the salt for client tags, the last milestone celebrated and the anxiety window
// (saved only when the object may be about to hibernate). The last broadcast viewer count is kept in
// memory on purpose: after a wake or restart the first alarm always re-broadcasts it, so
// clients that reconnected mid-count are corrected.
//
// Terminals (GET /live: `curl -N` streams, and hibernatable WebSockets tagged 'terminal' for
// websocat) get whole-screen ANSI frames instead of JSON (src/lib/ascii-live.ts). Every
// broadcast redraws them at once (bursts coalesced to one redraw per TERMINAL_MIN_REDRAW_MS),
// and while any terminal is connected, and only then, the alarm also ticks every
// TERMINAL_TICK_MS for the clocks. Each frame is rendered once and the same bytes go to every
// terminal. A terminal gets TERMINAL_MAX_MS, then a goodbye frame; MAX_TERMINALS at once. The
// flip to YES plays FIREWORKS_MS of fireworks (a timer, not the alarm: it happens once).

import { DurableObject } from 'cloudflare:workers';
import {
	CHECK_TOTAL_SQL,
	type CheckEvent,
	checkUpserts,
	emptyCheckTallies,
	mergeCheckTallies,
	normaliseCountry,
	parseCheckEvent,
	tallyCheck,
} from '../lib/counters';
import { LIVE_FALLBACK_GOODBYE, LIVE_PREAMBLE, type LatestUpdate, type LiveModel, renderFinalFrame, renderLiveFrame } from '../lib/ascii-live';
import { randomToken, rateLimitSubject, sha256Hex } from '../lib/security';
import { milestoneAtOrBelow, milestoneReached, type PulseOutput, SocialPulse } from '../lib/social';
import { getSetting, getState } from '../lib/state';
import { nowIso } from '../lib/time';
import { listUpdates } from '../lib/updates';
import type { AnxietyReading, LiveMessage, SiteState } from '../types';
import {
	CHECK_RETRY_MS,
	CHECK_TICK_MS,
	CHECKS_BROADCAST_MS,
	checksDue,
	FIREWORKS_FRAME_MS,
	FIREWORKS_MS,
	frameBudget,
	heartbeatText,
	isFreshFlip,
	MAX_TERMINAL_PENDING,
	MAX_TERMINALS,
	MAX_TERMINALS_PER_CLIENT,
	mergeVibeCounts,
	nextTerminalTick,
	TERMINAL_MIN_REDRAW_MS,
	TERMINAL_TAG,
	terminalExpired,
	parseClientMessage,
	parseVibe,
	PING_FRAME,
	PONG_FRAME,
	preferBroadcast,
	rankVibes,
	sendableCloseCode,
	sseComment,
	sseMessage,
	sseOpening,
	slidingWindow,
	streamExpired,
	type WaitingRoomDetails,
} from './waiting-room-protocol';

type HelloMessage = Extract<LiveMessage, { type: 'hello' }>;

/** Serialized onto each WebSocket; survives hibernation. Must stay under 2 KiB. */
interface SocketAttachment {
	connectedAt: number;
	/** Timestamps of recent vibes from this socket (sliding window). */
	vibes: number[];
	/** Frame budget window: when it started, and frames received in it. */
	frameWindowStart: number;
	frames: number;
	/** Social: the client's country (ISO 3166-1 alpha-2, or 'T1'), so its vibes can float from it on the map. */
	country?: string;
	/** A terminal (GET /live): gets ANSI frames, never JSON, and its messages are ignored. */
	terminal?: true;
}

interface StreamClient {
	writer: WritableStreamDefaultWriter<Uint8Array>;
	/** Writes not yet consumed by the reader. Too many means a stalled client. */
	pending: number;
	open: boolean;
	openedAt: number;
}

/** A `curl -N /live` stream. */
interface TerminalClient extends StreamClient {
	/** The client's terminal tag (see #clientTag), for the per-client cap; null without an IP. */
	tag: string | null;
}

/** Viewer-count broadcasts are coalesced into at most one per this interval. */
const VIEWER_DEBOUNCE_MS = 1_000;
/** SSE heartbeat cadence while any stream is open. */
const HEARTBEAT_MS = 15_000;
/** EventSource reconnect delay we ask for. */
const SSE_RETRY_MS = 5_000;
/** Outside production, streams are closed after this long, and asked not to come straight back. */
const PREVIEW_STREAM_MAX_MS = 5 * 60_000;
const PREVIEW_SSE_RETRY_MS = 10 * 60_000;
/** Open sockets per client (IP, or IPv6 /64). More tabs than that fall back to polling. */
const MAX_SOCKETS_PER_CLIENT = 20;
const VIBES_PER_SOCKET = 5;
const VIBE_WINDOW_MS = 10_000;
/** Global cap so a crowd of sockets can't turn every vibe into a fan-out storm. */
const VIBES_GLOBAL_PER_SECOND = 25;
/** Cloudflare allows ~32k WebSockets per object; leave headroom. */
const MAX_SOCKETS = 30_000;
const MAX_STREAMS = 2_000;
/** Unread frames before a stream counts as stalled (~10s of a full vibe storm, ~15 KB). */
const MAX_PENDING_WRITES = 256;
/** A state broadcast this recent beats the (1s-cached) D1 read for a new client's hello. */
const BROADCAST_STATE_TRUST_MS = 2_000;
const RELOAD_NONCE_TTL_MS = 30_000;

/** No longer written (the last broadcast viewer count lives in memory); deleted on start-up. */
const LEGACY_LAST_VIEWERS_KEY = 'last_viewers';
const OPENED_AT_KEY = 'opened_at';
const CLIENT_SALT_KEY = 'client_tag_salt';
/** Social: the last milestone celebrated (so none is ever announced twice) and the anxiety window. */
const MILESTONE_KEY = 'social_milestone';
const PULSE_KEY = 'social_pulse';

const WS_CLOSING = 2;
const WS_CLOSED = 3;

const SSE_HEADERS: Record<string, string> = {
	'Content-Type': 'text/event-stream; charset=utf-8',
	'Cache-Control': 'no-store, no-transform',
	'X-Accel-Buffering': 'no',
	'Access-Control-Allow-Origin': '*',
};

const TEXT_HEADERS: Record<string, string> = {
	'Content-Type': 'text/plain; charset=utf-8',
	'Cache-Control': 'no-store',
};

/** Broadcasts that change what the terminal dashboard shows (social ones like checkfeed don't). */
const TERMINAL_REDRAW_TYPES: ReadonlySet<LiveMessage['type']> = new Set(['state', 'update', 'viewers', 'vibes', 'checks']);

/** `curl -N /live`: unbuffered, unmodified, never cached. */
const TERMINAL_HEADERS: Record<string, string> = {
	'Content-Type': 'text/plain; charset=utf-8',
	'Cache-Control': 'no-store, no-transform',
	'X-Accel-Buffering': 'no',
	'X-Content-Type-Options': 'nosniff',
};

export class WaitingRoom extends DurableObject<Env> {
	readonly #encoder = new TextEncoder();
	readonly #streams = new Set<StreamClient>();
	#vibeTotal = 0;
	#recentVibes: number[] = [];
	/** Last state pushed through broadcast(), with when it arrived. */
	#broadcastState: { state: SiteState; at: number } | null = null;
	/** Last state known from any source; the fallback if D1 is unavailable. */
	#knownState: SiteState | null = null;
	#reloadNonce: { value: string; at: number } | null = null;
	/** Bumped by every state / reload broadcast, so a hello can tell it raced one. */
	#stateSeq = 0;
	#nonceSeq = 0;
	/** The viewer count last broadcast; null after a wake, so the first alarm always sends it. */
	#lastViewers: number | null = null;
	/** Vibes counted but not yet written to SQLite (flushed by the alarm). */
	readonly #pendingVibes = new Map<string, { n: number; lastAt: string }>();
	/** Checks counted but not yet written to D1, and when the oldest and newest of them arrived. */
	#pendingChecks = emptyCheckTallies();
	#firstCheckAt = 0;
	#lastCheckAt = 0;
	/** Checks in the D1 batch being written right now. */
	#writingChecks = 0;
	/** D1's total as of the last write; null until known since this object woke. */
	#storedChecks: number | null = null;
	/** The D1 write in progress, so there is only ever one. */
	#checksWrite: Promise<void> | null = null;
	/** No D1 write before this (set after one fails). */
	#checksRetryAt = 0;
	/** The total last sent out (or that would have been, had anyone been listening), and when. */
	#sentChecks = { value: -1, at: 0 };
	/** A newer total is waiting for the alarm (one went out under CHECKS_BROADCAST_MS ago). */
	#checksDirty = false;
	/** Open WebSockets; null when it needs recounting (after a wake, or a socket went away). */
	#sockets: number | null = null;
	/** When the alarm is set for: undefined until read from storage, null for none. */
	#alarmAt: number | null | undefined = undefined;
	/** Social: the check feed and the anxiety meter. */
	readonly #pulse: SocialPulse;
	/** Social: the last milestone celebrated; null until read from storage. */
	#lastMilestone: number | null = null;

	// Terminals (GET /live).
	readonly #terminals = new Set<TerminalClient>();
	/** Open terminal WebSockets; null when it needs recounting (after a wake, or one went away). */
	#terminalSockets: number | null = null;
	/** The newest update, for the dashboard; undefined until read from D1 since this object woke. */
	#latest: LatestUpdate | null | undefined = undefined;
	/** Bumped by every update broadcast, so a D1 read can tell it raced one. */
	#latestSeq = 0;
	/** Frames drawn (moves the hazard tape), and when the last one was. */
	#terminalFrames = 0;
	#terminalDrawnAt = 0;
	/** A coalesced redraw waiting to happen. */
	#terminalRedraw: ReturnType<typeof setTimeout> | null = null;
	/** When the next clock tick is due (0: none scheduled since this object woke). */
	#terminalTickAt = 0;
	/** The fireworks: when they started, and the timer for the next frame. */
	#fireworks: { start: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
	/** statusChangedAt of the last flip to YES celebrated, so a re-broadcast doesn't celebrate twice. */
	#celebrated: string | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const { sql, kv } = ctx.storage;
		sql.exec(
			`CREATE TABLE IF NOT EXISTS vibes (
				emoji   TEXT PRIMARY KEY,
				count   INTEGER NOT NULL DEFAULT 0,
				last_at TEXT
			)`,
		);
		this.#vibeTotal = Number(sql.exec<{ total: number }>('SELECT COALESCE(SUM(count), 0) AS total FROM vibes').one().total) || 0;
		if (kv.get(OPENED_AT_KEY) === undefined) kv.put(OPENED_AT_KEY, nowIso());
		if (kv.get(LEGACY_LAST_VIEWERS_KEY) !== undefined) kv.delete(LEGACY_LAST_VIEWERS_KEY);
		this.#pulse = new SocialPulse(kv.get(PULSE_KEY));
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
	}

	/**
	 * Handles WebSocket upgrades (/ws) and SSE (/api/stream), forwarded by src/routes/live.ts,
	 * and terminals (/live: a stream, or a WebSocket), forwarded by src/routes/terminal.ts.
	 */
	override async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if ((request.headers.get('Upgrade') ?? '').toLowerCase() === 'websocket') {
			return pathname === '/live' ? this.#acceptTerminalSocket(request) : this.#acceptSocket(request);
		}
		if (pathname === '/api/stream') {
			if (request.method === 'GET') return this.#openStream();
			if (request.method === 'HEAD') return new Response(null, { headers: SSE_HEADERS });
		}
		if (pathname === '/live' && request.method === 'GET') return this.#openTerminal(request);
		return new Response('Not found. The waiting room only does /ws, /api/stream and /live.', { status: 404, headers: TEXT_HEADERS });
	}

	/** RPC: send a message to every connected client. */
	async broadcast(msg: LiveMessage): Promise<void> {
		this.#remember(msg);
		this.#fanOut(msg);
	}

	/** RPC: current live numbers. */
	async stats(): Promise<{ viewers: number; vibes: number }> {
		return { viewers: this.#viewerCount(), vibes: this.#vibeTotal };
	}

	/**
	 * RPC for /api/live (polling clients): the live numbers and check total, plus the reload
	 * nonce, so a tab that can't hold a WebSocket still obeys "reload every browser". The nonce
	 * is cached for 30s.
	 */
	async liveSnapshot(): Promise<{ viewers: number; vibes: number; checks: number; reloadNonce: string; anxiety: AnxietyReading }> {
		const [checks, reloadNonce] = await Promise.all([this.#checkTotal(), this.#currentReloadNonce()]);
		return { viewers: this.#viewerCount(), vibes: this.#vibeTotal, checks, reloadNonce, anxiety: this.#pulse.reading(Date.now()) };
	}

	/**
	 * RPC from recordCheck (src/lib/counters.ts): count one check. Usually memory only; the
	 * first check after a wake is written to D1 straight away, which also learns the total.
	 */
	async recordCheck(input: CheckEvent): Promise<void> {
		const check = parseCheckEvent(input);
		if (!check) return;
		const now = Date.now();
		if (this.#pendingChecks.total === 0) this.#firstCheckAt = now;
		tallyCheck(this.#pendingChecks, check);
		this.#lastCheckAt = now;
		if (this.#storedChecks === null && now >= this.#checksRetryAt) await this.#syncChecks();
		this.#checksChanged(Date.now());
		await this.#socialCheck(check.country, now);
		if (this.#pendingChecks.total > 0) await this.#ensureAlarmSafely(now + CHECK_TICK_MS);
	}

	/** RPC: total checks ever, including the ones not yet written to D1. */
	async checkTotal(): Promise<number> {
		return this.#checkTotal();
	}

	/** RPC: live numbers plus the vibe breakdown, for /stats. */
	async details(): Promise<WaitingRoomDetails> {
		const rows = this.ctx.storage.sql.exec<{ emoji: string; count: number }>('SELECT emoji, count FROM vibes').toArray();
		const pending = new Map([...this.#pendingVibes].map(([emoji, v]) => [emoji, v.n]));
		const openSince = this.ctx.storage.kv.get<string>(OPENED_AT_KEY);
		return {
			viewers: this.#viewerCount(),
			sockets: this.#socketCount(),
			streams: this.#streams.size + this.#terminals.size,
			vibes: this.#vibeTotal,
			vibesByEmoji: rankVibes(mergeVibeCounts(rows, pending)),
			openSince: typeof openSince === 'string' ? openSince : null,
		};
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const attachment = readAttachment(ws);
		const budget = frameBudget({ start: attachment.frameWindowStart, frames: attachment.frames }, Date.now());
		if (!budget.allowed) {
			this.#close(ws, 1008, 'Too many messages.');
			return;
		}
		if (attachment.terminal) {
			// websocat sends whatever is typed. Typing at the dashboard changes nothing, so it's ignored.
			ws.serializeAttachment({ ...attachment, frameWindowStart: budget.start, frames: budget.frames } satisfies SocketAttachment);
			return;
		}
		const msg = parseClientMessage(message);
		// The real client never sends junk, so whoever does gets no second chance.
		if (!msg) {
			this.#close(ws, 1003, 'Unsupported message.');
			return;
		}
		ws.serializeAttachment({ ...attachment, frameWindowStart: budget.start, frames: budget.frames } satisfies SocketAttachment);
		if (msg.type === 'ping') {
			// Only reached when the frame isn't byte-identical to PING_FRAME (the auto-responder handles that).
			this.#send(ws, PONG_FRAME);
			return;
		}
		this.#vibe(ws, msg.emoji);
	}

	#close(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code, reason);
		} catch {
			// Already closing.
		}
		this.#sockets = null;
		this.#terminalSockets = null;
		this.ctx.waitUntil(this.#viewersChanged());
	}

	override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
		try {
			ws.close(sendableCloseCode(code), 'Bye. We will keep you posted.');
		} catch {
			// Already closed (the runtime may have replied to the close frame itself).
		}
		this.#sockets = null;
		this.#terminalSockets = null;
		await this.#viewersChanged();
	}

	override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		console.warn('waiting room: socket error', error);
		try {
			ws.close(1011, 'Something went wrong.');
		} catch {
			// Already gone.
		}
		this.#sockets = null;
		this.#terminalSockets = null;
		await this.#viewersChanged();
	}

	override async alarm(): Promise<void> {
		// This alarm is no longer pending; and recount sockets now and then, in case one went quietly.
		this.#alarmAt = null;
		this.#sockets = null;
		this.#terminalSockets = null;
		try {
			this.#flushVibes();
			this.#expireStreams();
			const viewers = this.#viewerCount();
			if (this.#lastViewers !== viewers) {
				this.#lastViewers = viewers;
				this.#fanOut({ type: 'viewers', viewers });
			}
			await this.#checksAlarm();
			await this.#socialTick();
			await this.#terminalAlarm();
			if (this.#streams.size > 0) {
				this.#heartbeat();
				await this.#ensureAlarm(Date.now() + HEARTBEAT_MS);
			}
		} catch (err) {
			// Swallow: a throwing alarm is retried with backoff, and a missed heartbeat isn't worth that.
			console.error('waiting room: alarm failed', err);
		}
	}

	// ── WebSockets ────────────────────────────────────────────────────────────

	async #acceptSocket(request: Request): Promise<Response> {
		if (this.#socketCount() >= MAX_SOCKETS) return roomFull();
		const tag = await this.#clientTag(request);
		if (tag && this.ctx.getWebSockets(tag).length >= MAX_SOCKETS_PER_CLIENT) return tooManySockets();
		const hello = await this.#hello();
		if (!hello) return unavailable();

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, tag ? [tag] : []);
		if (this.#sockets !== null) this.#sockets += 1;
		const now = Date.now();
		const country = socketCountry(request);
		server.serializeAttachment({
			connectedAt: now,
			vibes: [],
			frameWindowStart: now,
			frames: 0,
			...(country ? { country } : {}),
		} satisfies SocketAttachment);
		this.#send(server, JSON.stringify({ ...hello, viewers: this.#viewerCount() } satisfies HelloMessage));
		// The hello may already be out of date by the time the alarm runs: always correct it.
		this.#lastViewers = null;
		await this.#viewersChanged();
		// Someone is watching now, so a raised anxiety meter needs an alarm to fall on time.
		await this.#socialTick();
		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * A short tag for the connecting client: its IP (IPv6 reduced to the /64) hashed with a
	 * random per-object salt. Only ever held as a socket tag, never stored; null without an IP.
	 */
	async #clientTag(request: Request): Promise<string | null> {
		const ip = request.headers.get('cf-connecting-ip');
		if (!ip) return null;
		try {
			const { kv } = this.ctx.storage;
			let salt = kv.get<string>(CLIENT_SALT_KEY);
			if (typeof salt !== 'string') {
				salt = randomToken(24);
				kv.put(CLIENT_SALT_KEY, salt);
			}
			return `c:${(await sha256Hex(`${salt}:${rateLimitSubject(ip)}`)).slice(0, 24)}`;
		} catch (err) {
			console.error('waiting room: could not tag client', err);
			return null;
		}
	}

	#vibe(ws: WebSocket, rawEmoji: string | undefined): void {
		const vibe = parseVibe(rawEmoji);
		if (!vibe) return;
		const now = Date.now();
		const attachment = readAttachment(ws);
		const personal = slidingWindow(attachment.vibes, now, VIBES_PER_SOCKET, VIBE_WINDOW_MS);
		if (!personal.allowed) return;
		const global = slidingWindow(this.#recentVibes, now, VIBES_GLOBAL_PER_SECOND, 1_000);
		this.#recentVibes = global.times;
		if (!global.allowed) return;

		// Counted in memory; the alarm writes one row per emoji, however many vibes arrived.
		const entry = this.#pendingVibes.get(vibe.base);
		this.#pendingVibes.set(vibe.base, { n: (entry?.n ?? 0) + 1, lastAt: nowIso() });
		ws.serializeAttachment({ ...attachment, vibes: personal.times } satisfies SocketAttachment);
		this.#vibeTotal += 1;
		const { country } = attachment;
		this.#fanOut({ type: 'vibes', vibes: this.#vibeTotal, emoji: vibe.emoji, ...(country ? { country } : {}) });
		this.ctx.waitUntil(this.#viewersChanged()); // schedules the flush (at most one alarm a second)
	}

	/** Write pending vibe counts to SQLite, one upsert per emoji. Cleared only once written. */
	#flushVibes(): void {
		if (this.#pendingVibes.size === 0) return;
		const { sql } = this.ctx.storage;
		try {
			this.ctx.storage.transactionSync(() => {
				for (const [emoji, { n, lastAt }] of this.#pendingVibes) {
					sql.exec(
						`INSERT INTO vibes (emoji, count, last_at) VALUES (?, ?, ?)
						 ON CONFLICT (emoji) DO UPDATE SET count = count + excluded.count, last_at = excluded.last_at`,
						emoji,
						n,
						lastAt,
					);
				}
			});
			this.#pendingVibes.clear();
		} catch (err) {
			console.error('waiting room: could not store vibes', err);
		}
	}

	#send(ws: WebSocket, data: string): void {
		try {
			ws.send(data);
		} catch {
			// The socket is closing; webSocketClose will tidy up.
		}
	}

	/**
	 * Open WebSockets. Kept as a running count (accepting adds one) and only recounted from
	 * getWebSockets() after a socket goes away or the object wakes, not on every call: at the
	 * big moment there may be thousands of sockets and a page view asks for this every time.
	 */
	#socketCount(): number {
		if (this.#sockets === null) {
			let count = 0;
			for (const ws of this.ctx.getWebSockets()) {
				if (ws.readyState !== WS_CLOSING && ws.readyState !== WS_CLOSED) count++;
			}
			this.#sockets = count;
		}
		return this.#sockets;
	}

	// ── Server-Sent Events ────────────────────────────────────────────────────

	async #openStream(): Promise<Response> {
		if (this.#streams.size >= MAX_STREAMS) return roomFull();
		const hello = await this.#hello();
		if (!hello) return unavailable();

		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const client: StreamClient = { writer: writable.getWriter(), pending: 0, open: true, openedAt: Date.now() };
		this.#streams.add(client);
		// Fires when the reader goes away (client disconnected), however that surfaces.
		client.writer.closed.then(
			() => this.#drop(client),
			() => this.#drop(client),
		);
		const retry = this.#streamMaxMs() === null ? SSE_RETRY_MS : PREVIEW_SSE_RETRY_MS;
		this.#write(client, sseOpening({ ...hello, viewers: this.#viewerCount() }, retry));
		this.#lastViewers = null;
		await this.#viewersChanged();
		return new Response(readable, { headers: SSE_HEADERS });
	}

	/** Stream lifetime cap: none in production, PREVIEW_STREAM_MAX_MS everywhere else. */
	#streamMaxMs(): number | null {
		return this.env.ENVIRONMENT === 'production' ? null : PREVIEW_STREAM_MAX_MS;
	}

	/** Close streams past their lifetime cap, with a note saying why. */
	#expireStreams(): void {
		const maxMs = this.#streamMaxMs();
		if (maxMs === null) return;
		const now = Date.now();
		for (const client of [...this.#streams]) {
			if (!streamExpired(client.openedAt, now, maxMs)) continue;
			this.#write(client, sseComment(`preview streams close after ${Math.round(maxMs / 60_000)} minutes; reconnect, or use /ws`));
			const writer = client.writer;
			client.open = false;
			this.#streams.delete(client);
			writer.close().catch(() => {});
			this.ctx.waitUntil(this.#viewersChanged());
		}
	}

	#write(client: StreamClient, text: string): void {
		if (!client.open) return;
		if (client.pending >= MAX_PENDING_WRITES) {
			this.#drop(client);
			return;
		}
		client.pending++;
		client.writer.write(this.#encoder.encode(text)).then(
			() => {
				client.pending--;
			},
			() => this.#drop(client),
		);
	}

	#drop(client: StreamClient): void {
		if (!client.open) return;
		client.open = false;
		this.#streams.delete(client);
		client.writer.abort('dropped').catch(() => {
			// Already errored: that's usually why we're here.
		});
		this.ctx.waitUntil(this.#viewersChanged());
	}

	#heartbeat(): void {
		const frame = sseComment(heartbeatText(this.#knownState?.status ?? 'no'));
		for (const client of this.#streams) this.#write(client, frame);
	}

	// ── Terminals (GET /live) ─────────────────────────────────────────────────

	/** `curl -N /live`: a stream of whole-screen frames. */
	async #openTerminal(request: Request): Promise<Response> {
		const tag = await this.#terminalTag(request);
		if (!(await this.#loadTerminalModel())) return unavailable();
		const refused = this.#refuseTerminal(tag);
		if (refused) return refused;

		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const client: TerminalClient = { writer: writable.getWriter(), pending: 0, open: true, openedAt: Date.now(), tag };
		this.#terminals.add(client);
		// Fires when the reader goes away (Ctrl-C), however that surfaces.
		client.writer.closed.then(
			() => this.#dropTerminal(client),
			() => this.#dropTerminal(client),
		);
		this.#writeTerminal(client, this.#encoder.encode(`${LIVE_PREAMBLE}${this.#terminalFrame(Date.now())}`));
		await this.#terminalJoined();
		return new Response(readable, { headers: TERMINAL_HEADERS });
	}

	/** `websocat wss://…/live`: the same frames as text messages, on a hibernatable socket. */
	async #acceptTerminalSocket(request: Request): Promise<Response> {
		if (this.#socketCount() >= MAX_SOCKETS) return roomFull();
		const tag = await this.#terminalTag(request);
		if (!(await this.#loadTerminalModel())) return unavailable();
		const refused = this.#refuseTerminal(tag);
		if (refused) return refused;

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, tag ? [TERMINAL_TAG, tag] : [TERMINAL_TAG]);
		if (this.#sockets !== null) this.#sockets += 1;
		if (this.#terminalSockets !== null) this.#terminalSockets += 1;
		const now = Date.now();
		server.serializeAttachment({ connectedAt: now, vibes: [], frameWindowStart: now, frames: 0, terminal: true } satisfies SocketAttachment);
		this.#send(server, `${LIVE_PREAMBLE}${this.#terminalFrame(now)}`);
		await this.#terminalJoined();
		return new Response(null, { status: 101, webSocket: client });
	}

	/** The per-client tag for terminals (distinct from browser sockets' tags, so caps don't mix). */
	async #terminalTag(request: Request): Promise<string | null> {
		const tag = await this.#clientTag(request);
		return tag ? `t${tag}` : null;
	}

	/** Checked after every await, right before accepting, so concurrent connects can't overshoot. */
	#refuseTerminal(tag: string | null): Response | null {
		if (this.#terminalCount() >= MAX_TERMINALS) return terminalsFull();
		if (tag) {
			let mine = this.ctx.getWebSockets(tag).length;
			for (const client of this.#terminals) if (client.tag === tag) mine++;
			if (mine >= MAX_TERMINALS_PER_CLIENT) return tooManyTerminals();
		}
		return null;
	}

	async #terminalJoined(): Promise<void> {
		// Everyone's viewer count changes: the alarm sends it, which redraws every terminal.
		this.#lastViewers = null;
		await this.#viewersChanged();
		await this.#ensureTerminalTick();
		// Joined during the fireworks with nobody else watching: the show goes on.
		if (this.#fireworks && !this.#fireworks.timer) this.#fireworksFrame();
	}

	#terminalCount(): number {
		return this.#terminals.size + this.#terminalSocketCount();
	}

	#terminalSocketCount(): number {
		this.#terminalSockets ??= this.#terminalSocketList().length;
		return this.#terminalSockets;
	}

	/** Open terminal WebSockets (at most MAX_TERMINALS, so walking them is cheap). */
	#terminalSocketList(): WebSocket[] {
		return this.ctx
			.getWebSockets(TERMINAL_TAG)
			.filter((ws) => ws.readyState !== WS_CLOSING && ws.readyState !== WS_CLOSED && readAttachment(ws).terminal === true);
	}

	/** Make sure the state, the check total and the newest update are in memory, then the model. */
	async #loadTerminalModel(): Promise<LiveModel | null> {
		if (!this.#knownState) await this.#currentState();
		if (this.#storedChecks === null && Date.now() >= this.#checksRetryAt) await this.#syncChecks();
		if (this.#latest === undefined) await this.#loadLatest();
		return this.#terminalModel();
	}

	/** What the dashboard shows, from memory only; null if the answer isn't known. */
	#terminalModel(): LiveModel | null {
		const state = this.#knownState;
		if (!state) return null;
		return {
			state,
			viewers: this.#viewerCount(),
			terminals: this.#terminalCount(),
			vibes: this.#vibeTotal,
			checks: this.#knownChecks(),
			latest: this.#latest ?? null,
		};
	}

	async #loadLatest(): Promise<void> {
		const before = this.#latestSeq;
		try {
			const [update] = await listUpdates(this.env, { limit: 1 });
			// An update broadcast during the read is newer: never let the read overwrite it.
			if (this.#latestSeq === before) this.#latest = update ? { title: update.title, createdAt: update.createdAt } : null;
		} catch (err) {
			console.error('waiting room: latest update lookup failed', err);
		}
	}

	#terminalFrame(now: number, bell = false): string {
		const model = this.#terminalModel();
		if (!model) return '';
		return renderLiveFrame(model, { now, frame: this.#terminalFrames, fireworksAt: this.#fireworksAt(now), bell });
	}

	/** Render one frame and send the same bytes to every terminal. */
	#drawTerminals(bell = false): void {
		if (this.#terminalRedraw) {
			clearTimeout(this.#terminalRedraw);
			this.#terminalRedraw = null;
		}
		const now = Date.now();
		this.#terminalFrames++;
		this.#terminalDrawnAt = now;
		const frame = this.#terminalFrame(now, bell);
		if (frame) this.#sendTerminals(frame);
	}

	#sendTerminals(text: string): void {
		if (this.#terminals.size > 0) {
			const bytes = this.#encoder.encode(text);
			for (const client of [...this.#terminals]) this.#writeTerminal(client, bytes);
		}
		if (this.#terminalSocketCount() > 0) for (const ws of this.#terminalSocketList()) this.#send(ws, text);
	}

	#writeTerminal(client: TerminalClient, bytes: Uint8Array): void {
		if (!client.open) return;
		if (client.pending >= MAX_TERMINAL_PENDING) {
			this.#dropTerminal(client);
			return;
		}
		client.pending++;
		client.writer.write(bytes).then(
			() => {
				client.pending--;
			},
			() => this.#dropTerminal(client),
		);
	}

	#dropTerminal(client: TerminalClient): void {
		if (!client.open) return;
		client.open = false;
		this.#terminals.delete(client);
		client.writer.abort('dropped').catch(() => {
			// Already errored: that's usually why we're here.
		});
		this.ctx.waitUntil(this.#viewersChanged());
	}

	/** A broadcast arrived: redraw now, or once the last redraw is TERMINAL_MIN_REDRAW_MS old. */
	#terminalsChanged(): void {
		if (this.#fireworks?.timer || this.#terminalCount() === 0) return; // the fireworks draw every frame anyway
		const wait = this.#terminalDrawnAt + TERMINAL_MIN_REDRAW_MS - Date.now();
		if (wait <= 0) {
			this.#drawTerminals();
			return;
		}
		this.#terminalRedraw ??= setTimeout(() => {
			this.#terminalRedraw = null;
			this.#drawTerminals();
		}, wait);
	}

	async #ensureTerminalTick(): Promise<void> {
		const now = Date.now();
		if (this.#terminalTickAt <= now) this.#terminalTickAt = nextTerminalTick(now);
		await this.#ensureAlarmSafely(this.#terminalTickAt);
	}

	/** The alarm's part: the clock tick and the 15-minute goodbyes, only while terminals exist. */
	async #terminalAlarm(): Promise<void> {
		if (this.#terminalCount() === 0) return;
		const now = Date.now();
		if (now >= this.#terminalTickAt - 50) {
			this.#terminalTickAt = nextTerminalTick(now);
			// After a wake only hibernated sockets remain, and memory is empty: read what's missing.
			await this.#loadTerminalModel();
			this.#expireTerminals(Date.now());
			// Skipped if a broadcast (this alarm's viewer count, say) has only just drawn one.
			const fresh = Date.now() - this.#terminalDrawnAt < TERMINAL_MIN_REDRAW_MS;
			if (this.#terminalCount() > 0 && !this.#fireworks?.timer && !fresh) this.#drawTerminals();
		}
		if (this.#terminalCount() > 0) await this.#ensureAlarm(this.#terminalTickAt);
	}

	/** Say goodbye to terminals that have had their time, and hang up. */
	#expireTerminals(now: number): void {
		const streams = [...this.#terminals].filter((client) => terminalExpired(client.openedAt, now));
		const sockets = this.#terminalSocketCount() > 0 ? this.#terminalSocketList().filter((ws) => terminalExpired(readAttachment(ws).connectedAt, now)) : [];
		if (streams.length === 0 && sockets.length === 0) return;
		const model = this.#terminalModel();
		const goodbye = model ? renderFinalFrame(model, { now, frame: this.#terminalFrames }) : LIVE_FALLBACK_GOODBYE;
		if (streams.length > 0) {
			const bytes = this.#encoder.encode(goodbye);
			for (const client of streams) {
				this.#writeTerminal(client, bytes);
				client.open = false;
				this.#terminals.delete(client);
				client.writer.close().catch(() => {});
			}
		}
		for (const ws of sockets) {
			this.#send(ws, goodbye);
			try {
				ws.close(1000, 'Time is up. Run it again.');
			} catch {
				// Already closing.
			}
		}
		if (sockets.length > 0) {
			this.#sockets = null;
			this.#terminalSockets = null;
		}
		this.ctx.waitUntil(this.#viewersChanged());
	}

	/** Milliseconds into the fireworks, or undefined when there are none (or it's no longer yes). */
	#fireworksAt(now: number): number | undefined {
		const fireworks = this.#fireworks;
		if (!fireworks) return undefined;
		const t = now - fireworks.start;
		return t >= 0 && t < FIREWORKS_MS && this.#knownState?.status === 'yes' ? t : undefined;
	}

	/** The flip to YES: fireworks for every terminal (and the bell, once). */
	#celebrate(state: SiteState, at: number): void {
		this.#celebrated = state.statusChangedAt;
		if (this.#fireworks?.timer) clearTimeout(this.#fireworks.timer);
		this.#fireworks = { start: at, timer: null };
		if (this.#terminalCount() > 0) this.#fireworksFrame(true);
	}

	#fireworksFrame(bell = false): void {
		const fireworks = this.#fireworks;
		if (!fireworks) return;
		fireworks.timer = null;
		if (this.#fireworksAt(Date.now()) === undefined) {
			// Over (or un-flipped): settle on the static frame for whatever the answer is now.
			this.#fireworks = null;
			if (this.#terminalCount() > 0) this.#drawTerminals();
			return;
		}
		if (this.#terminalCount() === 0) return; // nobody watching; a terminal joining restarts the show
		this.#drawTerminals(bell);
		fireworks.timer = setTimeout(() => this.#fireworksFrame(), FIREWORKS_FRAME_MS);
	}

	// ── Shared ────────────────────────────────────────────────────────────────

	#viewerCount(): number {
		return this.#socketCount() + this.#streams.size + this.#terminals.size;
	}

	#fanOut(msg: LiveMessage): void {
		const json = JSON.stringify(msg);
		// Terminal sockets are in getWebSockets() too, but they get frames, not JSON.
		const terminals = this.#terminalSocketCount() > 0 ? new Set(this.#terminalSocketList()) : null;
		for (const ws of this.ctx.getWebSockets()) if (!terminals?.has(ws)) this.#send(ws, json);
		if (this.#streams.size > 0) {
			const frame = sseMessage(msg);
			for (const client of this.#streams) this.#write(client, frame);
		}
		if (TERMINAL_REDRAW_TYPES.has(msg.type)) this.#terminalsChanged();
	}

	/** Keep what broadcasts tell us, so hellos stay fresh without extra D1 reads. */
	#remember(msg: LiveMessage): void {
		const at = Date.now();
		switch (msg.type) {
			case 'state': {
				const previous = this.#knownState?.status ?? null;
				this.#broadcastState = { state: msg.state, at };
				this.#knownState = msg.state;
				this.#stateSeq++;
				if (isFreshFlip(previous, msg.state, at, this.#celebrated)) this.#celebrate(msg.state, at);
				break;
			}
			case 'update':
				this.#latest = { title: msg.update.title, createdAt: msg.update.createdAt };
				this.#latestSeq++;
				break;
			case 'reload':
				this.#reloadNonce = { value: msg.nonce, at };
				this.#nonceSeq++;
				break;
			default:
				break;
		}
	}

	/**
	 * The hello for a new client, or null if we can't say what the answer is. D1 reads don't
	 * block other events, so a broadcast can arrive (and miss this not-yet-accepted client)
	 * while they're in flight: whatever it carried wins over what was read. The caller accepts
	 * the client right after, with no I/O in between, so nothing can slip in after this.
	 */
	async #hello(): Promise<HelloMessage | null> {
		const stateBefore = this.#stateSeq;
		const nonceBefore = this.#nonceSeq;
		const [read, checks, readNonce] = await Promise.all([this.#currentState(), this.#checkTotal(), this.#currentReloadNonce()]);
		const state = preferBroadcast(read, this.#broadcastState?.state, stateBefore, this.#stateSeq);
		const reloadNonce = preferBroadcast(readNonce, this.#reloadNonce?.value, nonceBefore, this.#nonceSeq);
		if (!state) return null;
		return {
			type: 'hello',
			state,
			viewers: this.#viewerCount(),
			vibes: this.#vibeTotal,
			checks,
			reloadNonce,
			anxiety: this.#pulse.reading(Date.now()),
		};
	}

	async #currentState(): Promise<SiteState | null> {
		const pushed = this.#broadcastState;
		if (pushed && Date.now() - pushed.at < BROADCAST_STATE_TRUST_MS) return pushed.state;
		const before = this.#stateSeq;
		try {
			const state = await getState(this.env);
			// A broadcast during the read is newer: never let the read overwrite it.
			if (this.#stateSeq !== before && this.#broadcastState) return this.#broadcastState.state;
			this.#knownState = state;
			return state;
		} catch (err) {
			console.error('waiting room: state lookup failed', err);
			return this.#knownState;
		}
	}

	async #currentReloadNonce(): Promise<string> {
		const cached = this.#reloadNonce;
		if (cached && Date.now() - cached.at < RELOAD_NONCE_TTL_MS) return cached.value;
		const before = this.#nonceSeq;
		try {
			const value = (await getSetting(this.env, 'reload_nonce')) ?? '';
			if (this.#nonceSeq !== before && this.#reloadNonce) return this.#reloadNonce.value;
			this.#reloadNonce = { value, at: Date.now() };
			return value;
		} catch (err) {
			console.error('waiting room: reload nonce lookup failed', err);
			return cached?.value ?? '';
		}
	}

	// ── Checks ────────────────────────────────────────────────────────────────

	/** Total checks ever: D1's total plus whatever is being written or still waiting. */
	async #checkTotal(): Promise<number> {
		if (this.#storedChecks === null && Date.now() >= this.#checksRetryAt) await this.#syncChecks();
		return this.#knownChecks();
	}

	#knownChecks(): number {
		// Without D1's total (D1 has been down since this object woke), all we know is what's waiting.
		return (this.#storedChecks ?? 0) + this.#writingChecks + this.#pendingChecks.total;
	}

	/** Write the waiting checks to D1 and read back the total, in one batch. One at a time. */
	#syncChecks(): Promise<void> {
		this.#checksWrite ??= this.#writeChecks().finally(() => {
			this.#checksWrite = null;
		});
		return this.#checksWrite;
	}

	/** Never throws: if the batch fails, its checks go back in the queue for the next try. */
	async #writeChecks(): Promise<void> {
		const batch = this.#pendingChecks;
		const firstAt = this.#firstCheckAt;
		this.#pendingChecks = emptyCheckTallies();
		this.#writingChecks = batch.total;
		const { DB } = this.env;
		try {
			const results = await DB.batch<{ total: number }>([
				...checkUpserts(batch).map(({ sql, args }) => DB.prepare(sql).bind(...args)),
				DB.prepare(CHECK_TOTAL_SQL),
			]);
			// Same transaction as the upserts, so this includes them (and anyone else's writes).
			this.#storedChecks = Number(results.at(-1)?.results[0]?.total) || 0;
			this.#checksRetryAt = 0;
		} catch (err) {
			console.error('waiting room: could not store checks; keeping them for the next try', err);
			mergeCheckTallies(this.#pendingChecks, batch);
			// Anything that arrived during the write is newer than the batch.
			if (batch.total > 0) this.#firstCheckAt = firstAt;
			this.#checksRetryAt = Date.now() + CHECK_RETRY_MS;
		} finally {
			this.#writingChecks = 0;
		}
	}

	/** Send the new total: now, or from the alarm if one went out under CHECKS_BROADCAST_MS ago. */
	#checksChanged(now: number): void {
		if (this.#storedChecks === null) return; // unknown until D1 answers
		const checks = this.#knownChecks();
		if (checks === this.#sentChecks.value) return;
		if (this.#viewerCount() === 0) {
			// Nobody to tell (a new client's hello carries the total), so no alarm for it either.
			this.#sentChecks = { value: checks, at: this.#sentChecks.at };
			return;
		}
		if (now - this.#sentChecks.at >= CHECKS_BROADCAST_MS) {
			this.#sendChecks(now);
			return;
		}
		if (this.#checksDirty) return;
		this.#checksDirty = true;
		this.ctx.waitUntil(this.#ensureAlarmSafely(this.#sentChecks.at + CHECKS_BROADCAST_MS));
	}

	#sendChecks(now: number): void {
		this.#checksDirty = false;
		const checks = this.#knownChecks();
		if (checks === this.#sentChecks.value) return;
		this.#sentChecks = { value: checks, at: now };
		// Nobody listening: nothing to send (a new client's hello carries the total).
		if (this.#viewerCount() > 0) this.#fanOut({ type: 'checks', checks });
	}

	/** The alarm's part: write waiting checks when they're due, send a held-back total, keep ticking. */
	async #checksAlarm(): Promise<void> {
		const now = Date.now();
		if (this.#pendingChecks.total > 0 && now >= this.#checksRetryAt && checksDue(now, this.#firstCheckAt, this.#lastCheckAt)) {
			await this.#syncChecks();
		}
		if (this.#checksDirty || this.#storedChecks !== null) this.#sendChecks(Date.now());
		if (this.#pendingChecks.total > 0) await this.#ensureAlarm(Date.now() + CHECK_TICK_MS);
	}

	// ── Social: check feed, anxiety meter, milestones ─────────────────────────

	/** One counted check's social side: the feed, the meter and milestones. Never throws. */
	async #socialCheck(country: string, now: number): Promise<void> {
		try {
			const out = this.#pulse.check(country, now, this.#viewerCount() > 0);
			this.#milestone(country);
			await this.#socialOut(out, now);
		} catch (err) {
			console.error('waiting room: social check failed', err);
		}
	}

	/** The alarm's (or a new viewer's) turn: a held-back feed, a falling meter. Never throws. */
	async #socialTick(): Promise<void> {
		try {
			const now = Date.now();
			await this.#socialOut(this.#pulse.tick(now, this.#viewerCount() > 0), now);
		} catch (err) {
			console.error('waiting room: social tick failed', err);
		}
	}

	async #socialOut(out: PulseOutput, now: number): Promise<void> {
		for (const msg of out.messages) this.#fanOut(msg);
		// With nothing waiting for D1 the object may hibernate, which forgets memory, so keep the
		// meter's window (only if it changed). Under steady traffic checks are always waiting, so
		// this is one small write per burst of checks, not one per check.
		if (this.#pendingChecks.total === 0) {
			const snapshot = this.#pulse.snapshot(now);
			if (snapshot !== null) this.ctx.storage.kv.put(PULSE_KEY, snapshot);
		}
		if (out.wakeAt !== null) await this.#ensureAlarmSafely(out.wakeAt);
	}

	/**
	 * Celebrate the check that takes the total past a round number, once ever. The first time
	 * the total is known with nothing stored (a fresh deploy), the milestones already behind it
	 * are recorded without a fuss.
	 */
	#milestone(country: string): void {
		if (this.#storedChecks === null) return; // the total is unknown until D1 answers
		const total = this.#knownChecks();
		const { kv } = this.ctx.storage;
		if (this.#lastMilestone === null) {
			const stored = kv.get(MILESTONE_KEY);
			if (typeof stored === 'number' && Number.isFinite(stored)) {
				this.#lastMilestone = stored;
			} else {
				this.#lastMilestone = milestoneAtOrBelow(total - 1);
				kv.put(MILESTONE_KEY, this.#lastMilestone);
			}
		}
		const reached = milestoneReached(this.#lastMilestone, total);
		if (reached === null) return;
		this.#lastMilestone = reached;
		kv.put(MILESTONE_KEY, reached);
		this.#fanOut({ type: 'milestone', n: reached, country });
	}

	// ── Alarm ─────────────────────────────────────────────────────────────────

	/** Schedule a (coalesced) viewer-count broadcast. */
	async #viewersChanged(): Promise<void> {
		await this.#ensureAlarmSafely(Date.now() + VIEWER_DEBOUNCE_MS);
	}

	async #ensureAlarmSafely(at: number): Promise<void> {
		try {
			await this.#ensureAlarm(at);
		} catch (err) {
			console.error('waiting room: could not schedule alarm', err);
		}
	}

	/** Make sure an alarm fires no later than `at` (never postpones an earlier one). */
	async #ensureAlarm(at: number): Promise<void> {
		// Remembered, so the common case (an alarm is already due soon enough) costs no storage call.
		if (this.#alarmAt === undefined) {
			const stored = await this.ctx.storage.getAlarm();
			// Another call may have set one while this read was in flight: that one is newer.
			if (this.#alarmAt === undefined) this.#alarmAt = stored;
		}
		const current = this.#alarmAt;
		// A past value means that alarm is the one running right now, so it doesn't count.
		if (current !== null && current > Date.now() && current <= at) return;
		this.#alarmAt = at;
		try {
			await this.ctx.storage.setAlarm(at);
		} catch (err) {
			// Don't trust the remembered time if storage never got it: read it again next time.
			this.#alarmAt = undefined;
			throw err;
		}
	}
}

function readAttachment(ws: WebSocket): SocketAttachment {
	const raw: unknown = ws.deserializeAttachment();
	const now = Date.now();
	if (typeof raw !== 'object' || raw === null) return { connectedAt: now, vibes: [], frameWindowStart: now, frames: 0 };
	const { connectedAt, vibes, frameWindowStart, frames, country, terminal } = raw as Partial<Record<keyof SocketAttachment, unknown>>;
	const code = country === undefined ? 'XX' : normaliseCountry(country);
	return {
		connectedAt: typeof connectedAt === 'number' ? connectedAt : now,
		vibes: Array.isArray(vibes) ? vibes.filter((t): t is number => typeof t === 'number') : [],
		// Attachments from before the frame budget existed start a fresh window.
		frameWindowStart: typeof frameWindowStart === 'number' ? frameWindowStart : now,
		frames: typeof frames === 'number' ? frames : 0,
		...(code !== 'XX' ? { country: code } : {}),
		...(terminal === true ? { terminal: true as const } : {}),
	};
}

/** Social: where a connecting client is (the country, nothing finer), from Cloudflare's request metadata. */
function socketCountry(request: Request): string | undefined {
	const cf = (request as Request & { cf?: { country?: unknown } }).cf;
	const code = normaliseCountry(typeof cf?.country === 'string' ? cf.country : request.headers.get('cf-ipcountry'));
	return code === 'XX' ? undefined : code;
}

function terminalsFull(): Response {
	return new Response(
		`All ${MAX_TERMINALS} terminal seats are taken. The answer is the same out here: curl iszacka.dad\n`,
		{ status: 503, headers: { ...TEXT_HEADERS, 'Retry-After': '60' } },
	);
}

function tooManyTerminals(): Response {
	return new Response(`${MAX_TERMINALS_PER_CLIENT} terminals from one network is plenty. Close one; they all say the same thing.\n`, {
		status: 429,
		headers: { ...TEXT_HEADERS, 'Retry-After': '60' },
	});
}

function tooManySockets(): Response {
	return new Response('Too many open connections from your network. Close a tab or two; the others will keep you posted.', {
		status: 429,
		headers: { ...TEXT_HEADERS, 'Retry-After': '60' },
	});
}

function roomFull(): Response {
	return new Response('The waiting room is full. Take a seat in the corridor; the news will keep.', {
		status: 503,
		headers: { ...TEXT_HEADERS, 'Retry-After': '30' },
	});
}

function unavailable(): Response {
	return new Response('The waiting room could not find out what the answer is just now. Try again in a moment.', {
		status: 503,
		headers: { ...TEXT_HEADERS, 'Retry-After': '5' },
	});
}
