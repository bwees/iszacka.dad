// OWNER: realtime agent.
// /ws (WebSocket), /api/stream (SSE), /api/live (JSON), /stats (anxiety analytics page).

import { type Context, Hono } from 'hono';
import { html } from 'hono/html';
import { LinearRouter } from 'hono/router/linear-router';
import type { WaitingRoomDetails } from '../do/waiting-room-protocol';
import { type CheckStats, getCheckStats, getCheckTotal, type Tally } from '../lib/counters';
import { coloInfo, countryName, flagEmoji } from '../lib/counters-geo';
import { type Html, buildId, renderPage } from '../lib/layout';
import { liveSnapshot, waitingRoom } from '../lib/live';
import { allow, clientKey } from '../lib/security';
import { getStatusHistory } from '../lib/state';
import { formatDayMonth, formatLondon, formatLondonDate, formatNumber, formatWeekdayDayMonth, londonDate, londonHour } from '../lib/time';
import type { AppEnv, SiteState, Status } from '../types';

export const liveRoutes = new Hono<AppEnv>({ router: new LinearRouter() });

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

// ── Live transport ───────────────────────────────────────────────────────────

liveRoutes.get('/ws', async (c) => {
	if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') {
		return c.text(
			'426 Upgrade Required. This is a WebSocket, not a web page. Connect with `new WebSocket(...)` and you will be told the moment Zack is a dad.\n',
			426,
			{ ...NO_STORE, Upgrade: 'websocket', Connection: 'Upgrade' },
		);
	}
	if (!(await allow(c.env.RL_API, `ws:${clientKey(c)}`))) return tooManyRequests(c);
	return forwardToWaitingRoom(c);
});

liveRoutes.get('/api/stream', async (c) => {
	if (!(await allow(c.env.RL_API, `sse:${clientKey(c)}`))) return tooManyRequests(c);
	return forwardToWaitingRoom(c);
});

liveRoutes.get('/api/live', async (c) => {
	const headers = { ...NO_STORE, 'Access-Control-Allow-Origin': '*' };
	if (!(await allow(c.env.RL_API, `live:${clientKey(c)}`))) {
		return c.json({ error: 'Too many requests. The answer has not changed in the last second.' }, 429, {
			...headers,
			'Retry-After': '60',
		});
	}
	// One RPC: the snapshot carries the check total too (getCheckTotal only if it couldn't).
	const live = await liveSnapshot(c.env);
	const checks = live.checks ?? (await getCheckTotal(c.env));
	// reloadNonce lets polling tabs (no WebSocket) obey "reload every browser"; it's left out,
	// rather than sent empty, when the waiting room is unreachable, so nobody reloads by mistake.
	// state saves pollers from guessing it from the X-Is-Zack-A-Dad header.
	return c.json(
		{
			viewers: live.viewers,
			vibes: live.vibes,
			checks,
			state: c.get('state'),
			...(typeof live.reloadNonce === 'string' ? { reloadNonce: live.reloadNonce } : {}),
		},
		200,
		headers,
	);
});

/**
 * Hand the request to the WaitingRoom. The reply is re-wrapped so its headers are
 * mutable (the root middleware adds headers to every response).
 */
async function forwardToWaitingRoom(c: Context<AppEnv>): Promise<Response> {
	try {
		const res = await waitingRoom(c.env).fetch(c.req.raw);
		if (res.webSocket) return new Response(null, { status: 101, webSocket: res.webSocket, headers: res.headers });
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
	} catch (err) {
		console.error('waiting room unreachable:', err);
		return c.text('The waiting room is having a little lie down. Try again in a moment.\n', 503, {
			...NO_STORE,
			'Retry-After': '5',
		});
	}
}

function tooManyRequests(c: Context<AppEnv>): Response {
	return c.text('Too many reconnects. Breathe. The answer will still be there in a minute.\n', 429, {
		...NO_STORE,
		'Retry-After': '60',
	});
}

// ── /stats: anxiety analytics ────────────────────────────────────────────────

type RoomInfo = WaitingRoomDetails & { available: boolean };

async function roomDetails(env: Env): Promise<RoomInfo> {
	try {
		return { ...(await waitingRoom(env).details()), available: true };
	} catch (err) {
		console.error('waiting room details failed:', err);
		return { viewers: 0, sockets: 0, streams: 0, vibes: 0, vibesByEmoji: [], openSince: null, available: false };
	}
}

