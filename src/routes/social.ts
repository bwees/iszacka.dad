// OWNER: social agent.
// GET /api/countries (checks per country, for the live map), plus the home page's live and
// social panels: DADCON, the global anxiety meter, the live world map and the check feed.
// public/social.js brings the panels to life; without JavaScript they still say something.

import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { LinearRouter } from 'hono/router/linear-router';
import { countryName } from '../lib/counters-geo';
import { DADCON_LEVELS, type DadconInfo, dadcon } from '../lib/dadcon';
import { type Html, fragmentCache } from '../lib/layout';
import { allow, clientKey } from '../lib/security';
import { ANXIETY_LEVELS, gaugeAngle } from '../lib/social';
import { formatNumber, londonDate } from '../lib/time';
import type { AnxietyLevel, AnxietyReading, AppEnv, SiteState } from '../types';

export const socialRoutes = new Hono<AppEnv>({ router: new LinearRouter() });

// ─── GET /api/countries ──────────────────────────────────────────────────────

/** How long one answer is reused, per isolate and in the edge cache. The map is not a ledger. */
export const COUNTRIES_CACHE_SECONDS = 60;
/** More rows than there are countries, so nothing real is ever cut off. */
const COUNTRIES_LIMIT = 300;

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Expose-Headers': 'X-Is-Zack-A-Dad, Retry-After',
} as const;

export interface CountriesBody {
	countries: Array<{ country: string; name: string; n: number }>;
	total: number;
	updatedAt: string;
	note: string;
}

/** The /api/countries body from checks_country rows (busiest first). */
export function countriesBody(rows: ReadonlyArray<{ country: unknown; count: unknown }>, now: Date = new Date()): CountriesBody {
	const countries = rows
		.map((r) => ({ country: String(r.country ?? 'XX').toUpperCase(), n: Math.max(0, Math.floor(Number(r.count) || 0)) }))
		.filter((r) => r.n > 0 && /^(?:[A-Z]{2}|T1)$/.test(r.country))
		.sort((a, b) => b.n - a.n || (a.country < b.country ? -1 : a.country > b.country ? 1 : 0))
		.map((r) => ({ country: r.country, name: countryName(r.country), n: r.n }));
	return {
		countries,
		total: countries.reduce((sum, c) => sum + c.n, 0),
		updatedAt: now.toISOString(),
		note: `All-time checks per country (country only, nothing per person), refreshed about once a minute. XX is parts unknown and T1 is Tor. The last few seconds of checks may not be in yet.`,
	};
}

/** When a copy in the edge cache was read from D1 (epoch ms). Only ever on the cached copy. */
const READ_AT_HEADER = 'X-Countries-Read-At';
let countriesMemo: { at: number; json: string } | null = null;

function edgeCache(): Cache | null {
	try {
		return typeof caches === 'undefined' ? null : caches.default;
	} catch {
		return null;
	}
}

function countriesResponse(json: string): Response {
	return new Response(json, {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': `public, max-age=${COUNTRIES_CACHE_SECONDS}`,
			...CORS,
		},
	});
}

socialRoutes.options('/api/countries', () =>
	new Response(null, {
		status: 204,
		headers: {
			...CORS,
			'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
			'Access-Control-Allow-Headers': 'Accept',
			'Access-Control-Max-Age': '86400',
			Allow: 'GET, HEAD, OPTIONS',
			'Cache-Control': 'public, max-age=86400',
		},
	}),
);

