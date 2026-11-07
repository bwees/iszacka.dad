// OWNER: realtime agent.
// Aggregated check counters (checks_daily / checks_hourly / checks_country / checks_colo).
//
// A "check" is a human asking whether Zack is a dad (see COUNTED_PATHS in
// src/index.ts; only answered requests count). Nothing per-visitor is stored. The Worker only
// decides whether a request counts and sends the WaitingRoom Durable Object one tiny
// fire-and-forget RPC ({day, hour, country, colo}); it does no D1 work for a check. The
// waiting room tallies checks in memory, writes them to D1 in one batch at most every ~30 s
// (one upsert per distinct key, `count = count + n`), so D1 writes scale with time, not
// traffic, and keeps the running total that the live `checks` broadcast, the WebSocket hello
// and getCheckTotal() report. Losing a few seconds of counts when the object restarts (a
// deploy) is fine for a vanity counter. Bots, link previews, monitors, prefetches and refresh
// polls (`?poll=1`, e.g. the embed widget's timer) are ignored, on the grounds that they have
// no feelings to measure.

import { waitingRoom } from './live';
import { addDays, isYmd, londonDate, londonHour } from './time';

// ── Who counts ───────────────────────────────────────────────────────────────

/**
 * Things that fetch pages without being anxious about it: search crawlers, AI
 * crawlers, link unfurlers, uptime monitors, headless browsers and HTTP libraries.
 * `curl`, `wget` and HTTPie are deliberately absent: a human typing
 * `curl iszacka.dad` is checking, and it shows.
 *
 * Matched as plain substrings of the lower-cased user agent, not as one big case-insensitive
 * regex: compiling that regex cost about 0.6 ms on every cold isolate, and on Workers Free the
 * whole request gets 10 ms.
 */
const BOT_SUBSTRINGS = [
	'crawl',
	'spider',
	'slurp',
	'scraper',
	'scrapy',
	'scraping',
	'preview',
	'facebookexternalhit',
	'facebookcatalog',
	'meta-external',
	'slackbot',
	'slack-',
	'discordbot',
	'whatsapp',
	'skypeuri',
	'embedly',
	'iframely',
	'vkshare',
	'quora link',
	'mastodon',
	'akkoma',
	'pleroma',
	'misskey',
	'bluesky',
	'cardyb',
	'outbrain',
	'validator',
	'lighthouse',
	'pagespeed',
	'gtmetrix',
	'headless',
	'phantomjs',
	'puppeteer',
	'playwright',
	'selenium',
	'webdriver',
	'uptime',
	'monitor',
	'pingdom',
	'statuscake',
	'site24x7',
	'newrelic',
	'datadog',
	'checkly',
	'betterstack',
	'freshping',
	'hetrix',
	'ahrefs',
	'semrush',
	'mj12',
	'dataforseo',
	'bytespider',
	'gptbot',
	'chatgpt',
	'oai-searchbot',
	'claude',
	'anthropic',
	'perplexity',
	'ccbot',
	'cohere',
	'diffbot',
	'google-extended',
	'googleother',
	'google-inspectiontool',
	'pagerenderer',
	'feedfetcher',
	'mediapartners',
	'python-requests',
	'python-urllib',
	'python-httpx',
	'aiohttp',
	'go-http-client',
	'okhttp',
	'apache-httpclient',
	'java/',
	'node-fetch',
	'axios',
	'undici',
	'libwww-perl',
	'http_request2',
	'guzzlehttp',
	'nessus',
	'nikto',
	'sqlmap',
	'zgrab',
	'masscan',
	'nmap',
];

/** "bot" as a word, or as the end of one ("Googlebot/2.1", "bot-", "bot_"). Lower case. */
const BOT_WORD = /bot(?:\b|[/_;-])|\bbot/;
/** Bare runtimes' default user agents ("node", "Bun/1.1", "Deno/2.0"). Lower case. */
const BARE_RUNTIME = /^(?:node(?:\/|$)|bun\/|deno\/)/;
/** Phone brands whose names end in "bot" and would otherwise be mistaken for one. Lower case. */
const NOT_ACTUALLY_BOTS = /\bcubot\b/g;

/** True if the user agent belongs to something without feelings. A missing UA counts as one. */
export function isBot(userAgent: string | null | undefined): boolean {
	const ua = (userAgent ?? '').trim().toLowerCase();
	if (!ua) return true;
	const s = ua.includes('cubot') ? ua.replace(NOT_ACTUALLY_BOTS, '') : ua;
	if (BOT_WORD.test(s) || BARE_RUNTIME.test(s)) return true;
	for (const token of BOT_SUBSTRINGS) if (s.includes(token)) return true;
	return false;
}

