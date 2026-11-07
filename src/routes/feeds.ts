// OWNER: feeds agent.
// RSS / Atom / JSON Feed / iCal / badge / embed / llms.txt / humans.txt / security.txt / robots / sitemap.
// Renderers live in lib/feeds*.ts; this file loads data and handles caching (ETag + 304).

import type { Context } from 'hono';
import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { LinearRouter } from 'hono/router/linear-router';
import { getCheckTotal } from '../lib/counters';
import {
	FEED_CACHE_CONTROL,
	FEED_CONTENT_TYPES,
	FEED_ITEM_LIMIT,
	etagFor,
	etagMatches,
	feedUpdatedAt,
	renderAtom,
	renderIcal,
	renderJsonFeed,
	renderRss,
} from '../lib/feeds';
import { BADGE_COLOURS, badgeMessage, isBadgeStyle, renderBadge, sanitiseBadgeLabel } from '../lib/feeds-badge';
import {
	TEXT_CONTENT_TYPE,
	XML_CONTENT_TYPE,
	renderHumansTxt,
	renderLlmsTxt,
	renderRobotsTxt,
	renderSecurityTxt,
	renderSitemap,
} from '../lib/feeds-text';
import { STATUS_COPY, SITE_NAME, siteUrl } from '../lib/site';
import { daysBetween, formatLondonDate, londonDate } from '../lib/time';
import { listUpdates } from '../lib/updates';
import type { AppEnv, SiteState, Update } from '../types';

export const feedRoutes = new Hono<AppEnv>({ router: new LinearRouter() });

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Send a cacheable body with a strong ETag, answering If-None-Match with 304.
 * Feeds, badges and text files are public data, so CORS is open too.
 */
async function cached(
	c: Context<AppEnv>,
	body: string,
	contentType: string,
	opts: { cache?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
	const etag = await etagFor(body);
	const headers: Record<string, string> = {
		'Cache-Control': opts.cache ?? FEED_CACHE_CONTROL,
		ETag: etag,
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Expose-Headers': 'ETag',
		...opts.headers,
	};
	if (etagMatches(c.req.header('if-none-match'), etag)) return new Response(null, { status: 304, headers });
	return new Response(body, { status: 200, headers: { 'Content-Type': contentType, ...headers } });
}

/**
 * Answers to CORS preflights for the cached() paths: If-None-Match isn't a CORS-safelisted
 * header, so a browser fetch that sends it (as the docs suggest) asks first. Public reads only;
 * nothing here writes, so no rate limit.
 */
export const FEED_PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'If-None-Match, Accept',
	'Access-Control-Max-Age': '86400',
	Allow: 'GET, HEAD, OPTIONS',
	'Cache-Control': 'public, max-age=86400',
};

const preflight = (c: Context<AppEnv>) => c.body(null, 204, { ...FEED_PREFLIGHT_HEADERS });

for (const path of [
	'/calendar.ics',
	'/badge.svg',
	'/llms.txt',
	'/humans.txt',
	'/robots.txt',
	'/sitemap.xml',
	'/.well-known/security.txt',
]) {
	feedRoutes.options(path, preflight);
}

function unavailable(what: string): Response {
	return new Response(`The ${what} is having a little lie-down. Please try again in a minute.\n`, {
		status: 503,
		headers: { 'Content-Type': TEXT_CONTENT_TYPE, 'Retry-After': '60', 'Cache-Control': 'no-store' },
	});
}

async function latestUpdates(c: Context<AppEnv>, limit: number): Promise<Update[] | null> {
	try {
		return await listUpdates(c.env, { limit });
	} catch (err) {
		console.error('feeds: listUpdates failed:', err);
		return null;
	}
}

// ─── Feeds ───────────────────────────────────────────────────────────────────

type FeedRenderer = (input: { siteUrl: string; state: SiteState; updates: Update[]; selfPath: string }) => string;

