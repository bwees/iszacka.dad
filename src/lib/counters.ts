// OWNER: realtime agent.
// Aggregated check counters (checks_daily / checks_hourly / checks_country / checks_colo).
//
// A "check" is a human asking whether Zack is a dad (see COUNTED_PATHS in
// src/index.ts; only answered requests count). Nothing per-visitor is stored: each check
// bumps an in-memory tally (day, hour, country, colo) in this isolate, and the tally is
// written to D1 in one batch about every CHECK_FLUSH_DELAY_MS (one upsert per distinct key,
// `count = count + n`), so D1 writes scale with time, not traffic. Losing a few seconds of
// counts when an isolate is evicted is fine for a vanity counter. Bots, link previews,
// monitors, prefetches and refresh polls (`?poll=1`, e.g. the embed widget's timer) are
// ignored, on the grounds that they have no feelings to measure.

import { broadcast } from './live';
import { addDays, londonDate, londonHour } from './time';

// ── Who counts ───────────────────────────────────────────────────────────────

/**
 * Things that fetch pages without being anxious about it: search crawlers, AI
 * crawlers, link unfurlers, uptime monitors, headless browsers and HTTP libraries.
 * `curl`, `wget` and HTTPie are deliberately absent: a human typing
 * `curl iszacka.dad` is checking, and it shows.
 */
const BOT_PATTERN = new RegExp(
	[
		'bot\\b',
		'bot[/_;-]',
		'\\bbot',
		'crawl',
		'spider',
		'slurp',
		'scrap(?:er|y|ing)',
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
		'chrome-lighthouse',
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
		'better uptime',
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
		'^node(?:/|$)',
		'^bun/',
		'^deno/',
		'libwww-perl',
		'http_request2',
		'guzzlehttp',
		'nessus',
		'nikto',
		'sqlmap',
		'zgrab',
		'masscan',
		'nmap',
	].join('|'),
	'i',
);

/** Phone brands whose names end in "bot" and would otherwise be mistaken for one. */
const NOT_ACTUALLY_BOTS = /\bcubot\b/gi;

/** True if the user agent belongs to something without feelings. A missing UA counts as one. */
export function isBot(userAgent: string | null | undefined): boolean {
	const ua = (userAgent ?? '').trim();
	if (!ua) return true;
	return BOT_PATTERN.test(ua.replace(NOT_ACTUALLY_BOTS, ''));
}

