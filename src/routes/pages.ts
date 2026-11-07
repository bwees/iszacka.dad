// OWNER: frontend agent.
// Home (/), /updates, /updates/:id, /everything, /og/card, 404 + error pages.

import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getReadinessSummary, type ReadinessSummary } from '../lib/community';
import { getCheckTotal } from '../lib/counters';
import { regionName } from '../lib/counters-geo';
import { dadForecast, type ForecastDay } from '../lib/forecast';
import { babySize, type BabySize } from '../lib/fruit';
import { TRANSLATIONS, isRtl, negotiateTranslation, wordFor, type Translation } from '../lib/i18n';
import { type Html, buildId, fragmentCache, pageState, renderPage } from '../lib/layout';
import { liveSnapshot } from '../lib/live';
import { renderOgCardHtml } from '../lib/og-card';
import { wantsJson } from '../lib/security';
import { DAD, DOMAIN, PARENTS, SITE_NAME, STATUS_COPY, dnsAnswerName, siteUrl } from '../lib/site';
import { daysBetween, formatDayMonth, formatLondon, formatLondonDate, formatNumber, formatWeekday, isYmd, londonDate, londonHour } from '../lib/time';
import { getSetting } from '../lib/state';
import { getUpdate, listUpdates } from '../lib/updates';
import { STATUSES, isStatus, type AppEnv, type SiteState, type Status, type Update, type UpdateKind } from '../types';
import { pushWidget } from './push';
import { SOCIAL_HEAD, SOCIAL_SCRIPT, socialHomePanels } from './social';
import { emailSignupForm } from './subscribe';
import { webhookForm } from './webhooks';

export const pageRoutes = new Hono<AppEnv>();

// ─── Small, pure helpers (exported for tests) ────────────────────────────────

/** Run a teammate's data source without letting its failure take the page down. */
async function safe<T>(label: string, fn: () => Promise<T> | T, fallback: T): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		console.error(`home: ${label} failed:`, err);
		return fallback;
	}
}

/** `safe` for synchronous, pure work (forecast, fruit), so a memoised fragment never waits. */
function safeSync<T>(label: string, fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch (err) {
		console.error(`home: ${label} failed:`, err);
		return fallback;
	}
}

export function formatCount(n: number): string {
	return Number.isFinite(n) ? formatNumber(Math.max(0, Math.floor(n))) : '0';
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "3d 04h 12m 05s" (days omitted when zero). */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const d = Math.floor(total / 86_400);
	const h = Math.floor((total % 86_400) / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return `${d > 0 ? `${d}d ` : ''}${pad2(h)}h ${pad2(m)}m ${pad2(s)}s`;
}

/** The UTC instant of 00:00 Europe/London on a 'YYYY-MM-DD' date. */
export function londonMidnightMs(ymd: string): number {
	const guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
	return guess - londonHour(new Date(guess)) * 3_600_000;
}

export interface Countdown {
	mode: 'until-due' | 'due-today' | 'overdue' | 'no-due' | 'labour' | 'dad';
	label: string;
	value: string;
	note: string;
}

/** What the big clock says. app.js recomputes the same thing every second. */
export function countdownCopy(state: SiteState, now: Date = new Date()): Countdown {
	const changed = Date.parse(state.statusChangedAt);
	if (state.status === 'yes') {
		return {
			mode: 'dad',
			label: 'Dad for',
			value: formatDuration(now.getTime() - (Number.isNaN(changed) ? now.getTime() : changed)),
			note: 'and counting. Sleep last seen at around the same time.',
		};
	}
	if (state.status === 'soon') {
		return {
			mode: 'labour',
			label: 'Labour in progress for',
			value: formatDuration(now.getTime() - (Number.isNaN(changed) ? now.getTime() : changed)),
			note: 'Updates the moment there is one. Please stop asking Zack.',
		};
	}
	if (!state.dueDate || !isYmd(state.dueDate)) {
		return {
			mode: 'no-due',
			label: 'Due date',
			value: 'Classified',
			note: 'No due date on file, so the countdown is standing by.',
		};
	}
	const today = londonDate(now);
	const days = daysBetween(today, state.dueDate);
	const dueText = formatLondonDate(state.dueDate);
	const midnight = londonMidnightMs(state.dueDate);
	if (days > 0) {
		return {
			mode: 'until-due',
			label: 'T-minus',
			value: formatDuration(midnight - now.getTime()),
			note: `until the due date, ${dueText}. Due dates are, famously, suggestions.`,
		};
	}
	if (days === 0) {
		return {
			mode: 'due-today',
			label: 'Due today',
			value: formatDuration(now.getTime() - midnight),
			note: 'into the due date. Any minute now. Or not.',
		};
	}
	const overdue = -days;
	return {
		mode: 'overdue',
		label: `${overdue} ${overdue === 1 ? 'day' : 'days'} overdue`,
		value: formatDuration(now.getTime() - midnight),
		note: `since the due date (${dueText}). The baby is clearly running on Zack's schedule.`,
	};
}

/** Country names that read better with "the" in front. */
const DEFINITE_COUNTRIES = new Set([
	'GB', 'US', 'NL', 'PH', 'AE', 'BS', 'GM', 'CD', 'CG', 'DO', 'CF', 'KY', 'MV', 'MH', 'SB', 'SC', 'FK', 'FO', 'VA',
	'IM', 'TC', 'VG', 'VI', 'KM', 'CZ',
]);

export interface Geo {
	city: string | null;
	country: string | null;
	countryCode: string | null;
	colo: string | null;
}

function cleanGeoText(value: unknown, max = 60): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
	return trimmed ? trimmed.slice(0, max) : null;
}