socialRoutes.get('/api/countries', async (c) => {
	if (!(await allow(c.env.RL_API, `countries:${clientKey(c)}`))) {
		return c.json({ error: 'rate_limited', message: 'Too many requests. The map changes about once a minute; so can you.' }, 429, {
			...CORS,
			'Cache-Control': 'no-store',
			'Retry-After': '60',
		});
	}
	const maxAgeMs = COUNTRIES_CACHE_SECONDS * 1000;
	const memo = countriesMemo;
	if (memo && Date.now() - memo.at < maxAgeMs) return countriesResponse(memo.json);

	// Most requests land in a fresh isolate, so the edge cache (per datacentre) does the real work.
	// The copy says when it was read, and is only trusted for a minute from then: not every cache
	// (wrangler dev's, for one) expires entries by max-age.
	const cache = edgeCache();
	const key = `${new URL(c.req.url).origin}/__cache/countries/v1`;
	if (cache) {
		const hit = await cache.match(key).catch(() => undefined);
		const readAt = Number(hit?.headers.get(READ_AT_HEADER));
		if (hit && Number.isFinite(readAt) && Date.now() - readAt < maxAgeMs && Date.now() >= readAt) {
			const json = await hit.text();
			countriesMemo = { at: readAt, json };
			return countriesResponse(json);
		}
	}

	let json: string;
	try {
		const { results } = await c.env.DB.prepare('SELECT country, count FROM checks_country ORDER BY count DESC, country ASC LIMIT ?')
			.bind(COUNTRIES_LIMIT)
			.all<{ country: string; count: number }>();
		json = `${JSON.stringify(countriesBody(results ?? []))}\n`;
	} catch (err) {
		console.error('countries: D1 read failed:', err);
		if (memo) return countriesResponse(memo.json);
		return c.json({ error: 'unavailable', message: 'The map room is having a little lie-down. Try again in a minute.' }, 503, {
			...CORS,
			'Cache-Control': 'no-store',
			'Retry-After': '60',
		});
	}
	const readAt = Date.now();
	countriesMemo = { at: readAt, json };
	if (cache) {
		const copy = countriesResponse(json);
		copy.headers.set(READ_AT_HEADER, String(readAt));
		c.executionCtx.waitUntil(cache.put(key, copy).catch(() => {}));
	}
	return countriesResponse(json);
});

// ─── Home panels ─────────────────────────────────────────────────────────────

/** Same markup as the other mission-control panels (see pages.ts). */
function panel(id: string, channel: string, label: string, span: string, body: Html): Html {
	return html`<section class="panel ${span}" aria-labelledby="panel-${id}">
	<header class="panel-head">
		<h3 class="panel-label" id="panel-${id}"><span class="panel-ch">CH-${channel}</span> ${label}</h3>
		<span class="led" aria-hidden="true"></span>
	</header>
	<div class="panel-body stack">${body}</div>
</section>`;
}

/** "DADCON 3 · ROUND HOUSE", or "DADCON 0: DAD" once it's over. */
export function dadconHeadline(info: DadconInfo): string {
	return info.level === 0 ? 'DADCON 0: DAD' : `DADCON ${info.level} · ${info.name}`;
}

function dadconPanel(info: DadconInfo): Html {
	return html`<div class="dadcon" data-dadcon data-level="${info.level}">
		<p class="dadcon-readout" data-dadcon-readout>${dadconHeadline(info)}</p>
		<ol class="dadcon-scale" aria-label="Paternity readiness conditions, 5 (calm) to 0 (dad)">
			${DADCON_LEVELS.map(
				(l) => html`<li class="dc dc-${l.level}${l.level === info.level ? ' is-active' : ''}" data-dc="${l.level}" data-name="${l.name}" data-desc="${l.description}" data-headline="${dadconHeadline(l)}"${l.level === info.level ? raw(' aria-current="step"') : ''}>
					<span class="dc-n">${l.level}</span><span class="dc-name">${l.name}</span>
				</li>`,
			)}
		</ol>
		<p class="dadcon-desc" data-dadcon-desc>${info.description}</p>
	</div>
	<p class="tiny muted">Set by the due date and the answer, in London time. Not affiliated with any actual defence posture.</p>`;
}

const ANXIETY_COPY: Record<AnxietyLevel, { label: string; description: string }> = {
	calm: { label: 'CALM', description: 'Nobody is refreshing. Suspiciously calm.' },
	elevated: { label: 'ELEVATED', description: 'Someone is refreshing more than is strictly healthy.' },
	frantic: { label: 'FRANTIC', description: 'A group chat has clearly been activated.' },
	meltdown: { label: 'MELTDOWN', description: 'Everyone is refreshing. Nobody is helping.' },
};

/** An arc of the gauge, from `from` to `to` degrees (180 is the left end, 0 the right). */
function arc(from: number, to: number): string {
	const r = 80;
	const point = (deg: number) => {
		const rad = (deg * Math.PI) / 180;
		return `${(100 + r * Math.cos(rad)).toFixed(2)} ${(100 - r * Math.sin(rad)).toFixed(2)}`;
	};
	return `M${point(from)}A${r} ${r} 0 0 1 ${point(to)}`;
}