/** Speculative prefetches aren't checks: the person may never look. */
export function isPrefetch(headers: Headers): boolean {
	const purpose =
		`${headers.get('sec-purpose') ?? ''} ${headers.get('purpose') ?? ''} ${headers.get('x-purpose') ?? ''} ${headers.get('x-moz') ?? ''}`.toLowerCase();
	return purpose.includes('prefetch') || purpose.includes('preview');
}

/** ISO 3166-1 alpha-2 (or Cloudflare's 'T1' for Tor), else 'XX'. */
export function normaliseCountry(value: unknown): string {
	if (typeof value !== 'string') return 'XX';
	const code = value.trim().toUpperCase();
	return /^(?:[A-Z]{2}|T1)$/.test(code) ? code : 'XX';
}

/** Three-letter IATA code of the Cloudflare datacentre, else 'XXX'. */
export function normaliseColo(value: unknown): string {
	if (typeof value !== 'string') return 'XXX';
	const code = value.trim().toUpperCase();
	return /^[A-Z]{3}$/.test(code) ? code : 'XXX';
}

function cfProperty(request: Request, key: 'country' | 'colo' | 'verifiedBot'): unknown {
	const cf = request.cf as Record<string, unknown> | undefined;
	if (!cf) return undefined;
	if (key === 'verifiedBot') {
		const bm = cf.botManagement as Record<string, unknown> | undefined;
		return bm?.verifiedBot;
	}
	return cf[key];
}

/** A cf string as-is (the waiting room normalises it), bounded so the RPC stays tiny. */
function cfString(request: Request, key: 'country' | 'colo'): string {
	const value = cfProperty(request, key);
	return typeof value === 'string' ? value.slice(0, 8) : '';
}

/** Whether a request is a refresh poll rather than someone checking (`?poll=1`). */
export function isRefreshPoll(request: Request): boolean {
	const url = request.url;
	const query = url.indexOf('?');
	if (query < 0) return false;
	// Skip parsing the URL when "poll" can't be in the query (not even percent-encoded).
	const rest = url.slice(query);
	if (!rest.includes('poll') && !rest.includes('%')) return false;
	try {
		return new URL(url).searchParams.has('poll');
	} catch {
		return false;
	}
}

// ── Recording ────────────────────────────────────────────────────────────────

/** One check, as the Worker sends it to the WaitingRoom (which validates it again). */
export interface CheckEvent {
	/** London day, 'YYYY-MM-DD'. */
	day: string;
	/** London hour of day, 0-23. */
	hour: number;
	/** cf.country as Cloudflare sent it; the waiting room normalises it. */
	country: string;
	/** cf.colo as Cloudflare sent it; the waiting room normalises it. */
	colo: string;
}

/** The check a request makes, or null if it doesn't count (bots, prefetches, refresh polls). */
export function checkFromRequest(request: Request, now: Date = new Date()): CheckEvent | null {
	if (isBot(request.headers.get('user-agent'))) return null;
	if (cfProperty(request, 'verifiedBot') === true) return null;
	if (isPrefetch(request.headers)) return null;
	// Refresh polls (embeds, the service worker) aren't someone checking.
	if (isRefreshPoll(request)) return null;
	return { day: londonDate(now), hour: londonHour(now), country: cfString(request, 'country'), colo: cfString(request, 'colo') };
}

/**
 * Count one "check" of the answer. The root middleware passes the result to waitUntil after
 * the route has answered. No awaits: it decides whether the request counts and fires one RPC
 * at the WaitingRoom, which does the tallying and the D1 writes on its own CPU budget. Never
 * rejects.
 */
export function recordCheck(env: Env, request: Request): Promise<void> {
	try {
		const check = checkFromRequest(request);
		if (!check) return Promise.resolve();
		return waitingRoom(env)
			.recordCheck(check)
			.catch((err: unknown) => {
				console.error('recordCheck failed:', err);
			});
	} catch (err) {
		console.error('recordCheck failed:', err);
		return Promise.resolve();
	}
}