/** Speculative prefetches aren't checks: the person may never look. */
export function isPrefetch(headers: Headers): boolean {
	const purpose = `${headers.get('sec-purpose') ?? ''} ${headers.get('purpose') ?? ''} ${headers.get('x-purpose') ?? ''} ${headers.get('x-moz') ?? ''}`;
	return /prefetch|preview/i.test(purpose);
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

// ── Recording ────────────────────────────────────────────────────────────────

/** How long checks collect in memory before one D1 batch writes them (well under waitUntil's 30s). */
export const CHECK_FLUSH_DELAY_MS = 15_000;

interface Tallies {
	total: number;
	daily: Map<string, number>;
	hourly: Map<number, number>;
	country: Map<string, number>;
	colo: Map<string, number>;
}

const emptyTallies = (): Tallies => ({ total: 0, daily: new Map(), hourly: new Map(), country: new Map(), colo: new Map() });
const bump = <K>(map: Map<K, number>, key: K, n: number) => map.set(key, (map.get(key) ?? 0) + n);

/** Checks counted in this isolate but not yet written to D1. */
let pending = emptyTallies();
let flushScheduled = false;

/** Whether a request is a refresh poll rather than someone checking (`?poll=1`). */
export function isRefreshPoll(request: Request): boolean {
	try {
		return new URL(request.url).searchParams.has('poll');
	} catch {
		return false;
	}
}

/**
 * Count one "check" of the answer. Called via waitUntil by the root middleware, after the
 * route has answered. Never throws. The request that schedules the next flush keeps its
 * waitUntil open until the flush has run; the rest return straight away.
 */
export async function recordCheck(env: Env, request: Request): Promise<void> {
	try {
		if (isBot(request.headers.get('user-agent'))) return;
		if (cfProperty(request, 'verifiedBot') === true) return;
		if (isPrefetch(request.headers)) return;
		// Refresh polls (embeds, the service worker) aren't someone checking.
		if (isRefreshPoll(request)) return;

		const now = new Date();
		bump(pending.daily, londonDate(now), 1);
		bump(pending.hourly, londonHour(now), 1);
		bump(pending.country, normaliseCountry(cfProperty(request, 'country')), 1);
		bump(pending.colo, normaliseColo(cfProperty(request, 'colo')), 1);
		pending.total += 1;

		if (flushScheduled) return;
		flushScheduled = true;
		try {
			await new Promise<void>((resolve) => setTimeout(resolve, CHECK_FLUSH_DELAY_MS));
		} finally {
			flushScheduled = false;
		}
		if ((await flushChecks(env)) > 0) await sendChecks(env);
	} catch (err) {
		console.error('recordCheck failed:', err);
	}
}

/**
 * Write the pending tallies to D1 in one batch (one upsert per distinct key) and clear them.
 * Returns how many checks were written. If the batch fails, the counts go back into the
 * tally for the next flush rather than being dropped. Never throws.
 */
export async function flushChecks(env: Env): Promise<number> {
	const batch = pending;
	pending = emptyTallies();
	if (batch.total === 0) return 0;
	const upsert = (table: string, column: string) =>
		`INSERT INTO ${table} (${column}, count) VALUES (?, ?) ON CONFLICT (${column}) DO UPDATE SET count = count + excluded.count`;
	const statements = [
		...[...batch.daily].map(([day, n]) => env.DB.prepare(upsert('checks_daily', 'day')).bind(day, n)),
		...[...batch.hourly].map(([hour, n]) => env.DB.prepare(upsert('checks_hourly', 'hour')).bind(hour, n)),
		...[...batch.country].map(([country, n]) => env.DB.prepare(upsert('checks_country', 'country')).bind(country, n)),
		...[...batch.colo].map(([colo, n]) => env.DB.prepare(upsert('checks_colo', 'colo')).bind(colo, n)),
	];
	try {
		await env.DB.batch(statements);
	} catch (err) {
		console.error('flushChecks failed; keeping the counts for the next flush:', err);
		for (const [k, n] of batch.daily) bump(pending.daily, k, n);
		for (const [k, n] of batch.hourly) bump(pending.hourly, k, n);
		for (const [k, n] of batch.country) bump(pending.country, k, n);
		for (const [k, n] of batch.colo) bump(pending.colo, k, n);
		pending.total += batch.total;
		return 0;
	}
	// The cached D1 total is now behind by exactly what was just written.
	if (totalCache) totalCache.value += batch.total;
	return batch.total;
}

/** Checks counted in this isolate and not yet in D1 (for tests and the live total). */
export function pendingCheckCount(): number {
	return pending.total;
}

async function sendChecks(env: Env): Promise<void> {
	try {
		const total = await readCheckTotal(env);
		totalCache = { at: Date.now(), value: total };
		await broadcast(env, { type: 'checks', checks: total + pending.total });
	} catch (err) {
		console.error('checks broadcast failed:', err);
	}
}

// ── Reading ──────────────────────────────────────────────────────────────────

const TOTAL_CACHE_MS = 2_000;
let totalCache: { at: number; value: number } | null = null;

async function readCheckTotal(env: Env): Promise<number> {
	const row = await env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM checks_daily').first<{ total: number }>();
	return Number(row?.total ?? 0) || 0;
}

/**
 * Total checks ever, including this isolate's not-yet-flushed ones. The D1 part is cached
 * for ~2s per isolate. Doesn't throw: if D1 is having a moment it returns the last known
 * total (or 0).
 */
export async function getCheckTotal(env: Env): Promise<number> {
	const cached = totalCache;
	if (cached && Date.now() - cached.at < TOTAL_CACHE_MS) return cached.value + pending.total;
	try {
		const value = await readCheckTotal(env);
		// Never go backwards within an isolate (a local increment may be ahead of a replica).
		const best = Math.max(value, cached?.value ?? 0);
		totalCache = { at: Date.now(), value: best };
		return best + pending.total;
	} catch (err) {
		console.error('getCheckTotal failed:', err);
		return (cached?.value ?? 0) + pending.total;
	}
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