function gaugeSvg(): Html {
	return html`<svg class="gauge" viewBox="0 0 200 112" aria-hidden="true" focusable="false">
		${ANXIETY_LEVELS.map((level, i) => html`<path class="g-arc g-${level}" d="${arc(180 - i * 45 - 1, 180 - (i + 1) * 45 + 1)}"/>`)}
		<g class="gauge-ticks">${ANXIETY_LEVELS.slice(1).map((_, i) => {
			const rad = ((135 - i * 45) * Math.PI) / 180;
			const p = (r: number) => `${(100 + r * Math.cos(rad)).toFixed(2)} ${(100 - r * Math.sin(rad)).toFixed(2)}`;
			return html`<path d="M${p(66)}L${p(94)}"/>`;
		})}</g>
		<g class="gauge-needle"><g class="gauge-wobble"><path d="M97 100L100 28l3 72z"/></g><circle cx="100" cy="100" r="7"/></g>
	</svg>`;
}

function anxietyPanel(reading: AnxietyReading): Html {
	const copy = ANXIETY_COPY[reading.level];
	const descriptions = Object.fromEntries(ANXIETY_LEVELS.map((l) => [l, ANXIETY_COPY[l]]));
	return html`<div class="anxiety" data-anxiety data-level="${reading.level}" data-anxiety-copy="${JSON.stringify(descriptions)}" style="--angle:${gaugeAngle(reading)}deg">
		${gaugeCache('', gaugeSvg)}
		<p class="anxiety-label" data-anxiety-label>${copy.label}</p>
		<p class="anxiety-rate mono tiny"><span data-anxiety-rate>${formatRate(reading.perMinute)}</span> checks a minute, averaged over five minutes</p>
		<p class="anxiety-desc" data-anxiety-desc>${copy.description}</p>
	</div>`;
}

/** "0", "0.4", "12" (one decimal place at most, en-GB grouping). */
export function formatRate(perMinute: number): string {
	if (!Number.isFinite(perMinute) || perMinute <= 0) return '0';
	const tenths = Math.round(perMinute * 10);
	const whole = Math.floor(tenths / 10);
	const decimal = tenths % 10;
	return decimal ? `${formatNumber(whole)}.${decimal}` : formatNumber(whole);
}

function mapPanel(): Html {
	return html`<div class="wm" data-world-map data-src="/world-map.svg">
		<div class="wm-stage" data-wm-stage>
			<p class="wm-fallback">The live map needs JavaScript. The busiest countries are on <a href="/stats">Anxiety analytics</a>, and the raw numbers live at <a href="/api/countries">/api/countries</a>.</p>
		</div>
		<div class="wm-vibes" data-wm-vibes aria-hidden="true"></div>
	</div>
	<p class="tiny muted">Countries flash as people in them check, and vibes take off from wherever they were sent. Darker means more checks, all time. Map: <a href="/world-map.LICENSE.txt">Natural Earth</a>, public domain.</p>`;
}

function feedPanel(): Html {
	return html`<ol class="checkfeed" data-checkfeed aria-label="Recent checks, newest first">
		<li class="checkfeed-idle" data-checkfeed-idle>The live feed needs JavaScript and a live connection. People are checking regardless.</li>
	</ol>
	<p class="tiny muted">Countries only. Nobody is identified, least of all you.</p>`;
}

const dadconCache = fragmentCache(8);
const anxietyCache = fragmentCache(64);
const gaugeCache = fragmentCache(1);
const mapCache = fragmentCache(1);
const feedCache = fragmentCache(1);

const CALM: AnxietyReading = { level: 'calm', perMinute: 0 };

/**
 * The home page's social panels (CH-12 to CH-15), for the mission-control grid. Pure and
 * cheap: DADCON is arithmetic on the due date, the meter comes from the live snapshot the
 * page already fetched, and every fragment is rendered once per isolate per variant.
 */
export function socialHomePanels(state: SiteState, opts: { today?: string; anxiety?: AnxietyReading } = {}): Html {
	const info = dadcon(state, opts.today ?? londonDate());
	const reading = opts.anxiety && ANXIETY_COPY[opts.anxiety.level] ? opts.anxiety : CALM;
	return html`${panel('dadcon', '12', 'DADCON', 'span-7', dadconCache(String(info.level), () => dadconPanel(info)))}
${panel('anxiety', '13', 'Global anxiety', 'span-5 social-md-wide', anxietyCache(`${reading.level}|${reading.perMinute}`, () => anxietyPanel(reading)))}
${panel('world', '14', 'Live map', 'span-8', mapCache('', mapPanel))}
${panel('checkfeed', '15', 'Who just checked', 'span-4 social-md-wide', feedCache('', feedPanel))}`;
}

/** Extra <head> for pages that show the panels. */
export const SOCIAL_HEAD = raw('<link rel="stylesheet" href="/social.css">');
export const SOCIAL_SCRIPT = '/social.js';