function feed(path: string, render: FeedRenderer, contentType: string, what: string) {
	feedRoutes.options(path, preflight);
	feedRoutes.get(path, async (c) => {
		const updates = await latestUpdates(c, FEED_ITEM_LIMIT);
		if (!updates) return unavailable(what);
		return cached(c, render({ siteUrl: siteUrl(c.env), state: c.get('state'), updates, selfPath: path }), contentType);
	});
}

feed('/feed.xml', renderRss, FEED_CONTENT_TYPES.rss, 'RSS feed');
feed('/rss.xml', renderRss, FEED_CONTENT_TYPES.rss, 'RSS feed');
feed('/atom.xml', renderAtom, FEED_CONTENT_TYPES.atom, 'Atom feed');
feed('/feed.json', renderJsonFeed, FEED_CONTENT_TYPES.json, 'JSON feed');

feedRoutes.get('/calendar.ics', async (c) => {
	const state = c.get('state');
	let dueDateModifiedAt: string | null = null;
	if (state.dueDate) {
		try {
			const row = await c.env.DB.prepare("SELECT updated_at FROM settings WHERE key = 'due_date'").first<{ updated_at: string }>();
			dueDateModifiedAt = row?.updated_at ?? null;
		} catch (err) {
			console.error('feeds: due date timestamp lookup failed:', err);
		}
	}
	// DTSTAMP is the last time the calendar's data changed, so the body (and ETag) is stable between changes.
	const stampedAt = [state.statusChangedAt, dueDateModifiedAt]
		.filter((v): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)))
		.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a), state.statusChangedAt);
	const body = renderIcal({ siteUrl: siteUrl(c.env), state, stampedAt, dueDateModifiedAt });
	return cached(c, body, FEED_CONTENT_TYPES.ical, { headers: { 'Content-Disposition': 'inline; filename="is-zack-a-dad.ics"' } });
});

// ─── Badge ───────────────────────────────────────────────────────────────────

feedRoutes.get('/badge.svg', (c) => {
	const status = c.get('state').status;
	const styleParam = c.req.query('style');
	const svg = renderBadge({
		label: sanitiseBadgeLabel(c.req.query('label')),
		message: badgeMessage(status),
		colour: BADGE_COLOURS[status],
		style: isBadgeStyle(styleParam) ? styleParam : 'flat',
	});
	return cached(c, svg, 'image/svg+xml; charset=utf-8', {
		// An SVG opened directly is a document; make sure it can never run anything.
		headers: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors *" },
	});
});

// ─── Embed (iframe widget) ───────────────────────────────────────────────────

const EMBED_THEMES = ['auto', 'light', 'dark'] as const;
type EmbedTheme = (typeof EMBED_THEMES)[number];

/** The small grey line under the answer. Mirrored in public/embed.js. */
export function embedMetaLine(state: SiteState, today: string): string {
	if (state.status === 'yes') return `Since ${formatLondonDate(state.statusChangedAt)}`;
	if (state.status === 'soon') return 'Labour in progress';
	if (!state.dueDate) return 'Due date not announced';
	const days = daysBetween(today, state.dueDate);
	if (days > 1) return `Due in ${days} days`;
	if (days === 1) return 'Due tomorrow';
	if (days === 0) return 'Due today';
	return days === -1 ? '1 day overdue' : `${-days} days overdue`;
}

const EMBED_CSP = [
	"default-src 'none'",
	"script-src 'self'",
	"connect-src 'self'",
	"style-src 'unsafe-inline'",
	"img-src 'self' data:",
	"base-uri 'none'",
	"form-action 'none'",
	'frame-ancestors *',
].join('; ');