/** Where the visitor is, per Cloudflare's request metadata. Everything is optional (local dev has none). */
export function geoFromRequest(request: Request): Geo {
	const cf = (request as Request & { cf?: Partial<IncomingRequestCfProperties> }).cf;
	const code = cleanGeoText(cf?.country, 2)?.toUpperCase() ?? null;
	let country: string | null = null;
	if (code === 'T1') country = 'the Tor network';
	else if (code && /^[A-Z]{2}$/.test(code) && code !== 'XX') {
		const name = regionName(code);
		country = name ? `${DEFINITE_COUNTRIES.has(code) ? 'the ' : ''}${name}` : null;
	}
	return {
		city: cleanGeoText(cf?.city),
		country,
		countryCode: code,
		colo: cleanGeoText(cf?.colo, 8),
	};
}

export function greeting(geo: Geo): string {
	if (geo.city && geo.country) return `Hello, visitor from ${geo.city}, ${geo.country}.`;
	if (geo.city) return `Hello, visitor from ${geo.city}.`;
	if (geo.country) return `Hello, visitor from ${geo.country}.`;
	return 'Hello, visitor from parts unknown.';
}

export function withArticle(noun: string): string {
	const n = noun.trim();
	if (/^(a|an|the)\s/i.test(n)) return n;
	return `${/^[aeiou]/i.test(n) ? 'an' : 'a'} ${n}`;
}

const KIND_LABEL: Record<UpdateKind, string> = { status: 'Status change', daily: 'Daily bulletin', system: 'Notice' };
const STATUS_BADGE: Record<Status, string> = { no: 'No', soon: 'Not yet', yes: 'Yes' };

const PERSONAL_CHECK_LINES = {
	first: 'This is your first check. Welcome. It will not be your last.',
	few: 'You have personally checked {n} times. Understandable.',
	many: 'You have personally checked {n} times. Seek help.',
	lots: 'You have personally checked {n} times. Seek help. Possibly professional.',
	absurd: 'You have personally checked {n} times. Your next of kin have been notified.',
};
let personalCheckLinesJson: string | undefined;

/** The checks sentence tail for each status (the client swaps them on a live state change). */
const CHECKS_TAIL: Record<Status, string> = {
	no: 'The answer has been NO every time.',
	soon: 'The answer was NO every time, until very recently.',
	yes: 'It was NO for ages. Now it is YES.',
};

const VIEWER_SENTENCE = {
	one: 'person is anxiously refreshing this page right now.',
	other: 'people are anxiously refreshing this page right now.',
};

// ─── Shared fragments ────────────────────────────────────────────────────────

function timeTag(iso: string, opts: Intl.DateTimeFormatOptions = {}): Html {
	const valid = !Number.isNaN(Date.parse(iso));
	return html`<time datetime="${iso}">${valid ? formatLondon(iso, opts) : iso}</time>`;
}

/** When the answer last changed, with a hook app.js uses to keep it current when it changes live. */
function changedAtTag(iso: string): Html {
	const valid = !Number.isNaN(Date.parse(iso));
	return html`<time datetime="${iso}" data-live-changed-at>${valid ? formatLondon(iso) : iso}</time>`;
}

/**
 * One block per status, all but the current one hidden. app.js shows the matching one when the
 * answer changes live (no refetch, so no stampede on / at the big moment).
 */
function statusVariants(current: Status, render: (s: Status) => Html): Html {
	return html`${STATUSES.map(
		(s) => html`<div class="stack" data-status-variant="${s}"${s === current ? '' : raw(' hidden')}>${render(s)}</div>`,
	)}`;
}

function statusBadge(status: Status): Html {
	return html`<span class="badge badge-${status}">${STATUS_BADGE[status]}</span>`;
}

/** Plain-text body → paragraphs with line breaks, escaped. */
function textToHtml(text: string): Html {
	const paragraphs = text
		.replace(/\r\n?/g, '\n')
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);
	return html`${paragraphs.map((p) => {
		const lines = p.split('\n');
		return html`<p>${lines.map((line, i) => html`${i > 0 ? raw('<br>') : ''}${line}`)}</p>`;
	})}`;
}

function snippet(id: string, code: string, label?: string): Html {
	return html`<div class="snippet">
		${label ? html`<p class="snippet-label tiny mono">${label}</p>` : ''}
		<pre class="code" id="${id}"><code>${code}</code></pre>
		<button class="btn btn-ghost btn-copy" type="button" data-copy="#${id}" data-js-only hidden>Copy</button>
	</div>`;
}

/** Live-updatable text: app.js swaps in data-<status> when the state changes. */
function byStatus(values: Record<Status, string>, current: Status, attrs: { tag?: 'span' | 'p'; className?: string; lang?: string } = {}): Html {
	const tag = attrs.tag ?? 'span';
	const lang = attrs.lang ? html` lang="${attrs.lang}"${isRtl(attrs.lang) ? raw(' dir="rtl"') : ''}` : '';
	return html`${raw(`<${tag}`)}${attrs.className ? html` class="${attrs.className}"` : ''}${lang} data-by-status data-no="${values.no}" data-soon="${values.soon}" data-yes="${values.yes}">${values[current]}${raw(`</${tag}>`)}`;
}

function answerWords(word: string): Html {
	return html`${word.split(' ').map((w, i) => html`${i > 0 ? ' ' : ''}<span class="answer-word">${w}</span>`)}`;
}

// ─── Home ────────────────────────────────────────────────────────────────────