/** A check from the wire, validated and normalised; null if it isn't one. */
export function parseCheckEvent(input: unknown): CheckEvent | null {
	if (typeof input !== 'object' || input === null) return null;
	const { day, hour, country, colo } = input as Partial<Record<keyof CheckEvent, unknown>>;
	if (!isYmd(day)) return null;
	if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
	return { day, hour, country: normaliseCountry(country), colo: normaliseColo(colo) };
}

/** Checks counted but not yet written to D1, per dimension D1 keeps. */
export interface CheckTallies {
	total: number;
	daily: Map<string, number>;
	hourly: Map<number, number>;
	country: Map<string, number>;
	colo: Map<string, number>;
}

export const emptyCheckTallies = (): CheckTallies => ({ total: 0, daily: new Map(), hourly: new Map(), country: new Map(), colo: new Map() });
const bump = <K>(map: Map<K, number>, key: K, n: number) => map.set(key, (map.get(key) ?? 0) + n);

/** Add one (normalised) check to a tally. */
export function tallyCheck(tallies: CheckTallies, check: CheckEvent): void {
	bump(tallies.daily, check.day, 1);
	bump(tallies.hourly, check.hour, 1);
	bump(tallies.country, check.country, 1);
	bump(tallies.colo, check.colo, 1);
	tallies.total += 1;
}

/** Add every count in `from` to `into` (a failed write going back in the queue). */
export function mergeCheckTallies(into: CheckTallies, from: CheckTallies): void {
	for (const [k, n] of from.daily) bump(into.daily, k, n);
	for (const [k, n] of from.hourly) bump(into.hourly, k, n);
	for (const [k, n] of from.country) bump(into.country, k, n);
	for (const [k, n] of from.colo) bump(into.colo, k, n);
	into.total += from.total;
}

/** The D1 upserts for a tally: one per distinct key, adding to whatever is there. */
export function checkUpserts(tallies: CheckTallies): Array<{ sql: string; args: [string | number, number] }> {
	const upsert = (table: string, column: string) =>
		`INSERT INTO ${table} (${column}, count) VALUES (?, ?) ON CONFLICT (${column}) DO UPDATE SET count = count + excluded.count`;
	const rows = <K extends string | number>(map: Map<K, number>, sql: string) =>
		[...map].map(([key, n]) => ({ sql, args: [key, n] as [string | number, number] }));
	return [
		...rows(tallies.daily, upsert('checks_daily', 'day')),
		...rows(tallies.hourly, upsert('checks_hourly', 'hour')),
		...rows(tallies.country, upsert('checks_country', 'country')),
		...rows(tallies.colo, upsert('checks_colo', 'colo')),
	];
}

/** Every check ever written to D1. */
export const CHECK_TOTAL_SQL = 'SELECT COALESCE(SUM(count), 0) AS total FROM checks_daily';

// ── Reading ──────────────────────────────────────────────────────────────────

const TOTAL_CACHE_MS = 2_000;
let totalCache: { at: number; value: number } | null = null;

/**
 * Total checks ever, including the ones the waiting room hasn't written to D1 yet: one RPC,
 * cached for ~2 s per isolate. Doesn't throw: if the waiting room is unreachable it falls back
 * to D1's total (without the last few seconds), then to the last known total (or 0).
 */
export async function getCheckTotal(env: Env): Promise<number> {
	const cached = totalCache;
	if (cached && Date.now() - cached.at < TOTAL_CACHE_MS) return cached.value;
	let value: number;
	try {
		value = Number(await waitingRoom(env).checkTotal()) || 0;
	} catch (err) {
		console.error('getCheckTotal: waiting room unavailable, asking D1:', err);
		try {
			const row = await env.DB.prepare(CHECK_TOTAL_SQL).first<{ total: number }>();
			// D1 lags the waiting room by a few seconds: never go backwards within an isolate.
			value = Math.max(Number(row?.total ?? 0) || 0, cached?.value ?? 0);
		} catch (err2) {
			console.error('getCheckTotal failed:', err2);
			return cached?.value ?? 0;
		}
	}
	totalCache = { at: Date.now(), value };
	return value;
}

// ── Analytics (for /stats) ───────────────────────────────────────────────────

export interface Tally {
	code: string;
	count: number;
}

export interface CheckStats {
	total: number;
	/** Checks today (Europe/London). */
	today: number;
	/** One entry per London day, oldest first, zero-filled, ending today. */
	daily: Array<{ day: string; count: number }>;
	/** 24 counts, index = London hour of day. */
	hourly: number[];
	/** Most-checking countries, busiest first. */
	countries: Tally[];
	/** Distinct known countries (excludes 'XX' and Tor). */
	countryCount: number;
	/** Busiest Cloudflare datacentres, busiest first. */
	colos: Tally[];
	/** Distinct known datacentres (excludes 'XXX'). */
	coloCount: number;
}