const EMBED_STYLES = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1b;--muted:#595959;--no:#c62828;--soon:#b45309;--yes:#2e7d32;--ring:#1b1b1b}
@media (prefers-color-scheme:dark){:root[data-theme=auto]{--bg:#151515;--fg:#f3f3f3;--muted:#b8b8b8;--no:#ff7b72;--soon:#f6c453;--yes:#7ee2a8;--ring:#f3f3f3}}
:root[data-theme=dark]{color-scheme:dark;--bg:#151515;--fg:#f3f3f3;--muted:#b8b8b8;--no:#ff7b72;--soon:#f6c453;--yes:#7ee2a8;--ring:#f3f3f3}
:root[data-theme=light]{color-scheme:light}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:4px}
.widget{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;color:inherit;text-decoration:none;border-radius:12px;padding:6px 12px;max-width:100%}
.widget:focus-visible{outline:3px solid var(--ring);outline-offset:2px}
.widget:hover .sentence{text-decoration:underline}
.kicker{font-size:.72rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.answer{font-size:clamp(1.75rem,min(16vw,26vh),4.5rem);line-height:1;font-weight:900;letter-spacing:-.02em;color:var(--no)}
[data-status=soon] .answer{color:var(--soon)}
[data-status=yes] .answer{color:var(--yes)}
.sentence{font-size:clamp(.85rem,4.5vw,1.05rem);max-width:32ch}
.meta{font-size:.8rem;color:var(--muted)}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (prefers-reduced-motion:no-preference){.answer{transition:color .4s ease}}
`;

feedRoutes.get('/embed', (c) => {
	const state = c.get('state');
	const copy = STATUS_COPY[state.status];
	const themeParam = c.req.query('theme');
	const theme: EmbedTheme = (EMBED_THEMES as readonly string[]).includes(themeParam ?? '') ? (themeParam as EmbedTheme) : 'auto';
	const base = siteUrl(c.env);

	const page = html`<!doctype html>
<html lang="en-GB" data-status="${state.status}" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${SITE_NAME} ${copy.short}</title>
<link rel="canonical" href="${base}/">
<noscript><meta http-equiv="refresh" content="60"></noscript>
<style>${raw(EMBED_STYLES)}</style>
<script src="/embed.js" data-mode="page" defer></script>
</head>
<body>
<main>
<a class="widget" href="${base}/" target="_blank" rel="noopener" data-embed-root>
<span class="kicker">Is Zack a dad?</span>
<strong class="answer" data-field="answer">${copy.word}</strong>
<span class="sentence" data-field="sentence">${copy.sentence}</span>
<span class="meta" data-field="meta">${embedMetaLine(state, londonDate())}</span>
</a>
</main>
<div class="sr-only" role="status" aria-live="polite" data-field="live"></div>
</body>
</html>`;

	return c.html(page, 200, {
		'Content-Security-Policy': EMBED_CSP,
		'Cache-Control': 'public, max-age=30',
	});
});

// ─── Text files ──────────────────────────────────────────────────────────────

feedRoutes.get('/llms.txt', (c) =>
	cached(c, renderLlmsTxt({ siteUrl: siteUrl(c.env), state: c.get('state'), today: londonDate() }), TEXT_CONTENT_TYPE),
);

feedRoutes.get('/humans.txt', async (c) => {
	const state = c.get('state');
	const [checks, updates] = await Promise.all([getCheckTotal(c.env).catch(() => 0), latestUpdates(c, 1)]);
	const lastUpdated = feedUpdatedAt(state, updates ?? []);
	return cached(c, renderHumansTxt({ state, lastUpdated, checks }), TEXT_CONTENT_TYPE, { cache: 'public, max-age=300' });
});

feedRoutes.get('/robots.txt', (c) =>
	cached(c, renderRobotsTxt({ siteUrl: siteUrl(c.env), indexable: c.env.ENVIRONMENT === 'production' }), TEXT_CONTENT_TYPE, {
		cache: 'public, max-age=3600',
	}),
);

feedRoutes.get('/sitemap.xml', async (c) => {
	const updates = await latestUpdates(c, 200);
	if (!updates) return unavailable('sitemap');
	return cached(c, renderSitemap({ siteUrl: siteUrl(c.env), state: c.get('state'), updates }), XML_CONTENT_TYPE, {
		cache: 'public, max-age=600',
	});
});

feedRoutes.get('/.well-known/security.txt', (c) =>
	cached(c, renderSecurityTxt({ siteUrl: siteUrl(c.env), now: new Date() }), TEXT_CONTENT_TYPE, { cache: 'public, max-age=3600' }),
);
