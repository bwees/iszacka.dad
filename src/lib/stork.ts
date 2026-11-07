// OWNER: corporate agent (pages & game).
// Catch the Stork (/stork): game tokens, score validation and the leaderboard.
//
// The game runs in the browser (public/stork.js), so the server can't watch it being played.
// What it can do:
//   * hand out a signed game token when a game starts (HMAC-SHA256 of the start time and a
//     random nonce, keyed off a random secret in `settings`), so a score has a start time the
//     client can't backdate;
//   * refuse scores that couldn't have been earned in the time since (MAX_POINTS_PER_SECOND,
//     comfortably above what the game's spawn rules allow), and a second score for one game;
//   * keep initials to three letters, minus a short list the stork's lawyers object to;
//   * cap each connection (IPv6 /64) at DAILY_SCORE_CAP scores per London day.
// CPU: one HMAC per request (microseconds), the key imported once per isolate.

import { base64UrlDecode, base64UrlEncode, randomToken } from './security';
import { getOrCreateSetting } from './state';
import { londonDate, londonOffsetMs } from './time';

/** How long a game token stays good for a score. A long game, plus time to type three letters. */
export const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
/** Tolerated clock difference between the isolate that issued a token and the one checking it. */
const CLOCK_SKEW_MS = 30_000;
/**
 * The most points a second of play could earn. The game drops at most one item every 0.45 s
 * and the best item is worth 3, with most worth 1 and a few worth nothing, so real play tops
 * out around 2.5 a second. Pausing only makes the allowance more generous.
 */
export const MAX_POINTS_PER_SECOND = 4;
/** Head start, so a lucky first few seconds aren't refused. */
export const SCORE_SLACK = 15;
export const MAX_SCORE = 100_000;
export const DAILY_SCORE_CAP = 5;
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_TTL_MS = 30_000;
export const SETTING_KEY = 'stork_secret';

/**
 * Three-letter words that don't go on a family leaderboard. Deliberately short: it catches
 * the obvious, and the admin can delete the inventive.
 */
const RUDE_INITIALS = new Set([
	'ASS', 'BUM', 'CNT', 'COK', 'CUM', 'DIC', 'DIK', 'FAG', 'FCK', 'FFS', 'FUC', 'FUK', 'FUQ', 'JIZ', 'KKK', 'KNT',
	'KYS', 'NAZ', 'NIG', 'NGR', 'PIS', 'PNS', 'SEX', 'SHT', 'STD', 'TIT', 'TWT', 'VAG', 'WNK', 'WTF', 'XXX',
]);

export function isRudeInitials(initials: string): boolean {
	return RUDE_INITIALS.has(initials);
}

/** Uppercased initials if they're exactly three letters A-Z, else null. Rudeness is checked separately. */
export function normaliseInitials(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const value = raw.trim().toUpperCase();
	return /^[A-Z]{3}$/.test(value) ? value : null;
}

/** A score as an integer in range, or null. Accepts a number or a string of digits. */
export function parseScore(raw: unknown): number | null {
	const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,7}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
	return Number.isSafeInteger(n) && n >= 1 && n <= MAX_SCORE ? n : null;
}

/** The highest score believable after `elapsedMs` of play. */
export function maxPlausibleScore(elapsedMs: number): number {
	return Math.min(MAX_SCORE, SCORE_SLACK + Math.floor((Math.max(0, elapsedMs) / 1000) * MAX_POINTS_PER_SECOND));
}

// ─── Game tokens ─────────────────────────────────────────────────────────────

/** The HMAC key per database (the secret lives in its settings), imported once per isolate. */
const keyCache = new WeakMap<object, Promise<CryptoKey>>();

function hmacKey(env: Env): Promise<CryptoKey> {
	let key = keyCache.get(env.DB);
	if (!key) {
		key = getOrCreateSetting(env, SETTING_KEY, () => randomToken(32)).then((secret) =>
			crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
		);
		// A failed read mustn't stick: forget it so the next request tries again.
		key.catch(() => keyCache.delete(env.DB));
		keyCache.set(env.DB, key);
	}
	return key;
}

const TOKEN_RE = /^([0-9a-z]{6,12})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;

/** A fresh game token: `<start ms, base 36>.<nonce>.<signature>`. */
export async function issueGameToken(env: Env, now = Date.now()): Promise<{ token: string; startedAt: number }> {
	const payload = `${now.toString(36)}.${randomToken(12)}`;
	const signature = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(payload));
	return { token: `${payload}.${base64UrlEncode(signature)}`, startedAt: now };
}

export type TokenCheck = { ok: true; startedAt: number; game: string } | { ok: false; reason: 'malformed' | 'forged' | 'expired' | 'future' };