/** /stats reads the status history on every view; a short per-isolate cache keeps D1 reads down. */
const HISTORY_CACHE_MS = 15_000;
let historyCache: { at: number; value: Array<{ status: Status; at: string }> } | null = null;

async function cachedStatusHistory(env: Env): Promise<Array<{ status: Status; at: string }>> {
	const cached = historyCache;
	if (cached && Date.now() - cached.at < HISTORY_CACHE_MS) return cached.value;
	try {
		const value = await getStatusHistory(env);
		historyCache = { at: Date.now(), value };
		return value;
	} catch (err) {
		if (cached) return cached.value;
		throw err;
	}
}

/**
 * The rendered /stats page is the same for everyone served by one datacentre for a while, so
 * it's kept in the edge cache (caches.default, which is per datacentre) for this long. On a
 * quiet site most requests land in a fresh isolate, where a per-isolate cache would never hit;
 * a cache hit skips the D1 reads, the Durable Object call and the render.
 */
export const STATS_CACHE_SECONDS = 30;

/** The edge cache, where there is one (not in unit tests; a no-op on workers.dev). */
function edgeCache(): Cache | null {
	try {
		return typeof caches === 'undefined' ? null : caches.default;
	} catch {
		return null;
	}
}

/**
 * Cache key for a rendered /stats page: everything the page shows that isn't a shared count.
 * The state goes in whole (the page shell carries the change time and due date for app.js,
 * and a versioned og:image), and so does the build, so a deploy never serves the old shell.
 * Not a routable path, and nothing in it comes from the query string.
 */
export function statsCacheKey(origin: string, state: SiteState, colo: string | null, build: string): string {
	const parts = [state.status, state.statusChangedAt, state.dueDate ?? '-', colo ?? '-', build].map(encodeURIComponent);
	return `${origin}/__cache/stats/v1/${parts.join('/')}`;
}

const HTML_NO_STORE = { 'Content-Type': 'text/html; charset=UTF-8', ...NO_STORE } as const;

liveRoutes.get('/stats', async (c) => {
	if (!(await allow(c.env.RL_API, `stats:${clientKey(c)}`))) {
		return c.text('Too many requests. The statistics are not that exciting; try again in a minute.\n', 429, {
			...NO_STORE,
			'Retry-After': '60',
		});
	}
	const state = c.get('state');
	const status = state.status;
	const cf = c.req.raw.cf as Record<string, unknown> | undefined;
	const colo = typeof cf?.colo === 'string' ? cf.colo : null;
	const url = new URL(c.req.url);
	// Local dev and production alike: advertise https unless it's genuinely a local host.
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
	const origin = `${local ? url.protocol : 'https:'}//${url.host}`;

	const cache = edgeCache();
	const build = buildId(c.env);
	const cacheKey = statsCacheKey(origin, state, colo, build ? `${build.tag ?? build.id}@${build.timestamp ?? ''}` : 'local');
	if (cache) {
		const hit = await cache.match(cacheKey).catch((err: unknown) => {
			console.error('stats cache read failed:', err);
			return undefined;
		});
		if (hit) return new Response(hit.body, { status: 200, headers: HTML_NO_STORE });
	}

	const [stats, room, history] = await Promise.all([
		getCheckStats(c.env).catch((err: unknown) => {
			console.error('check stats failed:', err);
			return null;
		}),
		roomDetails(c.env),
		cachedStatusHistory(c.env).catch((err: unknown) => {
			console.error('status history failed:', err);
			return [];
		}),
	]);
	// The first history row is the site's birth, not a change of answer.
	const changeDays = new Set(
		history
			.slice(1)
			.filter((h) => !Number.isNaN(Date.parse(h.at)))
			.map((h) => londonDate(new Date(h.at))),
	);

	c.header('Cache-Control', 'no-store');
	const res = await renderPage(c, {
		title: 'Anxiety analytics',
		description: 'How often people check whether Zack is a dad, when, and from where. Aggregated, anonymous and slightly concerning.',
		status: stats ? 200 : 503,
		body: statsPage({
			status,
			stats,
			room,
			answerChanges: Math.max(0, history.length - 1),
			changeDays,
			colo,
			origin,
		}),
	});
	// Only a complete page is worth sharing: not the counters-down 503, nor a missing waiting room.
	if (cache && res.status === 200 && room.available && res.body) {
		const copy = new Response(res.clone().body, {
			headers: { 'Content-Type': HTML_NO_STORE['Content-Type'], 'Cache-Control': `public, max-age=${STATS_CACHE_SECONDS}` },
		});
		const put = cache.put(cacheKey, copy).catch((err: unknown) => console.error('stats cache write failed:', err));
		try {
			c.executionCtx.waitUntil(put);
		} catch {
			// No execution context (tests): the put just runs unawaited.
		}
	}
	return res;
});