pageRoutes.get('/', async (c) => {
	const state = c.get('state');
	const status = state.status;
	const copy = STATUS_COPY[status];
	const now = new Date();
	const today = londonDate(now);
	const geo = geoFromRequest(c.req.raw);
	const translation = negotiateTranslation(c.req.header('accept-language'));
	const build = buildId(c.env);

	// One WaitingRoom RPC carries viewers, vibes and the check total; getCheckTotal (D1) only
	// if the room couldn't answer.
	const [stats, updates, readiness] = await Promise.all([
		liveSnapshot(c.env),
		safe('updates', () => listUpdates(c.env, { limit: 5 }), [] as Update[]),
		safe<ReadinessSummary | null>('readiness', () => getReadinessSummary(c.env), null),
	]);
	const checks = stats.checks ?? (await safe('checks', () => getCheckTotal(c.env), 0));
	const clock = countdownCopy(state, now);
	// The forecast and fruit panels only change with the status, the due date and the London
	// date, so each isolate renders them once per combination (see fragmentCache).
	const dayKey = `${status}|${state.dueDate ?? ''}|${today}`;

	const hero = homeHero(state, translation, now);
	const body = html`${hero}
<section class="mission" id="mission-control" aria-labelledby="mc-title">
	<div class="wrap">
		<header class="mc-head">
			<div>
				<p class="kicker">Paternity Detection System · Mk&nbsp;IV</p>
				<h2 id="mc-title" class="mc-title">Mission control</h2>
			</div>
			<p class="mc-status mono tiny">
				<span class="led" aria-hidden="true"></span>
				<span data-conn-label>Telemetry: standing by</span>
				${geo.colo ? html`<span class="mc-sep">·</span> <span>Served from ${geo.colo}</span>` : ''}
				<span class="mc-sep">·</span> <span>Build ${build ? (build.tag ?? build.id) : 'local'}</span>
			</p>
		</header>

		<div class="mc-grid">
			${panel('greeting', '01', 'Greeting', 'span-6', html`
				<p class="panel-big">${greeting(geo)}</p>
				${translation.lang === 'en'
					? html`<p>Your browser speaks English, so the answer is simply ${byStatus({ no: 'no', soon: 'not yet', yes: 'yes' }, status, { tag: 'span', className: 'answer-inline' })}.</p>`
					: html`<p>Your browser prefers ${translation.name}, so: ${byStatus(
							{ no: translation.no, soon: translation.notYet, yes: translation.yes },
							status,
							{ tag: 'span', className: 'answer-inline', lang: translation.lang },
						)}.</p>`}
				<p class="tiny muted">It is <time datetime="${now.toISOString()}">${formatLondon(now.toISOString(), { weekday: undefined, year: undefined })}</time> in London, where the answer is kept.</p>
			`)}
			${panel('viewers', '02', 'Audience', 'span-3', html`
				<p class="big-number" data-live="viewers">${formatCount(stats.viewers)}</p>
				<p><span data-plural="viewers" data-one="${VIEWER_SENTENCE.one}" data-other="${VIEWER_SENTENCE.other}">${stats.viewers === 1 ? VIEWER_SENTENCE.one : VIEWER_SENTENCE.other}</span></p>
			`)}
			${panel('checks', '03', 'Checks', 'span-3', html`
				<p class="big-number" data-live="checks">${formatCount(checks)}</p>
				<p><span data-plural="checks" data-one="check so far." data-other="checks so far.">${checks === 1 ? 'check so far.' : 'checks so far.'}</span> ${byStatus(CHECKS_TAIL, status)}</p>
			`)}
			${panel('clock', '04', 'Countdown', 'span-8', html`
				<div class="clock" data-clock>
					<p class="clock-label" data-clock-label>${clock.label}</p>
					<p class="clock-value" data-clock-value>${clock.value}</p>
					<p class="clock-note" data-clock-note>${clock.note}</p>
				</div>
				<p class="tiny muted">The answer last changed ${changedAtTag(state.statusChangedAt)} UK time<span data-local-time></span>.</p>
			`)}
			${panel('you', '05', 'You', 'span-4', html`
				<p class="big-number" data-personal-count>?</p>
				<p data-personal-line data-lines="${(personalCheckLinesJson ??= JSON.stringify(PERSONAL_CHECK_LINES))}">We count how often you check, on your device only.</p>
				<noscript><p class="tiny muted">Turn on JavaScript and we will count how often you check. For your own good.</p></noscript>
			`)}
			${panel('forecast', '06', '7-day dad forecast', 'span-12', forecastPanel(dayKey, () => forecastVariants(state, today)))}
			${panel('fruit', '07', 'Biometrics', 'span-4', fruitPanelCache(dayKey, () => fruitVariants(state, today)))}
			${panel('ready', '08', 'Readiness', 'span-4', readinessPanel(readiness))}
			${panel('vibes', '09', 'Morale', 'span-4', html`
				<p class="big-number" data-live="vibes">${formatCount(stats.vibes)}</p>
				<p><span data-plural="vibes" data-one="good vibe" data-other="good vibes">${stats.vibes === 1 ? 'good vibe' : 'good vibes'}</span> sent to ${PARENTS} so far. None have been noticed, all are appreciated.</p>
				<div class="cluster vibe-buttons" data-js-only hidden>
					<button class="btn btn-primary" type="button" data-vibe="💛">Send good vibes <span aria-hidden="true">💛</span></button>
					<button class="btn btn-icon" type="button" data-vibe="🍼" aria-label="Send a bottle">🍼</button>
					<button class="btn btn-icon" type="button" data-vibe="🎉" aria-label="Send a party popper">🎉</button>
					<button class="btn btn-icon" type="button" data-vibe="☕" aria-label="Send coffee">☕</button>
					<button class="btn btn-icon" type="button" data-vibe="🙏" aria-label="Send hope">🙏</button>
				</div>
				<p class="tiny muted" data-vibe-status aria-live="polite"></p>
				<noscript><p class="tiny muted">Vibes travel by JavaScript. Yours are noted in spirit.</p></noscript>
			`)}
			${panel('updates', '10', 'Dispatches', 'span-7', html`
				${updatesList(updates, 'mini')}
				<p><a href="/updates">All updates <span aria-hidden="true">→</span></a></p>
			`)}
			${panel('instruments', '11', 'Instruments', 'span-5', html`
				<p>For when reading is too much effort, or not dramatic enough.</p>
				<div class="cluster">
					<button class="btn" type="button" data-speak data-speak-lang="${translation.lang}" data-speak-word-no="${wordFor(translation, 'no')}" data-speak-word-soon="${wordFor(translation, 'soon')}" data-speak-word-yes="${wordFor(translation, 'yes')}" data-js-only hidden><span aria-hidden="true">🔊</span> Listen</button>
					<button class="btn" type="button" data-drumroll data-js-only hidden><span aria-hidden="true">🥁</span> Drumroll, please</button>
				</div>
				<p class="tiny muted">Spoken by your browser's own voice and drummed by its own audio hardware. No servers, files or musicians were involved.</p>
				<noscript><p class="tiny muted">These instruments need JavaScript. Imagine a drumroll.</p></noscript>
			`)}
			${socialHomePanels(state, { today, anxiety: stats.anxiety })}
		</div>
	</div>
	${tickerCache(status, () => ticker(status))}
	<div class="wrap">
		<section class="cta" aria-labelledby="cta-title">
			<p class="kicker">Don't refresh. Subscribe.</p>
			<h2 id="cta-title" class="cta-title">Every possible way to find out</h2>
			<p class="lede">Email, push, webhooks, RSS, Atom, JSON Feed, iCal, DNS, SSE, WebSockets, curl, MCP and a badge for your README. Carrier pigeon pending regulatory approval.</p>
			<p><a class="btn btn-primary btn-lg" href="/everything">Get notified <span aria-hidden="true">→</span></a></p>
		</section>
	</div>
</section>
<div class="vibe-layer" data-vibe-layer aria-hidden="true"></div>
${updateTemplateCache('', updateTemplate)}`;

	const res = await renderPage(c, {
		title: `${SITE_NAME} ${copy.short}`,
		description: `${copy.sentence} Live, with an unreasonable amount of supporting telemetry.`,
		path: '/',
		body,
		head: SOCIAL_HEAD,
		scripts: [SOCIAL_SCRIPT],
	});
	res.headers.set('Cache-Control', 'no-cache');
	res.headers.append('Vary', 'Accept-Language');
	return res;
});