/** Zero-fill daily counts for the `days` London days ending `endDay` (inclusive), oldest first. */
export function fillDays(rows: ReadonlyArray<{ day: string; count: number }>, endDay: string, days: number): Array<{ day: string; count: number }> {
	const byDay = new Map(rows.map((r) => [r.day, Number(r.count) || 0]));
	const out: Array<{ day: string; count: number }> = [];
	for (let i = days - 1; i >= 0; i--) {
		const day = addDays(endDay, -i);
		out.push({ day, count: byDay.get(day) ?? 0 });
	}
	return out;
}

/** 24 hourly buckets from sparse rows. */
export function fillHours(rows: ReadonlyArray<{ hour: number; count: number }>): number[] {
	const hours = Array.from({ length: 24 }, () => 0);
	for (const row of rows) {
		const h = Number(row.hour);
		if (Number.isInteger(h) && h >= 0 && h < 24) hours[h] = Number(row.count) || 0;
	}
	return hours;
}

/** How long /stats aggregates are reused per isolate (the headline total is pushed live anyway). */
export const STATS_CACHE_MS = 30_000;
const statsCache = new Map<string, { at: number; value: CheckStats }>();

/**
 * Everything /stats needs, in one D1 round trip, cached for STATS_CACHE_MS per isolate (keyed by
 * the London day, so "today" rolls over at midnight). If D1 fails, the last good value for the
 * same key is returned; with none, it throws.
 */
export async function getCheckStats(env: Env, opts: { days?: number; top?: number } = {}): Promise<CheckStats> {
	const days = Math.min(Math.max(opts.days ?? 30, 1), 366);
	const top = Math.min(Math.max(opts.top ?? 10, 1), 100);
	const today = londonDate();
	const key = `${today}|${days}|${top}`;
	const cached = statsCache.get(key);
	if (cached && Date.now() - cached.at < STATS_CACHE_MS) return cached.value;
	try {
		const value = await readCheckStats(env, today, days, top);
		if (statsCache.size > 20) statsCache.clear();
		statsCache.set(key, { at: Date.now(), value });
		return value;
	} catch (err) {
		if (cached) return cached.value;
		throw err;
	}
}

async function readCheckStats(env: Env, today: string, days: number, top: number): Promise<CheckStats> {
	const since = addDays(today, -(days - 1));

	const [totalRes, dailyRes, hourlyRes, countryRes, countryCountRes, coloRes, coloCountRes] = await env.DB.batch<
		Record<string, unknown>
	>([
		env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM checks_daily'),
		env.DB.prepare('SELECT day, count FROM checks_daily WHERE day >= ? ORDER BY day').bind(since),
		env.DB.prepare('SELECT hour, count FROM checks_hourly'),
		env.DB.prepare('SELECT country AS code, count FROM checks_country ORDER BY count DESC, country ASC LIMIT ?').bind(top),
		env.DB.prepare("SELECT COUNT(*) AS n FROM checks_country WHERE country NOT IN ('XX', 'T1')"),
		env.DB.prepare('SELECT colo AS code, count FROM checks_colo ORDER BY count DESC, colo ASC LIMIT ?').bind(top),
		env.DB.prepare("SELECT COUNT(*) AS n FROM checks_colo WHERE colo <> 'XXX'"),
	]);

	const num = (value: unknown): number => Number(value) || 0;
	const daily = fillDays(
		(dailyRes?.results ?? []).map((r) => ({ day: String(r.day), count: num(r.count) })),
		today,
		days,
	);
	const tallies = (res: D1Result<Record<string, unknown>> | undefined): Tally[] =>
		(res?.results ?? []).map((r) => ({ code: String(r.code), count: num(r.count) }));

	return {
		total: num(totalRes?.results[0]?.total),
		today: daily.at(-1)?.count ?? 0,
		daily,
		hourly: fillHours((hourlyRes?.results ?? []).map((r) => ({ hour: num(r.hour), count: num(r.count) }))),
		countries: tallies(countryRes),
		countryCount: num(countryCountRes?.results[0]?.n),
		colos: tallies(coloRes),
		coloCount: num(coloCountRes?.results[0]?.n),
	};
}