interface StatsView {
	status: Status;
	stats: CheckStats | null;
	room: RoomInfo;
	answerChanges: number;
	changeDays: ReadonlySet<string>;
	colo: string | null;
	origin: string;
}

// No Intl here (see lib/time.ts): the first Intl call in a fresh isolate costs milliseconds.
const fmt = (n: number): string => formatNumber(n);
const plural = (n: number, one: string, many: string): string => `${fmt(n)} ${n === 1 ? one : many}`;
const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`;
/** "12:34", London time. */
const londonClock = (d: Date): string => formatLondon(d.toISOString(), { weekday: undefined, day: undefined, month: undefined, year: undefined });

/**
 * A share (0-1) as en-GB writes it with `{ style: 'percent', maximumFractionDigits: 1 }`:
 * "12.3%", "12%", "0.1%", "100%". Like ICU, it rounds the shortest decimal that round-trips
 * (what String() gives), half away from zero, so 0.0045 is "0.5%" (toFixed would say 0.4).
 */
export function formatShare(share: number): string {
	if (!(share >= 0 && share <= 1)) return new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 }).format(share);
	if (share < 0.0005) return '0%'; // also keeps String() out of exponent notation
	const [whole = '0', fraction = ''] = String(share).split('.');
	const digits = `${fraction}0000`.slice(0, 4);
	const tenths = Number(whole) * 1000 + Number(digits.slice(0, 3)) + (Number(digits[3]) >= 5 ? 1 : 0);
	return `${Math.floor(tenths / 10)}${tenths % 10 ? `.${tenths % 10}` : ''}%`;
}

const LEDE: Record<Status, string> = {
	no: 'Every time somebody asks whether Zack is a dad, a counter goes up. These are the counters. The answer, for the avoidance of doubt, is still no.',
	soon: 'Every time somebody asks whether Zack is a dad, a counter goes up. It is happening right now, which goes some way to explaining the graph.',
	yes: 'Every time somebody asked whether Zack was a dad, a counter went up. The answer is now yes. You can stop checking. You won’t, but you can.',
};

const EVERYWHERE: Record<Status, string> = {
	no: 'Zack is not a dad in any of them.',
	soon: 'In all of them, it is happening.',
	yes: 'Zack is a dad in every single one.',
};

function hourQuip(h: number): string {
	if (h < 5) return 'The 3am refresh is real, and it is you.';
	if (h < 9) return 'Before the kettle has even boiled.';
	if (h < 13) return 'Precisely when everyone should be working.';
	if (h < 17) return 'The post-lunch slump, spent productively.';
	if (h < 21) return 'On the way home. Not while driving, we hope.';
	return 'One last look before bed. And then another one.';
}

function statsPage(view: StatsView): Html {
	const { stats } = view;
	return html`<div class="wrap stack">
<header class="page-head">
<p class="kicker">Anxiety analytics</p>
<h1>How often do people check?</h1>
<p class="lede">${LEDE[view.status]}</p>
</header>
${stats ? headline(view, stats) : html`<div class="notice notice-error" role="alert"><p>The counters are temporarily unavailable. Rest assured people are still checking; we just can’t count them right now. Try again in a moment.</p></div>`}
${stats && stats.total > 0 ? html`${dailySection(stats, view.changeDays)}${hourlySection(stats)}
<div class="grid">${countriesSection(stats, view.status)}${colosSection(stats)}</div>` : stats ? html`<div class="empty"><p>Nobody has checked yet. Suspiciously calm.</p></div>` : ''}
${liveSection(view.room)}
${youSection(view.colo)}
${methodology(view.origin)}
</div>`;
}

function headline(view: StatsView, stats: CheckStats): Html {
	const perChange = view.answerChanges === 0 ? '∞' : fmt(Math.round(stats.total / view.answerChanges));
	return html`<section class="section" aria-label="Headline numbers">