function homeHero(state: SiteState, t: Translation, now: Date): Html {
	const copy = STATUS_COPY[state.status];
	const word = copy.word;
	return html`<section class="hero" aria-labelledby="hero-title">
	<div class="hero-marks" aria-hidden="true">
		<span class="mark mark-tl">FIG. 1</span>
		<span class="mark mark-tr">THE ANSWER</span>
		<span class="mark mark-bl">SCALE 1:1</span>
		<span class="mark mark-br">${DOMAIN.toUpperCase()}</span>
	</div>
	<h1 class="hero-title" id="hero-title">
		<span class="hero-q">Is ${DAD} a dad?</span>
		<span class="answer" data-live="answer">${answerWords(word)}</span>
	</h1>
	<p class="hero-asof">
		<span>as of</span>
		<time datetime="${now.toISOString()}" data-asof>${formatLondon(now.toISOString(), { weekday: undefined, year: undefined, second: '2-digit' })} UK time</time>
		<span class="conn" data-conn-text>live updates need JavaScript</span>
	</p>
	${t.lang !== 'en'
		? html`<p class="hero-foreign">${byStatus({ no: t.no, soon: t.notYet, yes: t.yes }, state.status, { lang: t.lang, className: 'foreign-word' })}<span class="muted"> · ${t.name}, as your browser requested</span></p>`
		: ''}
	<a class="hero-cue" href="#mission-control"><span>Mission control</span> <span aria-hidden="true" class="cue-arrow">↓</span></a>
</section>`;
}

function panel(id: string, channel: string, label: string, span: string, body: Html): Html {
	return html`<section class="panel ${span}" aria-labelledby="panel-${id}">
	<header class="panel-head">
		<h3 class="panel-label" id="panel-${id}"><span class="panel-ch">CH-${channel}</span> ${label}</h3>
		<span class="led" aria-hidden="true"></span>
	</header>
	<div class="panel-body stack">${body}</div>
</section>`;
}

const forecastPanel = fragmentCache();
const fruitPanelCache = fragmentCache();
const tickerCache = fragmentCache();
const updateTemplateCache = fragmentCache();

/**
 * Every status's forecast (all but the current one hidden), so a tab that sees the answer
 * change live can swap panels without refetching the page.
 */
function forecastVariants(state: SiteState, today: string): Html {
	return statusVariants(state.status, (s) =>
		forecastStrip(
			safeSync<ForecastDay[]>('forecast', () => dadForecast(state.dueDate, today, s), []),
			today,
		),
	);
}

function fruitVariants(state: SiteState, today: string): Html {
	const size = safeSync<BabySize | null>('babySize', () => babySize(state.dueDate, today), null);
	return statusVariants(state.status, (s) => fruitPanel(size, s));
}

function forecastStrip(days: ForecastDay[], today: string): Html {
	if (!days.length) {
		return html`<div class="empty">Forecast unavailable. Even the Met Office won't touch this one.</div>`;
	}
	const tomorrow = (() => {
		const d = new Date(`${today}T12:00:00Z`);
		d.setUTCDate(d.getUTCDate() + 1);
		return d.toISOString().slice(0, 10);
	})();
	const dayName = (ymd: string) => (ymd === today ? 'Today' : ymd === tomorrow ? 'Tomorrow' : formatWeekday(ymd));
	const dayDate = (ymd: string) => (isYmd(ymd) ? formatDayMonth(ymd) : '');
	const pct = (p: number) => {
		const v = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0)) * 100;
		return v > 0 && v < 1 ? '<1%' : `${Math.round(v)}%`;
	};
	return html`<ol class="forecast">
		${days.slice(0, 7).map((d) => {
			const height = Math.round(Math.min(1, Math.max(0, d.probability || 0)) * 100);
			return html`<li class="fc-day">
				<span class="fc-name">${dayName(d.date)}</span>
				<span class="fc-date tiny muted">${dayDate(d.date)}</span>
				<span class="fc-emoji" aria-hidden="true">${d.emoji}</span>
				<span class="fc-label">${d.label}</span>
				<span class="fc-prob"><span class="sr-only">Chance of becoming a dad: </span>${pct(d.probability)}</span>
				<span class="fc-bar" aria-hidden="true"><span style="height:${height}%"></span></span>
			</li>`;
		})}
	</ol>
	<p class="tiny muted">Probability that the baby arrives on each day, given that it hasn't already. Issued by the Met Office of Paternity. Not affiliated with any actual meteorologists.</p>`;
}

