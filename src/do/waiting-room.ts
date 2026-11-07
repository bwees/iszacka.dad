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
// counts to SQLite (one upsert per emoji, not one per vibe), and sends SSE heartbeats
// (~15s) while streams exist.
//
// Storage: SQLite-backed. `vibes` holds all-time counts per emoji; the sync KV holds the
// opening date and the salt for client tags. The last broadcast viewer count is kept in
// memory on purpose: after a wake or restart the first alarm always re-broadcasts it, so
// clients that reconnected mid-count are corrected.

import { DurableObject } from 'cloudflare:workers';
import { getCheckTotal } from '../lib/counters';
import { randomToken, rateLimitSubject, sha256Hex } from '../lib/security';
import { getSetting, getState } from '../lib/state';
import { nowIso } from '../lib/time';
import type { LiveMessage, SiteState } from '../types';
import {
	frameBudget,
	heartbeatText,
	mergeVibeCounts,
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
}

interface StreamClient {
	writer: WritableStreamDefaultWriter<Uint8Array>;
	/** Writes not yet consumed by the reader. Too many means a stalled client. */
	pending: number;
	open: boolean;
	openedAt: number;
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
	#lastChecks = 0;
	/** Bumped by every state / reload broadcast, so a hello can tell it raced one. */
	#stateSeq = 0;
	#nonceSeq = 0;
	/** The viewer count last broadcast; null after a wake, so the first alarm always sends it. */
	#lastViewers: number | null = null;
	/** Vibes counted but not yet written to SQLite (flushed by the alarm). */
	readonly #pendingVibes = new Map<string, { n: number; lastAt: string }>();

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
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
	}

	/** Handles WebSocket upgrades (/ws) and SSE (/api/stream), forwarded by src/routes/live.ts. */
	override async fetch(request: Request): Promise<Response> {
		if ((request.headers.get('Upgrade') ?? '').toLowerCase() === 'websocket') return this.#acceptSocket(request);
		const { pathname } = new URL(request.url);
		if (pathname === '/api/stream') {
			if (request.method === 'GET') return this.#openStream();
			if (request.method === 'HEAD') return new Response(null, { headers: SSE_HEADERS });
		}
		return new Response('Not found. The waiting room only does /ws and /api/stream.', { status: 404, headers: TEXT_HEADERS });
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
	 * RPC for /api/live (polling clients): the live numbers plus the reload nonce, so a tab that
	 * can't hold a WebSocket still obeys "reload every browser". The nonce is cached for 30s.
	 */
	async liveSnapshot(): Promise<{ viewers: number; vibes: number; reloadNonce: string }> {
		return { viewers: this.#viewerCount(), vibes: this.#vibeTotal, reloadNonce: await this.#currentReloadNonce() };
	}

	/** RPC: live numbers plus the vibe breakdown, for /stats. */
	async details(): Promise<WaitingRoomDetails> {
		const rows = this.ctx.storage.sql.exec<{ emoji: string; count: number }>('SELECT emoji, count FROM vibes').toArray();
		const pending = new Map([...this.#pendingVibes].map(([emoji, v]) => [emoji, v.n]));
		const openSince = this.ctx.storage.kv.get<string>(OPENED_AT_KEY);
		return {
			viewers: this.#viewerCount(),
			sockets: this.#socketCount(),
			streams: this.#streams.size,
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
		this.ctx.waitUntil(this.#viewersChanged());
	}

	override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
		try {
			ws.close(sendableCloseCode(code), 'Bye. We will keep you posted.');
		} catch {
			// Already closed (the runtime may have replied to the close frame itself).
		}
		await this.#viewersChanged();
	}

	override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		console.warn('waiting room: socket error', error);
		try {
			ws.close(1011, 'Something went wrong.');
		} catch {
			// Already gone.
		}
		await this.#viewersChanged();
	}

	override async alarm(): Promise<void> {
		try {
			this.#flushVibes();
			this.#expireStreams();
			const viewers = this.#viewerCount();
			if (this.#lastViewers !== viewers) {
				this.#lastViewers = viewers;
				this.#fanOut({ type: 'viewers', viewers });
			}
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
		const now = Date.now();
		server.serializeAttachment({ connectedAt: now, vibes: [], frameWindowStart: now, frames: 0 } satisfies SocketAttachment);
		this.#send(server, JSON.stringify({ ...hello, viewers: this.#viewerCount() } satisfies HelloMessage));
		// The hello may already be out of date by the time the alarm runs: always correct it.
		this.#lastViewers = null;
		await this.#viewersChanged();
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
		this.#fanOut({ type: 'vibes', vibes: this.#vibeTotal, emoji: vibe.emoji });
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

	#socketCount(exclude?: WebSocket): number {
		let count = 0;
		for (const ws of this.ctx.getWebSockets()) {
			if (ws !== exclude && ws.readyState !== WS_CLOSING && ws.readyState !== WS_CLOSED) count++;
		}
		return count;
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

	// ── Shared ────────────────────────────────────────────────────────────────

	#viewerCount(): number {
		return this.#socketCount() + this.#streams.size;
	}

	#fanOut(msg: LiveMessage): void {
		const json = JSON.stringify(msg);
		for (const ws of this.ctx.getWebSockets()) this.#send(ws, json);
		if (this.#streams.size === 0) return;
		const frame = sseMessage(msg);
		for (const client of this.#streams) this.#write(client, frame);
	}

	/** Keep what broadcasts tell us, so hellos stay fresh without extra D1 reads. */
	#remember(msg: LiveMessage): void {
		const at = Date.now();
		switch (msg.type) {
			case 'state':
				this.#broadcastState = { state: msg.state, at };
				this.#knownState = msg.state;
				this.#stateSeq++;
				break;
			case 'reload':
				this.#reloadNonce = { value: msg.nonce, at };
				this.#nonceSeq++;
				break;
			case 'checks':
				this.#lastChecks = Math.max(this.#lastChecks, msg.checks);
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
		const [read, checks, readNonce] = await Promise.all([
			this.#currentState(),
			getCheckTotal(this.env),
			this.#currentReloadNonce(),
		]);
		const state = preferBroadcast(read, this.#broadcastState?.state, stateBefore, this.#stateSeq);
		const reloadNonce = preferBroadcast(readNonce, this.#reloadNonce?.value, nonceBefore, this.#nonceSeq);
		if (!state) return null;
		return {
			type: 'hello',
			state,
			viewers: this.#viewerCount(),
			vibes: this.#vibeTotal,
			checks: Math.max(checks, this.#lastChecks),
			reloadNonce,
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

	/** Schedule a (coalesced) viewer-count broadcast. */
	async #viewersChanged(): Promise<void> {
		try {
			await this.#ensureAlarm(Date.now() + VIEWER_DEBOUNCE_MS);
		} catch (err) {
			console.error('waiting room: could not schedule alarm', err);
		}
	}

	/** Make sure an alarm fires no later than `at` (never postpones an earlier one). */
	async #ensureAlarm(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		// A past value means that alarm is the one running right now, so it doesn't count.
		if (current === null || current <= Date.now() || current > at) await this.ctx.storage.setAlarm(at);
	}
}

function readAttachment(ws: WebSocket): SocketAttachment {
	const raw: unknown = ws.deserializeAttachment();
	const now = Date.now();
	if (typeof raw !== 'object' || raw === null) return { connectedAt: now, vibes: [], frameWindowStart: now, frames: 0 };
	const { connectedAt, vibes, frameWindowStart, frames } = raw as Partial<Record<keyof SocketAttachment, unknown>>;
	return {
		connectedAt: typeof connectedAt === 'number' ? connectedAt : now,
		vibes: Array.isArray(vibes) ? vibes.filter((t): t is number => typeof t === 'number') : [],
		// Attachments from before the frame budget existed start a fresh window.
		frameWindowStart: typeof frameWindowStart === 'number' ? frameWindowStart : now,
		frames: typeof frames === 'number' ? frames : 0,
	};
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