<div class="stats">
<div class="stat"><span class="stat-value" data-live="checks">${fmt(stats.total)}</span> <span class="stat-label">checks, all time</span></div>
<div class="stat"><span class="stat-value">${fmt(stats.today)}</span> <span class="stat-label">${stats.today === 1 ? 'check' : 'checks'} today (London)</span></div>
<div class="stat"><span class="stat-value">${perChange}</span> <span class="stat-label">checks per change of answer</span></div>
<div class="stat"><span class="stat-value" data-live="viewers">${fmt(view.room.viewers)}</span> <span class="stat-label">watching right now</span></div>
</div>
</section>`;
}

interface Bar {
	value: number;
	/** Tooltip, e.g. "Fri 6 Nov: 12 checks". */
	label: string;
	emphasis?: boolean;
	marker?: boolean;
}

/**
 * A server-rendered SVG bar chart. Bars scale to the tallest; zero days get a
 * faint stub so the baseline reads as "nothing", not "missing". Axis labels sit
 * in an aligned CSS grid below (SVG text would stretch with the viewBox).
 */
function barChart(id: string, title: string, summary: string, bars: readonly Bar[], axis: ReadonlyMap<number, string>): Html {
	const max = Math.max(1, ...bars.map((b) => b.value));
	const width = bars.length * 10;
	const top = 4;
	const base = 100;
	const round = (n: number) => Math.round(n * 100) / 100;
	return html`<figure style="margin:0">
<svg viewBox="0 0 ${width} 106" preserveAspectRatio="none" role="img" aria-labelledby="${id}-title ${id}-desc" focusable="false" style="display:block;width:100%;height:10rem">
<title id="${id}-title">${title}</title>
<desc id="${id}-desc">${summary}</desc>
<line x1="0" y1="${base}" x2="${width}" y2="${base}" stroke="currentColor" stroke-opacity="0.35" vector-effect="non-scaling-stroke"></line>
${bars.map((bar, i) => {
	const h = bar.value > 0 ? Math.max(2, (bar.value / max) * (base - top)) : 0.8;
	const opacity = bar.emphasis ? 1 : bar.value > 0 ? 0.55 : 0.2;
	return html`<rect x="${i * 10 + 1.5}" y="${round(base - h)}" width="7" height="${round(h)}" fill="currentColor" fill-opacity="${opacity}"><title>${bar.label}</title></rect>${bar.marker ? html`<rect x="${i * 10 + 1.5}" y="102" width="7" height="3" fill="currentColor"></rect>` : ''}`;
})}
</svg>
<div aria-hidden="true" class="tiny muted" style="display:grid;grid-template-columns:repeat(${bars.length},minmax(0,1fr));margin-top:0.25rem">
${bars.map((_, i) => {
	const text = axis.get(i);
	const justify = i === 0 ? 'flex-start' : i === bars.length - 1 ? 'flex-end' : 'center';
	return html`<span style="display:flex;justify-content:${justify};white-space:nowrap">${text ?? ''}</span>`;
})}
</div>
</figure>`;
}

function dailySection(stats: CheckStats, changeDays: ReadonlySet<string>): Html {
	const today = stats.daily.at(-1)?.day ?? londonDate();
	const peak = stats.daily.reduce((best, d) => (d.count > best.count ? d : best), stats.daily[0] ?? { day: today, count: 0 });
	const bars: Bar[] = stats.daily.map((d) => ({
		value: d.count,
		label: `${formatWeekdayDayMonth(d.day)}: ${plural(d.count, 'check', 'checks')}`,
		emphasis: peak.count > 0 && d.day === peak.day,
		marker: d.day === today,
	}));
	const last = stats.daily.length - 1;
	const axis = new Map<number, string>();
	for (const i of [0, 7, 14, 21]) if (i < last) axis.set(i, formatDayMonth(stats.daily[i]?.day ?? today));
	axis.set(last, 'Today');
	const windowTotal = stats.daily.reduce((sum, d) => sum + d.count, 0);

	const peakNote =
		peak.day === today
			? 'That’s today. Steady on.'
			: changeDays.has(peak.day)
				? 'Something did actually happen that day, to be fair.'
				: 'Nothing happened that day either.';

	return html`<section class="section card stack" aria-labelledby="daily-heading">