function fruitPanel(size: BabySize | null, status: Status): Html {
	if (status === 'yes') {
		return html`<p class="fruit-emoji" aria-hidden="true">👶</p><p>The baby is no longer measured in fruit. The baby is measured in nappies per day.</p>`;
	}
	if (!size) {
		return html`<div class="empty">Fruit telemetry unavailable. The baby's size is, for now, unknowable.</div>`;
	}
	return html`<p class="fruit-emoji" aria-hidden="true">${size.emoji}</p>
	<p>The baby is currently the size of <strong>${withArticle(size.fruit)}</strong>.</p>
	<p class="tiny muted mono">Week ${size.week}, day ${size.day} (estimated from the due date)</p>`;
}

function readinessPanel(r: ReadinessSummary | null): Html {
	if (!r || r.total <= 0) {
		return html`<div class="empty">Readiness unknown. The checklist is still being drawn up.</div>
		<p><a href="/ready">Inspect the checklist <span aria-hidden="true">→</span></a></p>`;
	}
	const pct = Math.min(100, Math.max(0, Math.round(r.percent)));
	return html`<p class="big-number">${pct}<span class="unit">%</span></p>
	<div class="meter" role="meter" aria-label="Dad readiness" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
	<p>${r.done} of ${r.total} essential dad tasks complete.</p>
	<p><a href="/ready">Inspect the checklist <span aria-hidden="true">→</span></a></p>`;
}

function ticker(status: Status): Html {
	// The list is rendered once and used twice (the second copy makes the scroll seamless).
	const list = html`${TRANSLATIONS.map(
		(t) => html`<li>${byStatus({ no: t.no, soon: t.notYet, yes: t.yes }, status, { lang: t.lang, className: 't-word' })}<span class="t-lang">${t.name}</span></li>`,
	)}`;
	const track = (hidden: boolean) =>
		html`<ul class="ticker-track"${hidden ? raw(' aria-hidden="true"') : ''}>
			${list}
		</ul>`;
	return html`<section class="ticker" aria-label="The answer in ${TRANSLATIONS.length} languages">
		<p class="ticker-label kicker"><span>The answer in ${TRANSLATIONS.length} languages</span></p>
		<div class="ticker-viewport">${track(false)}${track(true)}</div>
	</section>`;
}

function updatesList(updates: Update[], variant: 'mini' | 'full', live = true): Html {
	const item = (u: Update) =>
		variant === 'mini'
			? html`<li class="update-mini">
				<a href="/updates/${u.id}">
					<span class="update-meta tiny mono">${timeTag(u.createdAt, { weekday: undefined, year: undefined })}</span>
					<span class="update-title">${u.title}</span>
				</a>
			</li>`
			: html`<li class="timeline-item">
				<article class="card update-card">
					<p class="cluster update-meta tiny">${statusBadge(u.status)} <span class="pill">${KIND_LABEL[u.kind]}</span> ${timeTag(u.createdAt)}</p>
					<h2 class="card-title"><a href="/updates/${u.id}">${u.title}</a></h2>
					${u.body ? html`<div class="update-body">${textToHtml(u.body)}</div>` : ''}
				</article>
			</li>`;
	return html`<ol class="${variant === 'mini' ? 'updates-mini' : 'timeline'}"${live ? html` data-updates-list="${variant}"` : ''} data-limit="${variant === 'mini' ? 5 : 50}">
		${updates.map(item)}
	</ol>
	${updates.length === 0 ? html`<div class="empty" data-updates-empty>No updates yet. Which is, itself, an update.</div>` : ''}`;
}

/** Inert templates app.js clones when an update arrives live. */
function updateTemplate(): Html {
	return html`<template id="tpl-update-mini"><li class="update-mini is-new"><a data-field="link" href="/updates"><span class="update-meta tiny mono"><time data-field="time"></time></span><span class="update-title" data-field="title"></span></a></li></template>
<template id="tpl-update-full"><li class="timeline-item is-new"><article class="card update-card"><p class="cluster update-meta tiny"><span class="badge" data-field="badge"></span> <span class="pill" data-field="kind"></span> <time data-field="time"></time></p><h2 class="card-title"><a data-field="link" href="/updates"><span data-field="title"></span></a></h2><div class="update-body" data-field="body"></div></article></li></template>
<script type="application/json" id="update-labels">${raw(JSON.stringify({ kinds: KIND_LABEL, badges: STATUS_BADGE }).replace(/</g, '\\u003c'))}</script>`;
}

// ─── /updates ────────────────────────────────────────────────────────────────

const UPDATES_PAGE_SIZE = 20;

