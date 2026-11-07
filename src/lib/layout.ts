// OWNER: frontend agent. Shared HTML shell for every page.
//
// CONTRACT (must stay stable; other modules call it):
//   renderPage(c, opts) → Promise<Response>
//   renderPageHtml(c, opts) → Promise<string> (the same markup, for pages that cache it)
// The shell provides <head> (meta, OG tags, favicon, manifest, styles), the site
// header/nav, <main> with `opts.body`, the footer, and loads /app.js on every page.
// Pages pass data to client JS via data-* attributes; inline <script> is blocked by CSP.

import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import { HtmlEscapedCallbackPhase, resolveCallback, type HtmlEscapedString } from 'hono/utils/html';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv, SiteState, Status } from '../types';
import { STATUSES } from '../types';
import { SITE_NAME, STATUS_COPY, siteUrl } from './site';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/**
 * A per-isolate cache for pure HTML fragments: `cache(key, render)` renders once per key and
 * then hands back the same markup. The key must capture everything the fragment depends on
 * (typically the status, the due date and the London date). Bounded: it empties rather than
 * grows, so request-derived keys can't fill memory. Fragments must render synchronously.
 */
export function fragmentCache(max = 32): (key: string, render: () => Html) => HtmlEscapedString {
	const entries = new Map<string, string>();
	return (key, render) => {
		let markup = entries.get(key);
		if (markup === undefined) {
			const rendered = render();
			if (rendered instanceof Promise) throw new Error('fragmentCache: fragments must render synchronously');
			markup = rendered.toString();
			if (entries.size >= max) entries.clear();
			entries.set(key, markup);
		}
		return raw(markup);
	};
}

export interface PageOptions {
	/** Page title. The shell appends " · Is Zack a Dad?" (except on the homepage). */
	title: string;
	description?: string;
	body: Html;
	/** Canonical path, e.g. '/pool'. Defaults to the request path. */
	path?: string;
	/** Extra tags for <head>. */
	head?: Html;
	/** Extra module scripts to load (same-origin paths, e.g. '/push.js'). */
	scripts?: string[];
	/** Load the Turnstile script (set when the page renders turnstileWidget()). */
	turnstile?: boolean;
	noindex?: boolean;
	/** HTTP status code (default 200). */
	status?: number;
	/** Extra class on <body>. */
	bodyClass?: string;
	/** Hide the site header/footer (embeds, printables, OG cards). */
	bare?: boolean;
}

interface NavLink {
	href: string;
	label: string;
}

/** Header navigation. */
export const NAV_LINKS: readonly NavLink[] = [
	{ href: '/', label: 'Home' },
	{ href: '/updates', label: 'Updates' },
	{ href: '/pool', label: 'Pool' },
	{ href: '/status', label: 'Status' },
	{ href: '/stats', label: 'Stats' },
	{ href: '/everything', label: 'Get notified' },
];

/** Footer directory: every public page in the URL map. */
export const FOOTER_SECTIONS: ReadonlyArray<{ title: string; links: readonly NavLink[] }> = [
	{
		title: 'The answer',
		links: [
			{ href: '/', label: 'The answer itself' },
			{ href: '/updates', label: 'Updates' },
			{ href: '/status', label: 'Status page' },
			{ href: '/stats', label: 'Anxiety analytics' },
			{ href: '/ledger', label: 'The Dad Ledger' },
		],
	},
	{
		title: 'Join in',
		links: [
			{ href: '/pool', label: 'Baby pool' },
			{ href: '/ready', label: 'Dad readiness' },
			{ href: '/wall', label: 'Congratulations wall' },
			{ href: '/names', label: 'Name suggestion box' },
			{ href: '/achievements', label: 'Achievements' },
		],
	},
	{
		title: 'Get notified',
		links: [
			{ href: '/everything', label: 'Every possible way' },
			{ href: '/feed.xml', label: 'RSS' },
			{ href: '/atom.xml', label: 'Atom' },
			{ href: '/feed.json', label: 'JSON Feed' },
			{ href: '/calendar.ics', label: 'Calendar (iCal)' },
		],
	},
	{
		title: 'For machines',
		links: [
			{ href: '/api', label: 'API' },
			{ href: '/openapi.json', label: 'OpenAPI' },
			{ href: '/llms.txt', label: 'llms.txt' },
			{ href: '/humans.txt', label: 'humans.txt' },
			{ href: '/.well-known/security.txt', label: 'security.txt' },
		],
	},
	{
		title: 'For the fridge',
		links: [
			{ href: '/certificate', label: 'Certificate' },
			{ href: '/poster', label: 'Fridge poster' },
		],
	},
	{
		title: 'The small print',
		links: [
			{ href: '/press', label: 'Press kit' },
			{ href: '/privacy', label: 'Privacy policy' },
			{ href: '/terms', label: 'Terms of service' },
			{ href: '/stork', label: 'Catch the Stork (a game)' },
		],
	},
];