/** Check a game token's signature and age. `game` is its nonce, unique per game. */
export async function verifyGameToken(env: Env, token: unknown, now = Date.now()): Promise<TokenCheck> {
	const match = typeof token === 'string' ? TOKEN_RE.exec(token.trim()) : null;
	if (!match) return { ok: false, reason: 'malformed' };
	const [, start = '', nonce = '', sig = ''] = match;
	let signature: Uint8Array;
	try {
		signature = base64UrlDecode(sig);
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	const valid = await crypto.subtle.verify('HMAC', await hmacKey(env), signature, new TextEncoder().encode(`${start}.${nonce}`));
	if (!valid) return { ok: false, reason: 'forged' };
	const startedAt = Number.parseInt(start, 36);
	if (!Number.isSafeInteger(startedAt)) return { ok: false, reason: 'malformed' };
	if (startedAt > now + CLOCK_SKEW_MS) return { ok: false, reason: 'future' };
	if (now - startedAt > TOKEN_TTL_MS) return { ok: false, reason: 'expired' };
	return { ok: true, startedAt, game: nonce };
}

// ─── Scores ──────────────────────────────────────────────────────────────────

export interface ScoreEntry {
	rank: number;
	initials: string;
	score: number;
	/** ISO UTC. */
	at: string;
}

/** 00:00 Europe/London today, as ISO UTC (the daily cap resets then). */
export function londonDayStartIso(now = Date.now()): string {
	const ymd = londonDate(new Date(now));
	const midnightUtc = Date.parse(`${ymd}T00:00:00Z`);
	return new Date(midnightUtc - (londonOffsetMs(midnightUtc) ?? 0)).toISOString();
}

const TOP_SQL = `SELECT initials, score, created_at AS at FROM stork_scores ORDER BY score DESC, id ASC LIMIT ${LEADERBOARD_SIZE}`;

function toEntries(rows: Array<{ initials: string; score: number; at: string }>): ScoreEntry[] {
	return rows.map((r, i) => ({ rank: i + 1, initials: r.initials, score: Number(r.score), at: r.at }));
}

/** The leaderboard per database, for LEADERBOARD_TTL_MS. */
const topCache = new WeakMap<object, { at: number; scores: ScoreEntry[] }>();

/** The top LEADERBOARD_SIZE scores, cached per isolate for about 30 s. */
export async function topScores(env: Env, opts: { fresh?: boolean; now?: number } = {}): Promise<ScoreEntry[]> {
	const now = opts.now ?? Date.now();
	const cached = topCache.get(env.DB);
	if (!opts.fresh && cached && now - cached.at < LEADERBOARD_TTL_MS) return cached.scores;
	const { results } = await env.DB.prepare(TOP_SQL).all<{ initials: string; score: number; at: string }>();
	const scores = toEntries(results);
	topCache.set(env.DB, { at: now, scores });
	return scores;
}

export type SubmitResult =
	| { ok: true; id: number; rank: number; scores: ScoreEntry[] }
	| { ok: false; code: 'duplicate' | 'limit' };

/**
 * Store a score, unless this game has already been submitted or the connection has used up
 * today's DAILY_SCORE_CAP. One D1 batch: the guarded insert, the new score's rank and the
 * fresh leaderboard.
 */
export async function submitScore(
	env: Env,
	input: { initials: string; score: number; ipHash: string | null; game: string; now?: number },
): Promise<SubmitResult> {
	const now = input.now ?? Date.now();
	const at = new Date(now).toISOString();
	const [inserted, ranked, top, existing] = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO stork_scores (initials, score, ip_hash, game, created_at)
			 SELECT ?1, ?2, ?3, ?4, ?5
			 WHERE (SELECT COUNT(*) FROM stork_scores WHERE ip_hash IS ?3 AND created_at >= ?6) < ?7
			 ON CONFLICT (game) DO NOTHING
			 RETURNING id`,
		).bind(input.initials, input.score, input.ipHash, input.game, at, londonDayStartIso(now), DAILY_SCORE_CAP),
		env.DB.prepare(
			`SELECT COUNT(*) AS ahead FROM stork_scores
			 WHERE score > ?1 OR (score = ?1 AND id < (SELECT id FROM stork_scores WHERE game = ?2))`,
		).bind(input.score, input.game),
		env.DB.prepare(TOP_SQL),
		env.DB.prepare('SELECT COUNT(*) AS n FROM stork_scores WHERE game = ?').bind(input.game),
	]);
	const row = (inserted?.results as Array<{ id: number }> | undefined)?.[0];
	if (!row) {
		const n = Number((existing?.results as Array<{ n: number }> | undefined)?.[0]?.n ?? 0);
		return { ok: false, code: n > 0 ? 'duplicate' : 'limit' };
	}
	const scores = toEntries((top?.results ?? []) as Array<{ initials: string; score: number; at: string }>);
	topCache.set(env.DB, { at: now, scores });
	const ahead = Number((ranked?.results as Array<{ ahead: number }> | undefined)?.[0]?.ahead ?? 0);
	return { ok: true, id: Number(row.id), rank: ahead + 1, scores };
}

/** Forget the cached leaderboard (tests, and an admin deleting a score). */
export function clearScoreCache(env: Env): void {
	topCache.delete(env.DB);
}