<h2 class="card-title" id="daily-heading">Checks per day</h2>
<p class="muted">The last ${stats.daily.length} days in London: ${plural(windowTotal, 'check', 'checks')}.
${peak.count > 0 ? html`Busiest was <strong>${formatWeekdayDayMonth(peak.day)}</strong> with ${plural(peak.count, 'check', 'checks')}. ${peakNote}` : ''}</p>
${barChart(
	'daily-chart',
	`Checks per day for the last ${stats.daily.length} days`,
	windowTotal > 0
		? `Bar chart. ${windowTotal} checks in total; the busiest day was ${formatWeekdayDayMonth(peak.day)} with ${peak.count}. The marked bar is today.`
		: `Bar chart. No checks at all in the last ${stats.daily.length} days. The marked bar is today.`,
	bars,
	axis,
)}
<p class="tiny muted">The darkest bar is the busiest day. The little mark underneath is today.</p>
<details>
<summary>Show the numbers</summary>
<div class="table-wrap"><table class="table">
<thead><tr><th scope="col">Day</th><th scope="col">Checks</th></tr></thead>
<tbody>${[...stats.daily].reverse().map((d) => html`<tr><td>${formatLondonDate(d.day)}</td><td class="mono">${fmt(d.count)}</td></tr>`)}</tbody>
</table></div>
</details>
</section>`;
}

function hourlySection(stats: CheckStats): Html {
	const now = londonHour();
	let peak = 0;
	stats.hourly.forEach((count, h) => {
		if (count > (stats.hourly[peak] ?? 0)) peak = h;
	});
	const quiet = stats.hourly.reduce((best, count, h) => (count < (stats.hourly[best] ?? 0) ? h : best), 0);
	const neverChecked = stats.hourly.filter((count) => count === 0).length;
	const quietNote =
		neverChecked > 1
			? `${neverChecked} hours of the day have never seen a single check, which is the only sign of restraint in this entire dataset.`
			: `The quietest hour is ${hourLabel(quiet)}, when even the most invested get some sleep.`;
	const bars: Bar[] = stats.hourly.map((count, h) => ({
		value: count,
		label: `${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${plural(count, 'check', 'checks')}`,
		emphasis: h === peak,
		marker: h === now,
	}));
	const axis = new Map<number, string>([
		[0, '00:00'],
		[6, '06:00'],
		[12, '12:00'],
		[18, '18:00'],
		[23, '23:00'],
	]);

	return html`<section class="section card stack" aria-labelledby="hourly-heading">
<h2 class="card-title" id="hourly-heading">When the worry strikes</h2>
<p class="muted">All-time checks by hour of day, London time. Peak worry is <strong>${hourLabel(peak)}–${hourLabel((peak + 1) % 24)}</strong>. ${hourQuip(peak)}
${quietNote}</p>
${barChart('hourly-chart', 'Checks by hour of day (London time)', `Bar chart of 24 hours. The busiest hour is ${hourLabel(peak)} with ${stats.hourly[peak] ?? 0} checks. The marked bar is the current hour, ${hourLabel(now)}.`, bars, axis)}
<p class="tiny muted">The darkest bar is the busiest hour. The little mark is the current hour in London (${hourLabel(now)}).</p>
<details>
<summary>Show the numbers</summary>
<div class="table-wrap"><table class="table">
<thead><tr><th scope="col">Hour (London)</th><th scope="col">Checks</th></tr></thead>
<tbody>${stats.hourly.map((count, h) => html`<tr><td>${hourLabel(h)}–${hourLabel((h + 1) % 24)}</td><td class="mono">${fmt(count)}</td></tr>`)}</tbody>
</table></div>
</details>
</section>`;
}

function shareCell(count: number, total: number): Html {
	const share = total > 0 ? count / total : 0;
	const width = Math.max(0, Math.min(100, Math.round(share * 1000) / 10));
	return html`<td><div class="meter" aria-hidden="true"><span style="width:${width}%"></span></div><span class="tiny muted">${formatShare(share)}</span></td>`;
}

function countriesSection(stats: CheckStats, status: Status): Html {
	const leader = stats.countries[0];
	return html`<section class="section card stack" aria-labelledby="countries-heading">
<h2 class="card-title" id="countries-heading">Where the worry comes from</h2>
<p class="muted">${plural(stats.countryCount, 'country or territory', 'countries and territories')} so far. ${EVERYWHERE[status]}
${leader && leader.code !== 'XX' ? html`Most invested: ${flagEmoji(leader.code)} ${countryName(leader.code)}.` : ''}</p>
${tallyTable('Country', stats.countries, stats.total, (t) => html`<span aria-hidden="true">${flagEmoji(t.code)}</span> ${countryName(t.code)}`)}
</section>`;
}

function colosSection(stats: CheckStats): Html {
	return html`<section class="section card stack" aria-labelledby="colos-heading">
<h2 class="card-title" id="colos-heading">Datacentres doing the heavy lifting</h2>
<p class="muted">${plural(stats.coloCount, 'Cloudflare datacentre has', 'Cloudflare datacentres have')} answered the question so far. Each one gave the same answer, which is reassuring.</p>
${tallyTable('Datacentre', stats.colos, stats.total, (t) => {
	const info = coloInfo(t.code);
	return info.city
		? html`<span class="mono">${info.code}</span> <span aria-hidden="true">${flagEmoji(info.country ?? 'XX')}</span> ${info.city}`
		: html`<span class="mono">${info.code}</span> <span class="muted">${info.code === 'XXX' ? 'unknown' : 'somewhere with a runway'}</span>`;
})}
</section>`;
}

function tallyTable(heading: string, rows: readonly Tally[], total: number, label: (t: Tally) => Html): Html {
	if (rows.length === 0) return html`<div class="empty"><p>No data yet.</p></div>`;
	return html`<div class="table-wrap"><table class="table">
<thead><tr><th scope="col">${heading}</th><th scope="col">Checks</th><th scope="col">Share</th></tr></thead>
<tbody>${rows.map((t) => html`<tr><td>${label(t)}</td><td class="mono">${fmt(t.count)}</td>${shareCell(t.count, total)}</tr>`)}</tbody>
</table></div>`;
}

function liveSection(room: RoomInfo): Html {
	if (!room.available) {
		return html`<section class="section card stack" aria-labelledby="live-heading">
<h2 class="card-title" id="live-heading">Right now</h2>
<p>The waiting room isn’t answering the door, so we can’t say who’s in it. They’re probably fine.</p>
</section>`;
	}
	const sent = room.vibesByEmoji.filter((v) => v.count > 0);
	return html`<section class="section card stack" aria-labelledby="live-heading">
<h2 class="card-title" id="live-heading">Right now</h2>
<p><strong data-live="viewers">${fmt(room.viewers)}</strong> ${room.viewers === 1 ? 'person has' : 'people have'} this site open, waiting to be told the moment anything changes.
Between everyone, <strong data-live="vibes">${fmt(room.vibes)}</strong> ${room.vibes === 1 ? 'vibe has' : 'vibes have'} been sent in Zack’s general direction.</p>
${sent.length > 0 ? html`<ul class="cluster" aria-label="Vibes by emoji" style="list-style:none;padding:0;margin:0">${sent.map((v) => html`<li class="pill">${v.emoji} <span class="mono">${fmt(v.count)}</span></li>`)}</ul>` : html`<div class="empty"><p>No vibes yet. They’re free, and Zack could use them.</p></div>`}
<p class="tiny muted">As of when this page loaded. ${room.sockets} on WebSockets, ${room.streams} on Server-Sent Events.</p>
</section>`;
}

function youSection(colo: string | null): Html {
	const info = coloInfo(colo);
	const now = new Date();
	const where = info.city
		? html`<strong><span class="mono">${info.code}</span> (${info.city})</strong>`
		: html`<strong>${info.code === 'XXX' ? 'an undisclosed datacentre' : html`<span class="mono">${info.code}</span>`}</strong>`;
	return html`<section class="section card stack" aria-labelledby="you-heading">
<h2 class="card-title" id="you-heading">Meanwhile, at your end</h2>
<p>You were served by ${where}. Your request went there, asked a database whether Zack is a dad, and came back with the answer faster than you could have asked out loud.</p>
<p>It is <time datetime="${now.toISOString()}"><strong>${londonClock(now)}</strong> on ${formatLondonDate(londonDate(now))}</time> in London, the only time zone this site recognises.</p>
</section>`;
}

function methodology(origin: string): Html {
	return html`<section class="section stack" aria-labelledby="method-heading">
<h2 id="method-heading">Methodology, such as it is</h2>
<p class="muted">When someone checks the homepage or the status API, four counters go up: the day, the hour, the country and the Cloudflare datacentre. That’s all. There are no cookies, no per-visitor records and no IP addresses. Bots, crawlers, link previews, uptime monitors and prefetches are ignored, on the grounds that they don’t have feelings. Days and hours are London time.</p>
<p class="muted">For the terminally curious: <code>curl -N ${origin}/api/stream</code> streams every change live, and <a href="/api/live"><code>/api/live</code></a> has the numbers as JSON.</p>
</section>`;
}