function parseId(value: string | undefined): number | null {
	if (!value || !/^\d{1,15}$/.test(value)) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

pageRoutes.get('/updates', async (c) => {
	const beforeParam = c.req.query('before');
	const before = parseId(beforeParam);
	if (beforeParam !== undefined && before === null) return c.redirect('/updates', 302);
	const rows = await listUpdates(c.env, { limit: UPDATES_PAGE_SIZE + 1, beforeId: before ?? undefined });
	const page = rows.slice(0, UPDATES_PAGE_SIZE);
	const older = rows.length > UPDATES_PAGE_SIZE ? page[page.length - 1] : undefined;
	const firstPage = before === null;

	const body = html`<div class="wrap section stack-lg">
	<header class="page-head">
		<p class="kicker">Dispatches from the waiting room</p>
		<h1>Updates</h1>
		<p class="lede">Every announcement, newest first. Mostly variations on a theme of "no".</p>
		<p class="cluster tiny">
			<span class="muted">Also available as</span>
			<a class="pill" href="/feed.xml">RSS</a> <a class="pill" href="/atom.xml">Atom</a> <a class="pill" href="/feed.json">JSON Feed</a>
			<a class="pill" href="/calendar.ics">iCal</a> <a class="pill" href="/api/updates">JSON API</a>
		</p>
	</header>
	${!firstPage ? html`<p class="notice">You are looking at older updates. <a href="/updates">Back to the newest</a>.</p>` : ''}
	${page.length === 0 && !firstPage ? html`<div class="empty">Nothing older than that. This is where it all began.</div>` : updatesList(page, 'full', firstPage)}
	<nav class="pager cluster" aria-label="Pagination">
		${!firstPage ? html`<a class="btn btn-ghost" href="/updates">← Newest</a>` : ''}
		${older ? html`<a class="btn" href="/updates?before=${older.id}" rel="next">Older updates →</a>` : ''}
	</nav>
</div>
${firstPage ? updateTemplateCache('', updateTemplate) : ''}`;

	return renderPage(c, {
		title: firstPage ? 'Updates' : 'Older updates',
		description: 'Every update about whether Zack is a dad, newest first.',
		path: '/updates',
		noindex: !firstPage,
		body,
	});
});

pageRoutes.get('/updates/:id', async (c) => {
	const id = parseId(c.req.param('id'));
	if (id === null) return notFoundHandler(c);
	const update = await getUpdate(c.env, id);
	if (!update) return notFoundHandler(c);
	const [older] = await safe('older update', () => listUpdates(c.env, { limit: 1, beforeId: id }), [] as Update[]);
	// A status change undone inside the one-minute window is never announced; the workflow
	// records that in settings (`superseded:<id>`), since notified_at stays empty.
	const superseded =
		update.audience !== 'none' && !update.notifiedAt && update.kind === 'status'
			? await safe('supersession', () => getSetting(c.env, `superseded:${id}`), null)
			: null;

	const announced =
		update.audience === 'none'
			? 'Not announced to anyone, by design. It just sits here, quietly.'
			: update.notifiedAt
				? html`Announced to ${update.audience === 'daily' ? 'daily-digest subscribers' : 'everyone who asked'} at ${timeTag(update.notifiedAt)}.`
				: superseded
					? 'Not announced: the answer changed again within the one-minute undo window, so nobody was notified.'
					: 'Announcement in progress. The stork is on its way.';

	const body = html`<article class="wrap section stack-lg update-detail">
	<p class="tiny"><a href="/updates">← All updates</a></p>
	<header class="page-head">
		<p class="cluster update-meta tiny">${statusBadge(update.status)} <span class="pill">${KIND_LABEL[update.kind]}</span> ${timeTag(update.createdAt)}</p>
		<h1>${update.title}</h1>
	</header>
	${update.body ? html`<div class="update-body lede">${textToHtml(update.body)}</div>` : ''}
	<dl class="meta-list">
		<div><dt>Published</dt><dd>${timeTag(update.createdAt)} UK time</dd></div>
		<div><dt>Answer at the time</dt><dd>${statusBadge(update.status)} ${STATUS_COPY[update.status].sentence}</dd></div>
		<div><dt>Notifications</dt><dd>${announced}</dd></div>
		<div><dt>Permalink</dt><dd><code>${siteUrl(c.env)}/updates/${update.id}</code></dd></div>
	</dl>
	<nav class="pager cluster" aria-label="More updates">
		<a class="btn btn-ghost" href="/updates">All updates</a>
		${older ? html`<a class="btn" href="/updates/${older.id}" rel="prev">Previous update →</a>` : ''}
	</nav>
</article>`;

	return renderPage(c, {
		title: update.title,
		description: (update.body || STATUS_COPY[update.status].sentence).slice(0, 200),
		path: `/updates/${update.id}`,
		body,
	});
});

// ─── /everything ─────────────────────────────────────────────────────────────

interface Method {
	id: string;
	title: string;
	blurb: string;
}

const METHODS: Method[] = [
	{ id: 'email', title: 'Email', blurb: 'Double opt-in, one-click unsubscribe.' },
	{ id: 'push', title: 'Push notifications', blurb: 'Straight to your lock screen.' },
	{ id: 'webhooks', title: 'Webhooks', blurb: 'Discord, Slack or anything that takes a POST.' },
	{ id: 'feeds', title: 'Feeds', blurb: 'RSS, Atom, JSON Feed and iCal.' },
	{ id: 'api', title: 'HTTP API', blurb: 'JSON, plain text, and a status code with opinions.' },
	{ id: 'sse', title: 'Server-sent events', blurb: 'A stream you can leave open all week.' },
	{ id: 'websocket', title: 'WebSocket', blurb: 'For people who find SSE too relaxed.' },
	{ id: 'curl', title: 'curl', blurb: 'The answer, in enormous ASCII.' },
	{ id: 'headers', title: 'HTTP headers', blurb: 'The answer is in every response.' },
	{ id: 'dns', title: 'DNS', blurb: 'A TXT record, updated on the spot.' },
	{ id: 'email-in', title: 'Ask by email', blurb: 'Write in. A machine replies.' },
	{ id: 'mcp', title: 'MCP', blurb: 'Let your AI assistant ask, so you do not have to.' },
	{ id: 'ledger', title: 'The Dad Ledger', blurb: 'Cryptographically signed. Obviously.' },
	{ id: 'badge', title: 'README badge', blurb: 'Tell your repo.' },
	{ id: 'embed', title: 'Embed', blurb: 'Put the answer on your own site.' },
	{ id: 'app', title: 'Install as an app', blurb: 'A home-screen icon for one bit of information.' },
	{ id: 'llms', title: 'llms.txt', blurb: 'For visiting language models.' },
];

function methodSection(n: number, m: Method, body: Html): Html {
	return html`<section class="method card" id="${m.id}" aria-labelledby="${m.id}-title">
	<header class="method-head">
		<p class="kicker">Method ${String(n).padStart(2, '0')}</p>
		<h2 class="card-title" id="${m.id}-title">${m.title}</h2>
		<p class="muted">${m.blurb}</p>
	</header>
	<div class="stack">${body}</div>
</section>`;
}

pageRoutes.get('/everything', async (c) => {
	const base = siteUrl(c.env);
	const host = base.replace(/^https?:\/\//, '');
	// The record is only kept up to date with a DNS token; without one, don't send people to dig.
	const dnsName = dnsAnswerName(c.env);
	const askAddress = `ask@${DOMAIN}`;
	// Teammates' fragments must never take the whole page down, whether they throw or reject.
	const fragment = (label: string, fn: () => Html): Html => {
		const fallback = (err: unknown) => {
			console.error(`everything: ${label} fragment failed:`, err);
			return html`<div class="notice notice-error">This method is temporarily out of order. Please try one of the others.</div>`;
		};
		try {
			const out = fn();
			return out instanceof Promise ? out.catch(fallback) : out;
		} catch (err) {
			return fallback(err);
		}
	};

	const mcpDesktop = JSON.stringify(
		{ mcpServers: { 'is-zack-a-dad': { command: 'npx', args: ['-y', 'mcp-remote', `${base}/mcp`] } } },
		null,
		2,
	);
	const mcpCode = JSON.stringify({ mcpServers: { 'is-zack-a-dad': { type: 'http', url: `${base}/mcp` } } }, null, 2);
	const byId = (id: string): Method => METHODS.find((m) => m.id === id) as Method;
	let n = 0;
	const section = (id: string, body: Html) => methodSection(++n, byId(id), body);

	const body = html`<div class="wrap section stack-lg everything">
	<header class="page-head">
		<p class="kicker">${METHODS.length} methods · pick several</p>
		<h1>Every possible way to find out</h1>
		<p class="lede">You could keep refreshing the homepage. Or you could let ${METHODS.length} independent, over-engineered delivery systems refresh it for you.</p>
	</header>
	<nav class="method-index" aria-label="Methods">
		<ol>
			${METHODS.map((m, i) => html`<li><a href="#${m.id}"><span class="mono tiny">${String(i + 1).padStart(2, '0')}</span> ${m.title}</a></li>`)}
		</ol>
	</nav>

	${section('email', html`<p>A short email when the answer changes. Optionally, a daily "still no" for completists.</p>${fragment('email', () => emailSignupForm(c))}`)}
	${section('push', html`<p>A notification on this device the moment the answer changes. Works on phones once the site is installed as an app.</p>${fragment('push', () => pushWidget(c))}`)}
	${section('webhooks', html`<p>Paste a Discord or Slack webhook URL (or any URL that accepts a JSON <code>POST</code>) and your group chat finds out at the same time as you.</p>${fragment('webhooks', () => webhookForm(c))}`)}
	${section('feeds', html`<p>Subscribe in any feed reader, or add the calendar to have the big day appear in your diary.</p>
		<ul class="link-list">
			<li><a href="/feed.xml">RSS</a> <code>${base}/feed.xml</code></li>
			<li><a href="/atom.xml">Atom</a> <code>${base}/atom.xml</code></li>
			<li><a href="/feed.json">JSON Feed</a> <code>${base}/feed.json</code></li>
			<li><a href="webcal://${host}/calendar.ics">iCal (subscribe)</a> <code>${base}/calendar.ics</code></li>
		</ul>`)}
	${section('api', html`<p>Machine-readable answers. Full documentation at <a href="/api">/api</a>, and an <a href="/openapi.json">OpenAPI description</a> for the truly committed.</p>
		${snippet('snip-api-status', `curl ${base}/api/status`, 'JSON')}
		${snippet('snip-api-txt', `curl ${base}/api/status.txt`, 'Plain text')}
		${snippet('snip-api-dad', `curl -i ${base}/api/dad`, 'The status code is the answer: 425 Too Early, then 201 Created')}`)}
	${section('sse', html`<p>A server-sent event stream that pushes every change. Leave it running in a terminal tab until further notice.</p>
		${snippet('snip-sse', `curl -N ${base}/api/stream`)}`)}
	${section('websocket', html`<p>The same live feed this page uses. Each change arrives as JSON.</p>
		${snippet('snip-ws', `websocat wss://${host}/ws`)}`)}
	${section('curl', html`<p>Ask from a terminal and get the answer as gigantic ASCII art.</p>
		${snippet('snip-curl', `curl ${host}`)}`)}
	${section('headers', html`<p>Every response carries an <code>X-Is-Zack-A-Dad</code> header, in case you are already making requests anyway.</p>
		${snippet('snip-headers', `curl -sI ${base} | grep -i x-is-zack-a-dad`)}`)}
	${section(
		'dns',
		dnsName
			? html`<p>A TXT record, rewritten the moment the answer changes. DNS caching may add suspense.</p>
		${snippet('snip-dns', `dig +short TXT ${dnsName}`)}`
			: html`<p>A TXT record, when this deployment has a DNS token. This one doesn't, so there is nothing to dig just now.</p>`,
	)}
	${section('email-in', html`<p>Email <a href="mailto:${askAddress}?subject=Is%20Zack%20a%20dad%3F">${askAddress}</a> and an automated reply will tell you the answer. It is not a person. Please don't tell it secrets.</p>
		<p>To enter the <a href="/pool">baby pool</a> by email, put "guess" in the subject and your guess in the body, like <code>14 Nov 15:30</code>, optionally with <code>Name: Alex</code>.</p>`)}
	${section('mcp', html`<p>An MCP server at <code>${base}/mcp</code>, so Claude and friends can check for you.</p>
		${snippet('snip-mcp-code-cli', `claude mcp add --transport http is-zack-a-dad ${base}/mcp`, 'Claude Code (command line)')}
		${snippet('snip-mcp-code', mcpCode, 'Claude Code (.mcp.json)')}
		${snippet('snip-mcp-desktop', mcpDesktop, 'Claude Desktop (claude_desktop_config.json)')}`)}
	${section('ledger', html`<p>Every change of answer is appended to a hash-chained, Ed25519-signed ledger, so history cannot be quietly rewritten. <a href="/ledger">Inspect the ledger</a>.</p>
		${snippet('snip-ledger', `curl ${base}/.well-known/dad-ledger.json`)}`)}
	${section('badge', html`<p class="badge-preview"><img src="/badge.svg" alt="Is Zack a dad? badge" height="20"></p>
		${snippet('snip-badge-md', `[![Is Zack a dad?](${base}/badge.svg)](${base})`, 'Markdown')}
		${snippet('snip-badge-html', `<a href="${base}"><img src="${base}/badge.svg" alt="Is Zack a dad?"></a>`, 'HTML')}`)}
	${section('embed', html`<p>Put a live answer on your own site, for reasons best known to yourself.</p>
		${snippet('snip-embed-iframe', `<iframe src="${base}/embed" title="Is Zack a dad?" width="320" height="140" style="border:0" loading="lazy"></iframe>`, 'iframe')}
		${snippet('snip-embed-script', `<script src="${base}/embed.js" async></script>`, 'Script tag')}`)}
	${section('app', html`<p>Install the site as an app for a home-screen icon and push notifications that work on phones.</p>
		<ul>
			<li>iPhone and iPad: Safari, then Share, then "Add to Home Screen".</li>
			<li>Android, Chrome and Edge: the install button below, or "Install app" in the browser menu.</li>
		</ul>
		<p><button class="btn btn-primary" type="button" data-install hidden>Install the app</button></p>`)}
	${section('llms', html`<p>A plain-text briefing for language models, so they stop guessing. Also: <a href="/humans.txt">humans.txt</a>, for humans.</p>
		${snippet('snip-llms', `curl ${base}/llms.txt`)}`)}
</div>`;

	return renderPage(c, {
		title: 'Every possible way to find out',
		description: `${METHODS.length} ways to find out the moment Zack becomes a dad, from email to DNS.`,
		path: '/everything',
		turnstile: true,
		scripts: ['/push.js'],
		body,
	});
});

// ─── /og/card ────────────────────────────────────────────────────────────────

pageRoutes.get('/og/card', async (c) => {
	const state = c.get('state');
	const requested = c.req.query('status');
	const status: Status = isStatus(requested) ? requested : state.status;
	// A preview of a different status shouldn't borrow the real status's timestamp.
	const cardState: SiteState = status === state.status ? state : { ...state, status, statusChangedAt: '' };
	const checks = await safe('checks', () => getCheckTotal(c.env), 0);
	const page = renderOgCardHtml({ state: cardState, checks, today: londonDate() });
	c.header(
		'Content-Security-Policy',
		"default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
	);
	c.header('X-Robots-Tag', 'noindex');
	c.header('Cache-Control', 'public, max-age=60');
	return c.html(page);
});

// ─── 404 and errors ──────────────────────────────────────────────────────────

function isApiPath(c: Context<AppEnv>): boolean {
	try {
		const path = new URL(c.req.url).pathname;
		return path.startsWith('/api/') || path === '/mcp';
	} catch {
		return false;
	}
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
	const ctx = c as Context<AppEnv>;
	if (wantsJson(ctx) || isApiPath(ctx)) {
		return ctx.json({ error: 'not_found', message: "This endpoint hasn't been born yet." }, 404);
	}
	return renderPage(ctx, {
		title: 'Not found',
		status: 404,
		noindex: true,
		body: html`<section class="wrap section error-page stack">
	<p class="kicker">Error 404 · Not found</p>
	<p class="error-code" aria-hidden="true">404</p>
	<h1>This page hasn't been born yet.</h1>
	<p class="lede">Expected delivery date: unknown. Much like everything else around here.</p>
	<p class="muted">If you came for the answer, it is still on the homepage, being refreshed by strangers.</p>
	<div class="cluster">
		<a class="btn btn-primary" href="/">The answer</a>
		<a class="btn" href="/updates">Updates</a>
		<a class="btn btn-ghost" href="/everything">Get notified</a>
	</div>
</section>`,
	});
};

const ERROR_SENTENCE = 'Something went wrong. Not with the baby; with the website.';

export const errorHandler: ErrorHandler<AppEnv> = async (err, c) => {
	const ctx = c as Context<AppEnv>;
	// Deliberate HTTP errors that carry their own response (e.g. 401 with WWW-Authenticate) pass straight through.
	if (err instanceof HTTPException && err.status < 500 && err.res) return err.getResponse();

	const status = (err instanceof HTTPException ? err.status : 500) as ContentfulStatusCode;
	if (status >= 500) console.error('unhandled error:', err);
	const message = err instanceof HTTPException && status < 500 && err.message ? err.message : ERROR_SENTENCE;
	const ray = ctx.req.header('cf-ray') ?? null;

	if (wantsJson(ctx) || isApiPath(ctx)) {
		return ctx.json({ error: status >= 500 ? 'internal_error' : 'request_error', message, ray }, status);
	}
	try {
		return await renderPage(ctx, {
			title: status >= 500 ? 'Something went wrong' : 'That did not work',
			status,
			noindex: true,
			body: html`<section class="wrap section error-page stack">
	<p class="kicker">Error ${status}</p>
	<p class="error-code" aria-hidden="true">${status}</p>
	<h1>${message}</h1>
	<p class="lede">${status >= 500 ? 'Someone has been paged. The baby has not. Please try again in a moment.' : 'Please check what you sent and try again.'}</p>
	${ray ? html`<p class="tiny muted mono">Reference: ${ray}</p>` : ''}
	<div class="cluster"><a class="btn btn-primary" href="/">The answer</a><a class="btn btn-ghost" href="/status">Status page</a></div>
</section>`,
		});
	} catch (renderErr) {
		console.error('error page failed to render:', renderErr);
		return new Response(`${ERROR_SENTENCE}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
	}
};