/** Used when a page renders before (or without) the root middleware loading state, e.g. on a D1 outage. */
const FALLBACK_STATE: SiteState = { status: 'no', statusChangedAt: new Date(0).toISOString(), dueDate: null };

/** The current state, tolerating it being missing (error pages rendered before the middleware ran). */
export function pageState(c: Context<AppEnv>): SiteState {
	try {
		return c.get('state') ?? FALLBACK_STATE;
	} catch {
		return FALLBACK_STATE;
	}
}

/** Short build identifier from the version metadata binding, or null in environments without it. */
export function buildId(env: Partial<Env> | undefined): { id: string; tag: string | null; timestamp: string | null } | null {
	try {
		const meta = env?.CF_VERSION;
		if (!meta || typeof meta !== 'object') return null;
		const id = typeof meta.id === 'string' ? meta.id.slice(0, 8) : '';
		const tag = typeof meta.tag === 'string' && meta.tag.trim() ? meta.tag.trim().slice(0, 40) : null;
		const timestamp = typeof meta.timestamp === 'string' && meta.timestamp ? meta.timestamp : null;
		if (!id && !tag) return null;
		return { id: id || 'unknown', tag, timestamp };
	} catch {
		return null;
	}
}

let clientCopy: string | undefined;

/** Static per-status copy for /app.js (it has no other way to know the words). */
function clientCopyJson(): string {
	clientCopy ??= buildClientCopyJson();
	return clientCopy;
}

function buildClientCopyJson(): string {
	const copy = Object.fromEntries(
		STATUSES.map((s: Status) => {
			const { word, short, headline, sentence, emoji, header } = STATUS_COPY[s];
			return [s, { word, short, headline, sentence, emoji, header }];
		}),
	);
	// The values are constants, but escape `<` anyway so nothing can ever close the script element.
	return JSON.stringify({ siteName: SITE_NAME, copy }).replace(/</g, '\\u003c');
}

/**
 * The social preview image URL, versioned by the status and when it last changed.
 * Facebook, WhatsApp, X, Slack and friends cache og:image by URL and ignore max-age,
 * so an unversioned /og.png would keep showing the old answer after the flip. /og.png
 * serves the pre-rendered card for the status in `v` (lib/og.ts ogVersionStatus reads
 * this exact format back), so a changed format must change both. The cards never change
 * by day, so there is no daily component.
 */
export function ogImageUrl(base: string, state: Pick<SiteState, 'status' | 'statusChangedAt'>): string {
	const changed = Date.parse(state.statusChangedAt);
	return `${base}/og.png?v=${state.status}-${Number.isNaN(changed) ? 0 : changed}`;
}

function isCurrent(linkHref: string, path: string): boolean {
	if (linkHref === '/') return path === '/';
	return path === linkHref || path.startsWith(`${linkHref}/`);
}

function safeSameOriginScript(src: string): boolean {
	return src.startsWith('/') && !src.startsWith('//');
}

export async function renderPage(c: Context<AppEnv>, opts: PageOptions): Promise<Response> {
	return c.html(pageMarkup(c, opts), (opts.status ?? 200) as ContentfulStatusCode);
}

/**
 * The markup renderPage sends, as a string, for a page that keeps a copy (the home page's edge
 * cache). The caller makes the Response (and picks its status).
 */
export async function renderPageHtml(c: Context<AppEnv>, opts: PageOptions): Promise<string> {
	return String(await resolveCallback(await pageMarkup(c, opts), HtmlEscapedCallbackPhase.Stringify, false, {}));
}

function pageMarkup(c: Context<AppEnv>, opts: PageOptions): Html {
	const state = pageState(c);
	const copy = STATUS_COPY[state.status];
	const requestPath = (() => {
		try {
			return new URL(c.req.url).pathname;
		} catch {
			return '/';
		}
	})();
	const path = opts.path ?? requestPath;
	const isHome = path === '/';
	const fullTitle = isHome ? opts.title : `${opts.title} · ${SITE_NAME}`;
	const description = opts.description ?? copy.sentence;
	const base = siteUrl(c.env ?? {});
	const build = buildId(c.env);
	const scripts = (opts.scripts ?? []).filter(safeSameOriginScript);
	const bodyClasses = [opts.bodyClass ?? '', opts.bare ? 'is-bare' : '', isHome ? 'page-home' : ''].filter(Boolean).join(' ');
	const ogImage = ogImageUrl(base, state);

	// The header only varies with the status and which nav links are current (the first is
	// Home), the footer with the status and the build, so both are rendered once per isolate
	// per combination. The keys are small and bounded whatever the request path.
	const header = opts.bare
		? ''
		: headerCache(`${state.status}|${NAV_LINKS.map((l) => (isCurrent(l.href, path) ? 1 : 0)).join('')}`, () =>
				siteHeader(state.status, isHome, path),
			);
	const footer = opts.bare
		? ''
		: footerCache(`${state.status}|${build ? `${build.tag ?? build.id}|${build.timestamp ?? ''}` : 'local'}`, () => siteFooter(state.status, build));

	return html`<!doctype html>
<html lang="en-GB" data-status="${state.status}" data-page="${isHome ? 'home' : 'page'}" data-title-base="${fullTitle}" data-changed-at="${state.statusChangedAt}" data-due-date="${state.dueDate ?? ''}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${fullTitle}</title>
<meta name="description" content="${description}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${themeColour(state.status, 'light')}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${themeColour(state.status, 'dark')}" media="(prefers-color-scheme: dark)">
${opts.noindex ? html`<meta name="robots" content="noindex, nofollow">` : ''}
<link rel="canonical" href="${base}${path}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="en_GB">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${base}${path}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${`Is Zack a dad? ${copy.word}.`}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${fullTitle}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${ogImage}">
<link rel="icon" href="/favicon-${state.status}.svg" type="image/svg+xml" data-favicon>
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="alternate" type="application/rss+xml" title="${SITE_NAME} (RSS)" href="/feed.xml">
<link rel="alternate" type="application/atom+xml" title="${SITE_NAME} (Atom)" href="/atom.xml">
<link rel="alternate" type="application/feed+json" title="${SITE_NAME} (JSON Feed)" href="/feed.json">
<link rel="alternate" type="text/calendar" title="${SITE_NAME} (calendar)" href="/calendar.ics">
<link rel="preload" href="/fonts/anybody-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/atkinson-next-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/delights.css">
${opts.turnstile ? raw('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>') : ''}
<script type="module" src="/app.js"></script>
<script type="module" src="/delights.js"></script>
${scripts.map((src) => html`<script type="module" src="${src}"></script>`)}
<script type="application/json" id="site-copy">${raw(clientCopyJson())}</script>
${opts.head ?? ''}
</head>
<body class="${bodyClasses}" data-status="${state.status}">
<a class="skip-link" href="#main">Skip to the answer</a>
<div class="sr-only" id="announcer" role="status" aria-live="polite" aria-atomic="true" data-announcer></div>
${header}
<main id="main" tabindex="-1">${opts.body}</main>
${footer}
</body>
</html>`;
}

const headerCache = fragmentCache();
const footerCache = fragmentCache();

function siteHeader(status: Status, isHome: boolean, path: string): Html {
	return html`<header class="site-header">
	<div class="wrap header-inner">
		<a href="/" class="brand"${isHome ? raw(' aria-current="page"') : ''}>
			<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M16 3C10 3 5 12 5 19a11 11 0 0 0 22 0C27 12 22 3 16 3Z"/></svg>
			<span class="brand-name">${SITE_NAME}</span>
			<span class="brand-answer" data-live="word">${STATUS_COPY[status].word}</span>
		</a>
		<nav class="site-nav" aria-label="Main">
			<ul>
				${NAV_LINKS.map(
					(l) =>
						html`<li><a href="${l.href}"${isCurrent(l.href, path) ? raw(' aria-current="page"') : ''}${l.href === '/everything' ? raw(' class="nav-cta"') : ''}>${l.label}</a></li>`,
				)}
			</ul>
		</nav>
	</div>
</header>`;
}

function siteFooter(status: Status, build: ReturnType<typeof buildId>): Html {
	const copy = STATUS_COPY[status];
	return html`<footer class="site-footer">
	<div class="wrap">
		<div class="footer-top">
			<p class="footer-answer"><span class="kicker">Current answer</span> <span class="footer-sentence" data-live="sentence">${copy.sentence}</span></p>
			<a class="btn btn-ghost" href="/everything">Tell me the moment it changes</a>
		</div>
		<nav class="footer-grid" aria-label="Everything else">
			${FOOTER_SECTIONS.map(
				(s) => html`<div class="footer-col">
					<h2 class="kicker">${s.title}</h2>
					<ul>
						${s.links.map((l) => html`<li><a href="${l.href}">${l.label}</a></li>`)}
					</ul>
				</div>`,
			)}
		</nav>
		<div class="footer-meta tiny muted">
			<p>
				Build <code class="build-id" title="${build?.timestamp ? `Deployed ${build.timestamp}` : 'Local build'}">${build ? (build.tag ?? build.id) : 'local'}</code>
				· Served by one Cloudflare Worker, a Durable Object, D1, three Workflows and a cron trigger, in 10 ms of CPU apiece. For a yes/no question.
			</p>
			<p>
				No AI was consulted in determining the answer. No personal data about the baby is stored, shown or wanted.
				Typeset in Anybody, Atkinson Hyperlegible Next and Martian Mono (<a href="/fonts/OFL-anybody.txt">OFL</a>).
			</p>
		</div>
	</div>
</footer>`;
}

/** Browser chrome colour per status and scheme. Mirrors --hero-bg in /styles.css. */
export function themeColour(status: Status, scheme: 'light' | 'dark'): string {
	if (status === 'soon') return '#ffb000';
	if (status === 'yes') return scheme === 'dark' ? '#0e6b3a' : '#14864a';
	return scheme === 'dark' ? '#12110e' : '#f1ece1';
}
