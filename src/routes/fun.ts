// OWNER: fun agent.
// /pool (+ POST), /status (status page parody), /certificate, /poster, /admin/pool.

import { Hono, type Context } from 'hono';
import { html, raw } from 'hono/html';
import { LinearRouter } from 'hono/router/linear-router';
import { renderAdminPage, requireAdmin } from '../lib/admin';
import {
	HEALTH_LABEL,
	NO_DUE_DATE,
	PHASE_LABEL,
	UPTIME_DAYS,
	buildIncidents,
	dadForecast,
	dailyStatuses,
	formatPercent,
	healthBarClass,
	patienceHealth,
	statusComponents,
	uptimeFraction,
	type DayStatus,
	type Health,
	type Incident,
	type IncidentPhase,
} from '../lib/forecast';
import { babySize, formatGestation } from '../lib/fruit';
import { renderPage } from '../lib/layout';
import { getLedger, type LedgerEntry } from '../lib/ledger';
import {
	MAX_GUESSES_PER_PERSON,
	NAME_MAX_LENGTH,
	buildLeaderboard,
	describeDuration,
	describeOffset,
	guessHistogram,
	guessWindow,
	listGuesses,
	medianGuess,
	normaliseName,
	parseLondonLocalInput,
	setGuessHidden,
	submitGuess,
	toLondonLocalInput,
	type GuessRecord,
	type Leaderboard,
} from '../lib/pool';
import { POSTER_QR_SVG } from '../lib/poster-qr';
import { allow, clientIp, clientKey, hashIdentifier, sha256Hex, turnstileWidget, verifyTurnstile, wantsJson } from '../lib/security';
import { DAD, DOMAIN } from '../lib/site';
import { getStatusHistory } from '../lib/state';
import { formatLondon, formatLondonDate, formatNumber, formatWeekdayDayMonth, londonDate, nowIso } from '../lib/time';
import type { AppEnv, SiteState, Status } from '../types';

export const funRoutes = new Hono<AppEnv>({ router: new LinearRouter() });

type Ctx = Context<AppEnv>;

// ─── Shared bits ─────────────────────────────────────────────────────────────

/** Bespoke styles for the fun pages, scoped under `fun-` so they can't leak. */
const FUN_CSS = `
.fun-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.fun-hist{margin:0}
.fun-hist-bars{display:flex;align-items:flex-end;gap:2px;height:10rem;margin:0;padding:1.4rem 0 0;list-style:none;border-bottom:1px solid color-mix(in srgb,currentColor 35%,transparent)}
.fun-hist-col{position:relative;flex:1 1 0;min-width:2px;height:100%;display:flex;align-items:flex-end}
.fun-hist-bar{display:block;width:100%;background:var(--accent,currentColor);opacity:.8;border-radius:3px 3px 0 0}
.fun-hist-col.is-due{background:color-mix(in srgb,currentColor 7%,transparent)}
.fun-hist-col.is-due::before,.fun-hist-col.is-yes::before{position:absolute;top:-1.3rem;left:50%;transform:translateX(-50%);font-size:.9rem;line-height:1}
.fun-hist-col.is-due::before{content:"📅"}
.fun-hist-col.is-yes::before{content:"👶"}
.fun-hist-axis{display:flex;justify-content:space-between;gap:1rem;margin-top:.35rem}
.fun-components{list-style:none;margin:0;padding:0}
.fun-component{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:.25rem 1rem;padding:.8rem 0;border-top:1px solid color-mix(in srgb,currentColor 15%,transparent)}
.fun-component:first-child{border-top:0;padding-top:0}
.fun-component-name{font-weight:650}
.fun-component-note{flex-basis:100%;margin:0}
.fun-uptime{display:grid;gap:.4rem}
.fun-uptime-head,.fun-bars-axis{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.fun-incident-updates{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}
.fun-incident-updates li{padding-left:.85rem;border-left:3px solid color-mix(in srgb,currentColor 25%,transparent)}
.fun-incident-updates p{margin:0}
.fun-forecast{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(7rem,1fr));gap:.5rem}
.fun-forecast li{text-align:center;padding:.6rem .4rem;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:.6rem}
.fun-forecast-emoji{display:block;font-size:2rem;line-height:1.2}
.fun-forecast-pct{display:block;font-weight:700;font-variant-numeric:tabular-nums}
.fun-components>li,.fun-forecast>li,.fun-incident-updates>li,.fun-hist-bars>li,.fun-rules>li{color:inherit}
.fun-winner td{font-weight:700}
.fun-out td{opacity:.6}
.fun-actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.fun-inline-form{display:inline}
`;

const funHead = () => html`<style>${raw(FUN_CSS)}</style>`;

/** /status labels the same 90 days four times over, so labels are kept (bounded). */
const shortDates = new Map<string, string>();

/** "Sat 14 Nov" for a 'YYYY-MM-DD'. */
function shortDate(ymd: string): string {
	let label = shortDates.get(ymd);
	if (label === undefined) {
		label = formatWeekdayDayMonth(ymd);
		if (shortDates.size >= 400) shortDates.clear();
		shortDates.set(ymd, label);
	}
	return label;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

function percent(p: number): string {
	if (p <= 0) return '0%';
	if (p < 0.001) return '<0.1%';
	if (p >= 0.9995) return '100%';
	return `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
}

/** Same-origin check for state-changing admin POSTs (defence in depth on top of the session cookie). */
function sameOrigin(c: Ctx): boolean {
	if (c.req.header('sec-fetch-site') === 'cross-site') return false;
	const origin = c.req.header('origin');
	return !origin || origin === new URL(c.req.url).origin;
}

type Body = Record<string, unknown>;

async function readBody(c: Ctx): Promise<Body | null> {
	try {
		if ((c.req.header('content-type') ?? '').includes('application/json')) {
			const data: unknown = await c.req.json();
			return data && typeof data === 'object' && !Array.isArray(data) ? (data as Body) : {};
		}
		return (await c.req.parseBody()) as Body;
	} catch {
		return null;
	}
}

function str(body: Body, key: string, max = 500): string {
	const value = body[key];
	return typeof value === 'string' ? value.slice(0, max) : '';
}

// ─── /pool ───────────────────────────────────────────────────────────────────

interface PoolNotice {
	kind: 'ok' | 'error';
	text: string;
}

interface PoolFormValues {
	name: string;
	guess: string;
}

function histogramFigure(guesses: GuessRecord[], state: SiteState, today: string) {
	const yesDay = state.status === 'yes' ? londonDate(new Date(state.statusChangedAt)) : null;
	const days = guessHistogram(guesses, [state.dueDate, yesDay]);
	if (days.length === 0) return html`<p class="empty">No guesses yet, so no histogram. Be the first bar.</p>`;
	const max = Math.max(...days.map((d) => d.count), 1);
	const busiest = days.reduce((a, b) => (b.count > a.count ? b : a));
	const first = days[0]?.date ?? today;
	const last = days[days.length - 1]?.date ?? today;
	return html`<figure class="fun-hist">
	<ol class="fun-hist-bars" aria-label="Guesses per day, ${shortDate(first)} to ${shortDate(last)}">
		${days.map((d) => {
			const label = `${shortDate(d.date)}: ${plural(d.count, 'guess', 'guesses')}${d.date === state.dueDate ? ' (due date)' : ''}${d.date === yesDay ? ' (the actual day)' : ''}`;
			const classes = ['fun-hist-col', d.date === state.dueDate ? 'is-due' : '', d.date === yesDay ? 'is-yes' : ''].filter(Boolean).join(' ');
			return html`<li class="${classes}" title="${label}"><span class="fun-hist-bar" style="height:${((d.count / max) * 100).toFixed(1)}%"></span><span class="fun-sr">${label}</span></li>`;
		})}
	</ol>
	<figcaption class="fun-hist-axis tiny muted">
		<span>${shortDate(first)}</span>
		${state.dueDate && state.dueDate >= first && state.dueDate <= last ? html`<span><span aria-hidden="true">📅</span> Due date: ${shortDate(state.dueDate)}</span>` : ''}
		${yesDay && yesDay >= first && yesDay <= last ? html`<span><span aria-hidden="true">👶</span> Actual: ${shortDate(yesDay)}</span>` : ''}
		<span>${shortDate(last)}</span>
	</figcaption>
</figure>
${busiest.count > 1 ? html`<p class="tiny muted">Busiest day: ${shortDate(busiest.date)}, with ${plural(busiest.count, 'guess', 'guesses')}.</p>` : ''}`;
}

function leaderboardTable(board: Leaderboard) {
	if (board.entries.length === 0) {
		return html`<p class="empty">Nobody has guessed yet. The odds of winning have never been better.</p>`;
	}
	const final = board.mode === 'final';
	return html`<div class="table-wrap">
	<table class="table">
		<caption class="fun-sr">${final ? 'Final standings, closest first' : 'All guesses, in date order'}</caption>
		<thead>
			<tr>
				<th scope="col">${final ? 'Rank' : '#'}</th>
				<th scope="col">Name</th>
				<th scope="col">Guess (UK time)</th>
				<th scope="col">${final ? 'How close' : 'Status'}</th>
				<th scope="col">Via</th>
			</tr>
		</thead>
		<tbody>
			${board.entries.map(
				(e) => html`<tr class="${e.verdict === 'winner' ? 'fun-winner' : e.verdict === 'eliminated' ? 'fun-out' : ''}">
				<td class="mono">${e.rank}</td>
				<td>${e.name}</td>
				<td><time datetime="${e.guessAt}">${formatLondon(e.guessAt)}</time></td>
				<td>${e.verdict === 'in-the-running' ? html`<span class="badge badge-yes">${e.label}</span>` : e.verdict === 'eliminated' ? html`<span class="badge badge-no">${e.label}</span>` : e.label}</td>
				<td><span title="${e.source === 'email' ? 'By email' : 'On the website'}">${e.source === 'email' ? '✉️' : '🌐'}</span><span class="fun-sr">${e.source === 'email' ? 'email' : 'web'}</span></td>
			</tr>`,
			)}
		</tbody>
	</table>
</div>`;
}

function poolForm(c: Ctx, state: SiteState, values: PoolFormValues) {
	const now = nowIso();
	const window = guessWindow(state, now);
	const minLocal = toLondonLocalInput(new Date(Date.parse(now) + 60_000).toISOString());
	const min = window.startDate && `${window.startDate}T00:00` > minLocal ? `${window.startDate}T00:00` : minLocal;
	const max = window.endDate ? `${window.endDate}T23:59` : toLondonLocalInput(window.notAfter);
	if (min > max) {
		const closed = window.endDate ? formatLondonDate(window.endDate) : formatLondon(window.notAfter);
		return html`<p>The guessing window closed on ${closed} without a dad, which is frankly impressive. The pool reopens if the due date is updated.</p>`;
	}
	return html`<form class="form stack" method="post" action="/pool">
	<div class="field">
		<label for="pool-name">Your name</label>
		<input id="pool-name" name="name" type="text" required maxlength="${NAME_MAX_LENGTH}" autocomplete="nickname" value="${values.name}" aria-describedby="pool-name-hint">
		<p class="hint" id="pool-name-hint">Shown publicly on the leaderboard. A first name or a nickname is plenty.</p>
	</div>
	<div class="field">
		<label for="pool-guess">The moment Zack becomes a dad</label>
		<input id="pool-guess" name="guess" type="datetime-local" required step="60" min="${min}" max="${max}" value="${values.guess}" aria-describedby="pool-guess-hint">
		<p class="hint" id="pool-guess-hint">UK time (Europe/London, so GMT or BST as appropriate). Guesses must be ${window.description}.</p>
	</div>
	${turnstileWidget(c.env)}
	<div class="fun-actions"><button class="btn btn-primary" type="submit">Lodge my guess</button></div>
</form>`;
}

async function renderPoolPage(c: Ctx, opts: { notice?: PoolNotice; values?: PoolFormValues; status?: number } = {}): Promise<Response> {
	const state = c.get('state');
	const now = nowIso();
	const today = londonDate();
	let guesses: GuessRecord[] = [];
	let loadError = false;
	try {
		guesses = await listGuesses(c.env);
	} catch (err) {
		console.error('pool: listGuesses failed:', err);
		loadError = true;
	}
	const board = buildLeaderboard(guesses, state, now);
	const median = medianGuess(guesses);
	const open = state.status !== 'yes';
	const winner = board.winners[0];
	const values = opts.values ?? { name: '', guess: '' };

	const body = html`<div class="wrap stack">
	<header class="page-head">
		<p class="kicker">The baby pool</p>
		<h1>When will Zack become a dad?</h1>
		<p class="lede">Guess the exact minute this site flips to YES. The closest guess wins eternal glory and absolutely nothing else.</p>
	</header>

	${opts.notice ? html`<div class="notice notice-${opts.notice.kind}" role="${opts.notice.kind === 'error' ? 'alert' : 'status'}">${opts.notice.text}</div>` : ''}
	${loadError ? html`<div class="notice notice-error" role="alert">The leaderboard is temporarily unavailable. Your guesses are safe; our ability to show them is not.</div>` : ''}

	${state.status === 'yes'
		? html`<div class="notice notice-ok" role="status">
			${winner
				? html`<p><strong>👑 ${winner.name} wins the pool</strong>, having guessed <time datetime="${winner.guessAt}">${formatLondon(winner.guessAt)}</time>: ${describeOffset(winner.offsetMs ?? 0)}.</p>`
				: html`<p><strong>Nobody entered the pool</strong>, so nobody won. Or everybody lost. Philosophers are divided.</p>`}
			<p class="tiny">Zack became a dad at <time datetime="${state.statusChangedAt}">${formatLondon(state.statusChangedAt)}</time> (UK time). The pool is now closed.</p>
		</div>`
		: ''}

	<section class="grid" aria-label="Enter the pool">
		<div class="card stack">
			<h2 class="card-title">${open ? 'Place your guess' : 'The pool is closed'}</h2>
			${open
				? poolForm(c, state, values)
				: html`<p>Zack is a dad, so the question has been answered. Please direct further guesses to the next baby.</p>`}
		</div>
		<div class="card stack">
			<h2 class="card-title">The rules</h2>
			<ul class="stack fun-rules">
				<li>Guess the minute ${DAD} becomes a dad, in UK time. Closest wins; ties go to whoever guessed first.</li>
				<li>${state.dueDate
					? html`Guesses must fall between 60 days before and 30 days after the due date (${formatLondonDate(state.dueDate)}).`
					: html`No due date is on file, so guesses must fall within the next 120 days.`}</li>
				<li>Up to ${MAX_GUESSES_PER_PERSON} guesses per name, and a sensible limit per connection. Spreading your bets is allowed; carpet-bombing the calendar is not.</li>
				<li>The pool closes the instant the answer becomes YES. The site's clock is final; appeals will be read aloud and laughed at.</li>
			</ul>
		</div>
		<div class="card stack">
			<h2 class="card-title">Enter by email</h2>
			<p>Prefer email? Send one to <a href="mailto:ask@${DOMAIN}?subject=guess">ask@${DOMAIN}</a> with <strong>guess</strong> in the subject and something like this in the body:</p>
			<pre class="code">14 Nov 15:30
Name: Alex</pre>
			<p class="hint">Dates like "14/11 3pm", "2026-11-14 15:30" and "November 14 at 3:30pm" also work. UK time, British date order. No year means the next one. A robot replies to confirm.</p>
		</div>
	</section>

	<section class="section stack" aria-labelledby="pool-crowd">
		<h2 id="pool-crowd">The wisdom of the crowd</h2>
		<div class="stats">
			<div class="stat"><span class="stat-value">${formatNumber(guesses.length)}</span><span class="stat-label">${guesses.length === 1 ? 'guess' : 'guesses'}</span></div>
			${board.mode === 'open'
				? html`<div class="stat"><span class="stat-value">${formatNumber(board.inTheRunning)}</span><span class="stat-label">still in the running</span></div>
				<div class="stat"><span class="stat-value">${formatNumber(board.eliminated)}</span><span class="stat-label">eliminated by the passage of time</span></div>`
				: ''}
			${median
				? html`<div class="stat"><span class="stat-value"><time datetime="${median}">${formatLondon(median, { weekday: undefined, year: undefined })}</time></span><span class="stat-label">median guess</span></div>`
				: ''}
		</div>
		${histogramFigure(guesses, state, today)}
	</section>

	<section class="section stack" id="leaderboard" aria-labelledby="pool-leaderboard">
		<h2 id="pool-leaderboard">${board.mode === 'final' ? 'Final standings' : 'Leaderboard'}</h2>
		${leaderboardTable(board)}
		<p class="tiny muted">Times are UK time. Moderated guesses are not shown.</p>
	</section>
</div>`;

	return renderPage(c, {
		title: 'The baby pool',
		description: 'Guess the minute Zack becomes a dad. Closest guess wins glory and nothing else.',
		body,
		head: funHead(),
		turnstile: open,
		path: '/pool',
		status: opts.status,
	});
}

funRoutes.get('/pool', async (c) => {
	if (wantsJson(c)) {
		const state = c.get('state');
		try {
			const guesses = await listGuesses(c.env);
			const board = buildLeaderboard(guesses, state, nowIso());
			return c.json({
				open: state.status !== 'yes',
				mode: board.mode,
				window: state.status === 'yes' ? null : guessWindow(state, nowIso()),
				winner: board.winners[0] ? { name: board.winners[0].name, guessAt: board.winners[0].guessAt, offsetMs: board.winners[0].offsetMs } : null,
				guesses: board.entries.map((e) => ({ rank: e.rank, name: e.name, guessAt: e.guessAt, verdict: e.verdict, source: e.source, offsetMs: e.offsetMs })),
			});
		} catch (err) {
			console.error('pool: json failed:', err);
			return c.json({ error: 'The pool is temporarily unavailable.' }, 503);
		}
	}
	return renderPoolPage(c);
});

funRoutes.post('/pool', async (c) => {
	const json = wantsJson(c);
	const ip = clientIp(c);
	const fail = (status: 400 | 403 | 409 | 429 | 503, error: string, values?: PoolFormValues) =>
		json ? c.json({ ok: false, error }, status) : renderPoolPage(c, { notice: { kind: 'error', text: error }, values, status });

	if (!(await allow(c.env.RL_FORMS, `pool:${clientKey(c)}`))) {
		return fail(429, 'Steady on. That is a lot of guessing in one minute. Try again shortly.');
	}
	const body = await readBody(c);
	if (!body) return fail(400, 'That form arrived in pieces. Please try again.');
	const values: PoolFormValues = { name: str(body, 'name', 200), guess: str(body, 'guess', 40) };

	if (!(await verifyTurnstile(c.env, body['cf-turnstile-response'], ip))) {
		return fail(403, 'The robot check did not pass. Please try again (humans only, babies excepted).', values);
	}

	let guessAt: string;
	const isoField = str(body, 'guessAt', 40);
	if (isoField && !values.guess) {
		guessAt = isoField;
	} else {
		const parsed = parseLondonLocalInput(values.guess);
		if ('error' in parsed) return fail(400, parsed.error, values);
		guessAt = parsed.iso;
	}

	let ipHash: string | null = null;
	try {
		ipHash = await hashIdentifier(c.env, clientKey(c));
	} catch (err) {
		console.error('pool: hashIdentifier failed:', err);
		return fail(503, 'The pool is having a moment. Please try again shortly.', values);
	}

	const result = await submitGuess(c.env, { name: values.name, guessAt, source: 'web', ipHash });
	if (!result.ok) {
		const status = result.code === 'closed' ? 409 : result.code === 'limit' ? 429 : result.code === 'unavailable' ? 503 : 400;
		return fail(status, result.error, values);
	}

	const savedAt = new Date(Date.parse(guessAt)).toISOString();
	if (json) return c.json({ ok: true, id: result.id, name: normaliseName(values.name), guessAt: savedAt }, 201);

	const body2 = html`<div class="wrap stack">
	<header class="page-head">
		<p class="kicker">The baby pool</p>
		<h1>Guess lodged 🎟️</h1>
		<p class="lede">You've backed <strong><time datetime="${savedAt}">${formatLondon(savedAt)}</time></strong> (UK time).</p>
	</header>
	<div class="notice notice-ok" role="status">
		Your guess is in. If ${DAD} becomes a dad closer to that minute than anyone else's guess, you win. Prize: bragging rights, non-transferable, no cash alternative.
	</div>
	<div class="fun-actions">
		<a class="btn btn-primary" href="/pool#leaderboard">See the leaderboard</a>
		<a class="btn btn-ghost" href="/everything">Get told the moment it happens</a>
	</div>
</div>`;
	return renderPage(c, { title: 'Guess lodged', body: body2, path: '/pool', noindex: true });
});

// ─── /status ─────────────────────────────────────────────────────────────────

const BADGE_FOR_HEALTH: Record<Health, string> = {
	operational: 'badge-yes',
	degraded: 'badge-soon',
	partial: 'badge-soon',
	maintenance: 'badge-soon',
	major: 'badge-no',
};

const BADGE_FOR_PHASE: Record<IncidentPhase, string> = {
	investigating: 'badge-no',
	identified: 'badge-soon',
	monitoring: 'badge-soon',
	resolved: 'badge-yes',
};

interface UptimeRow {
	name: string;
	summary: string;
	days: Array<{ date: string; health: Health | null }>;
}

function overallBanner(status: Status): { kind: 'ok' | 'error'; title: string; detail: string; indicator: 'none' | 'minor' | 'major' } {
	if (status === 'yes') {
		return {
			kind: 'ok',
			title: 'All important systems operational',
			detail: 'Zack is a dad. Sleep remains down, which is expected and, we are told, worth it.',
			indicator: 'minor',
		};
	}
	if (status === 'soon') {
		return {
			kind: 'error',
			title: 'Incident in progress: labour has started',
			detail: 'A fix is being deployed. Please stand by, and please do not text.',
			indicator: 'minor',
		};
	}
	return {
		kind: 'error',
		title: 'Major outage: Zack is not a dad',
		detail: 'Engineers are aware. A resolution is expected around the due date, give or take a fortnight.',
		indicator: 'major',
	};
}

function uptimeRows(days: DayStatus[], history: Array<{ status: Status; at: string }>, dueDate: string | null, now: string): UptimeRow[] {
	const dayHealth = (fn: (status: Status, date: string) => Health) =>
		days.map((d) => ({ date: d.date, health: d.status === null ? null : fn(d.status, d.date) }));
	const dayFraction = (rows: Array<{ health: Health | null }>) => {
		const known = rows.filter((r) => r.health !== null);
		return known.length ? known.filter((r) => r.health === 'operational').length / known.length : null;
	};

	const dad = dayHealth((s) => (s === 'yes' ? 'operational' : s === 'soon' ? 'degraded' : 'major'));
	const sleep = dayHealth((s) => (s === 'yes' ? 'major' : 'operational'));
	const patience = dayHealth((s, date) => patienceHealth(s, dueDate, date));
	const nappies = dayHealth(() => 'operational');
	return [
		{ name: 'Dad Service', summary: `${formatPercent(uptimeFraction(history, now, ['yes']))} dad`, days: dad },
		{ name: 'Sleep', summary: `${formatPercent(uptimeFraction(history, now, ['no', 'soon']))} slept`, days: sleep },
		{ name: 'Patience', summary: `${formatPercent(dayFraction(patience))} patient`, days: patience },
		{ name: 'Nappy Supply', summary: `${formatPercent(dayFraction(nappies))} stocked`, days: nappies },
	];
}

function uptimeBlock(row: UptimeRow) {
	const counts = new Map<string, number>();
	for (const d of row.days) {
		const key = d.health === null ? 'no data' : HEALTH_LABEL[d.health].toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const summary = [...counts.entries()].map(([k, n]) => `${plural(n, 'day')} ${k}`).join(', ');
	return html`<div class="fun-uptime">
	<div class="fun-uptime-head"><strong>${row.name}</strong><span class="muted">${row.summary}</span></div>
	<div class="bars" role="img" aria-label="${row.name}, last ${row.days.length} days: ${summary}">
		${row.days.map(
			(d) => html`<span class="bar ${healthBarClass(d.health)}" title="${shortDate(d.date)}: ${d.health === null ? 'no data (the site did not exist yet)' : HEALTH_LABEL[d.health]}"></span>`,
		)}
	</div>
	<div class="fun-bars-axis tiny muted" aria-hidden="true"><span>${row.days.length} days ago</span><span>Today</span></div>
</div>`;
}

function incidentCard(incident: Incident, now: string) {
	const latest = incident.updates[0];
	const phase: IncidentPhase = latest?.phase ?? 'investigating';
	const duration = incident.resolvedAt
		? `Resolved after ${describeDuration(Date.parse(incident.resolvedAt) - Date.parse(incident.startedAt))}.`
		: `Ongoing for ${describeDuration(Date.parse(now) - Date.parse(incident.startedAt))}.`;
	return html`<article class="card stack">
	<h3 class="card-title">${incident.title} <span class="badge ${BADGE_FOR_PHASE[phase]}">${PHASE_LABEL[phase]}</span></h3>
	<ol class="fun-incident-updates">
		${incident.updates.map(
			(u) => html`<li>
			<p><strong>${u.title}.</strong> ${u.body}</p>
			<p class="tiny muted"><time datetime="${u.at}">${formatLondon(u.at)}</time></p>
		</li>`,
		)}
	</ol>
	<p class="tiny muted">${duration}</p>
</article>`;
}

funRoutes.get('/status', async (c) => {
	const state = c.get('state');
	const now = nowIso();
	const today = londonDate();
	let history: Array<{ status: Status; at: string }> = [];
	try {
		history = await getStatusHistory(c.env);
	} catch (err) {
		console.error('status: history failed:', err);
	}
	// The history should always end at the current state; if it doesn't (e.g. a
	// read failed), fall back to what the site says right now.
	const lastEntry = history[history.length - 1];
	if (!lastEntry || lastEntry.status !== state.status) history = [...history, { status: state.status, at: state.statusChangedAt }];

	const components = statusComponents(state, today);
	const days = dailyStatuses(history, today, UPTIME_DAYS);
	const uptime = uptimeRows(days, history, state.dueDate, now);
	const incidents = buildIncidents(history);
	const banner = overallBanner(state.status);
	const forecast = dadForecast(state.dueDate, today, state.status);
	const size = state.status === 'yes' ? null : babySize(state.dueDate, today);

	if (wantsJson(c)) {
		return c.json({
			page: { name: 'Zack Status', url: `https://${DOMAIN}/status`, updatedAt: state.statusChangedAt },
			status: { indicator: banner.indicator, description: banner.title },
			components: components.map((x) => ({ name: x.name, status: x.health, label: x.label, description: x.note })),
			uptime: uptime.map((u) => ({ name: u.name, summary: u.summary, days: u.days })),
			incidents,
			forecast,
		});
	}

	const body = html`<div class="wrap stack">
	<header class="page-head">
		<p class="kicker">status.${DOMAIN}</p>
		<h1>Zack Status</h1>
		<p class="lede">Live operational status of Zack's migration to dadhood, with a 90-day uptime history and a full incident log, as is industry standard for this sort of thing.</p>
		<div class="fun-actions"><a class="btn btn-primary" href="/everything">Subscribe to updates</a><a class="btn btn-ghost" href="/">Just the answer</a></div>
	</header>

	<div class="notice notice-${banner.kind}" role="status">
		<p><strong>${banner.title}</strong></p>
		<p class="tiny">${banner.detail}</p>
	</div>

	<section class="card stack" aria-labelledby="status-components">
		<h2 class="card-title" id="status-components">Components</h2>
		<ul class="fun-components">
			${components.map(
				(x) => html`<li class="fun-component">
				<span class="fun-component-name">${x.name}</span>
				<span class="badge ${BADGE_FOR_HEALTH[x.health]}">${x.label}</span>
				<p class="fun-component-note tiny muted">${x.note}</p>
			</li>`,
			)}
		</ul>
	</section>

	<section class="card stack" aria-labelledby="status-uptime">
		<h2 class="card-title" id="status-uptime">Uptime, last ${UPTIME_DAYS} days</h2>
		${uptime.map(uptimeBlock)}
		<p class="tiny muted">Each bar is one day (UK time), coloured by status at the end of that day. Grey bars predate this website, a dark age about which little is known.</p>
	</section>

	${state.status !== 'yes'
		? html`<section class="card stack" aria-labelledby="status-maintenance">
		<h2 class="card-title" id="status-maintenance">Scheduled maintenance</h2>
		${state.dueDate
			? html`<p><strong>Dad deployment</strong>, expected <time datetime="${state.dueDate}">${formatLondonDate(state.dueDate)}</time>. The maintenance window runs roughly two weeks either side, and the exact start time is, by design, not under anyone's control.</p>`
			: html`<p><strong>Dad deployment</strong>, date to be confirmed. The change advisory board has yet to publish a due date.</p>`}
		${size
			? html`<p>Current payload size: about ${size.fruit} <span aria-hidden="true">${size.emoji}</span> <span class="muted">(${formatGestation(size)} weeks)</span>.</p>`
			: ''}
		<h3>Seven-day dad forecast</h3>
		<ul class="fun-forecast">
			${forecast.map(
				(f) => html`<li>
				<span class="tiny muted">${f.date === today ? 'Today' : shortDate(f.date)}</span>
				<span class="fun-forecast-emoji" aria-hidden="true">${f.emoji}</span>
				<span class="fun-forecast-pct">${f.label === NO_DUE_DATE.label ? '?' : percent(f.probability)}</span>
				<span class="tiny">${f.label}</span>
			</li>`,
			)}
		</ul>
		<p class="tiny muted">Chance of becoming a dad on each day, given it hasn't happened yet. Approximate model: birth timing is roughly normal around a day after the due date, with a standard deviation of about nine days, and induction by 42 weeks. Not medical advice; barely even maths.</p>
	</section>`
		: ''}

	<section class="stack" aria-labelledby="status-incidents">
		<h2 id="status-incidents">Incident history</h2>
		${incidents.length ? incidents.map((i) => incidentCard(i, now)) : html`<p class="empty">No incidents. Suspiciously quiet.</p>`}
	</section>

	<p class="muted">Want to know the moment this page goes green? <a href="/everything">Subscribe to updates</a> by email, push, webhook, RSS or carrier pigeon (pigeon support pending).</p>
</div>`;

	return renderPage(c, {
		title: 'Zack Status',
		description: `${banner.title}. Live status, 90-day uptime and incident history for Zack's dadhood.`,
		body,
		head: funHead(),
		path: '/status',
	});
});

// ─── /certificate ────────────────────────────────────────────────────────────

const CERT_CSS = `
@page{size:A4 landscape;margin:8mm}
.fun-print-bar{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;justify-content:center;align-items:center;padding:1rem;text-align:center}
.fun-cert-page{padding:0 1rem 2rem;display:grid;justify-items:center}
.fun-cert{position:relative;box-sizing:border-box;width:min(100%,64rem);aspect-ratio:297/210;padding:clamp(.6rem,2.2vw,1.4rem);background:#fffaf0;color:#2b2118;
 font-family:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Times New Roman",serif;
 border:clamp(5px,1vw,10px) double #8a6a1f;box-shadow:0 0 0 clamp(3px,.5vw,6px) #fffaf0,0 0 0 clamp(4px,.65vw,8px) #8a6a1f,0 12px 32px rgba(0,0,0,.25);
 overflow:hidden;container-type:inline-size;print-color-adjust:exact;-webkit-print-color-adjust:exact}
.fun-cert-inner{position:relative;box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:space-between;gap:.4em;text-align:center;
 padding:clamp(.8rem,3.5cqi,2.5rem) clamp(1rem,6cqi,4rem);border:2px solid #b8963e;outline:1px solid #b8963e;outline-offset:-7px;
 background:radial-gradient(ellipse at center,rgba(184,150,62,.10),transparent 70%),repeating-linear-gradient(45deg,rgba(138,106,31,.035) 0 2px,transparent 2px 9px)}
.fun-cert-corner{position:absolute;font-size:clamp(1.2rem,4.5cqi,2.6rem);line-height:1;color:#8a6a1f}
.fun-cert-corner.tl{top:.35em;left:.45em}.fun-cert-corner.tr{top:.35em;right:.45em;transform:scaleX(-1)}
.fun-cert-corner.bl{bottom:.35em;left:.45em;transform:scaleY(-1)}.fun-cert-corner.br{bottom:.35em;right:.45em;transform:scale(-1,-1)}
.fun-cert p{margin:0}
.fun-cert-kicker{font-size:clamp(.6rem,1.6cqi,.95rem);letter-spacing:.35em;text-transform:uppercase;color:#6b5420}
.fun-cert-title{margin:0;font-family:inherit;font-stretch:normal;text-wrap:balance;font-size:clamp(1.5rem,6.2cqi,3.8rem);font-weight:700;font-variant:small-caps;letter-spacing:.05em;color:#3b2a10;line-height:1.05}
.fun-cert-rule{width:40%;height:0;border:0;border-top:1px solid #b8963e;margin:.1em auto}
.fun-cert-text{font-size:clamp(.75rem,2.1cqi,1.2rem);font-style:italic;max-width:46em;line-height:1.35}
.fun-cert-name{font-size:clamp(2rem,8cqi,5rem);font-style:italic;line-height:1;color:#1f160b;border-bottom:1px solid #b8963e;padding:0 .6em .05em}
.fun-cert-rank{font-size:clamp(1.2rem,4.5cqi,2.8rem);font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:#7a1f14}
.fun-cert-meta{font-size:clamp(.55rem,1.35cqi,.8rem);color:#6b5420;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.fun-cert-foot{display:grid;grid-template-columns:1fr auto 1fr;align-items:end;gap:clamp(.5rem,3cqi,2rem);width:100%}
.fun-cert-sig{display:grid;gap:.15em;font-size:clamp(.55rem,1.5cqi,.9rem);color:#4a3a1c}
.fun-cert-sig b{font-family:"Snell Roundhand","Apple Chancery","Segoe Script","Brush Script MT",cursive;font-weight:400;font-size:clamp(1.1rem,3.6cqi,2.2rem);color:#1d2a5b;border-bottom:1px solid #2b2118;padding:0 .5em}
.fun-cert-seal{display:grid;place-items:center;width:clamp(4.2rem,13cqi,8.5rem);aspect-ratio:1;border-radius:50%;color:#fff3d6;text-align:center;
 background:radial-gradient(circle closest-side,#b42318 0 70%,rgba(255,243,214,.6) 71% 72%,#b42318 73% 82%,transparent 83%),repeating-conic-gradient(#8f1d14 0 5deg,#c0392b 5deg 10deg);
 box-shadow:0 2px 6px rgba(0,0,0,.3)}
.fun-cert-seal span{font:700 clamp(.42rem,1.25cqi,.75rem)/1.15 Georgia,serif;letter-spacing:.12em;text-transform:uppercase}
.fun-cert-seal strong{display:block;font-size:2.1em;letter-spacing:.05em}
.fun-cert.is-provisional .fun-cert-seal{filter:grayscale(1);opacity:.55}
.fun-cert-watermark{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;z-index:2}
.fun-cert-watermark span{transform:rotate(-22deg);max-width:88%;padding:.3em .6em;border:.25em solid rgba(180,35,24,.3);border-radius:.3em;color:rgba(180,35,24,.3);
 font:800 clamp(1.1rem,5.4cqi,3.4rem)/1.1 system-ui,-apple-system,"Segoe UI",sans-serif;text-transform:uppercase;text-align:center;letter-spacing:.04em}
@media (max-width:40rem){.fun-cert{aspect-ratio:auto}.fun-cert-foot{grid-template-columns:1fr;justify-items:center}}
@media print{
 .fun-screen-only{display:none!important}
 html,body{background:#fff!important}
 .fun-cert-page{padding:0}
 .fun-cert{width:100%;height:calc(210mm - 16mm);aspect-ratio:auto;box-shadow:none;break-inside:avoid}
}
`;

/** "Friday 6 November 2026 at 21:40", for documents that take themselves seriously. */
function formalMoment(iso: string): string {
	const time = formatLondon(iso, { weekday: undefined, day: undefined, month: undefined, year: undefined });
	return `${formatLondonDate(iso)} at ${time}`;
}

async function certificateNumber(statusChangedAt: string): Promise<string> {
	const hex = (await sha256Hex(`certificate-of-dadhood:${statusChangedAt}`)).toUpperCase();
	return `DAD-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

async function dadhoodLedgerEntry(env: Env): Promise<LedgerEntry | null> {
	try {
		const entries = await getLedger(env, { limit: 100 });
		return [...entries].reverse().find((e) => e.status === 'yes') ?? null;
	} catch (err) {
		console.error('certificate: ledger lookup failed:', err);
		return null;
	}
}

function printBar(what: string) {
	return html`<div class="fun-print-bar fun-screen-only">
	<p><strong>Print this page (Ctrl/Cmd + P)</strong> for a ${what} suitable for framing, fridges or formal disputes.</p>
	<a href="/">Back to the answer</a>
</div>`;
}

funRoutes.get('/certificate', async (c) => {
	const state = c.get('state');
	const official = state.status === 'yes';
	const number = official ? await certificateNumber(state.statusChangedAt) : 'DAD-PENDING';
	const ledger = official ? await dadhoodLedgerEntry(c.env) : null;

	const body = html`${printBar('certificate')}
<div class="fun-cert-page">
	<article class="fun-cert${official ? '' : ' is-provisional'}" aria-label="Certificate of Dadhood${official ? '' : ' (provisional)'}">
		<div class="fun-cert-inner">
			<span class="fun-cert-corner tl" aria-hidden="true">❦</span><span class="fun-cert-corner tr" aria-hidden="true">❦</span>
			<span class="fun-cert-corner bl" aria-hidden="true">❦</span><span class="fun-cert-corner br" aria-hidden="true">❦</span>
			<p class="fun-cert-kicker">The Most Over-Engineered Registry of ${DOMAIN}</p>
			<h1 class="fun-cert-title">Certificate of Dadhood</h1>
			<hr class="fun-cert-rule">
			<p class="fun-cert-text">This is to certify that</p>
			<p class="fun-cert-name">${DAD}</p>
			<p class="fun-cert-text">${official
				? html`has been formally, officially and irrevocably promoted to the rank of`
				: html`is expected, in due course, to be promoted to the rank of`}</p>
			<p class="fun-cert-rank">Dad</p>
			<p class="fun-cert-text">${official
				? html`with effect from <time datetime="${state.statusChangedAt}">${formalMoment(state.statusChangedAt)}</time> (UK time), together with all the rights, privileges, nappies and night feeds pertaining thereto.`
				: html`with effect from a date to be confirmed${state.dueDate ? html` (expected around ${formatLondonDate(state.dueDate)})` : ''}. Until then this certificate is provisional and confers no rights, privileges or nappies whatsoever.`}</p>
			<p class="fun-cert-meta">Certificate no. ${number}${ledger ? html` · Dad Ledger entry #${ledger.seq} · hash ${ledger.hash.slice(0, 16)}…` : ''}</p>
			<div class="fun-cert-foot">
				<div class="fun-cert-sig"><b>The Stork</b><span>Chief Delivery Officer</span></div>
				<div class="fun-cert-seal" aria-hidden="true"><span>Official<strong>DAD</strong>${official ? 'Certified' : 'Pending'}</span></div>
				<div class="fun-cert-sig"><b>Jess</b><span>Witness (did considerably more of the work)</span></div>
			</div>
		</div>
		${official ? '' : html`<div class="fun-cert-watermark"><span>PROVISIONAL — NOT VALID UNTIL THE BABY ARRIVES</span></div>`}
	</article>
</div>`;

	return renderPage(c, {
		title: 'Certificate of Dadhood',
		description: official ? `Zack has been a dad since ${formatLondon(state.statusChangedAt)}. Certified.` : 'A provisional Certificate of Dadhood, pending the arrival of the baby.',
		body,
		head: html`<style>${raw(CERT_CSS)}</style>`,
		bodyClass: 'printable',
		bare: true,
		path: '/certificate',
	});
});

// ─── /poster ─────────────────────────────────────────────────────────────────

const TEAR_OFF_STRIPS = 10;

const POSTER_CSS = `
@page{size:A4 portrait;margin:10mm}
.fun-print-bar{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;justify-content:center;align-items:center;padding:1rem;text-align:center}
.fun-poster-page{padding:0 1rem 2rem;display:grid;justify-items:center}
.fun-poster{box-sizing:border-box;width:min(100%,40rem);min-height:min(56rem,140vw);display:flex;flex-direction:column;align-items:center;text-align:center;
 background:#fff;color:#111;border:1px solid #d4d4d4;box-shadow:0 12px 32px rgba(0,0,0,.25);container-type:inline-size;print-color-adjust:exact;-webkit-print-color-adjust:exact;
 font-family:var(--font-display,"Arial Black","Helvetica Neue",Helvetica,Arial,sans-serif)}
.fun-poster *{box-sizing:border-box}
.fun-poster-flag{margin:0;width:100%;padding:.5em;font-weight:900;background:#111;color:#fff;font-size:clamp(.8rem,3.2cqi,1.35rem);letter-spacing:.3em;text-transform:uppercase}
.fun-poster-title{margin:.45em .3em .15em;font-family:inherit;font-weight:900;text-wrap:balance;font-size:clamp(2.4rem,14cqi,6rem);line-height:.92;letter-spacing:-.02em;text-transform:uppercase}
.fun-poster-qr{width:min(76%,24rem);aspect-ratio:1;margin:.5rem auto}
.fun-poster-qr svg{display:block;width:100%;height:100%}
.fun-poster-cta{margin:.1em .3em;font-weight:900;font-size:clamp(1.4rem,7.5cqi,3.2rem);line-height:1;text-transform:uppercase}
.fun-poster-sub{margin:.6em 1.5em 0;font:600 clamp(.8rem,2.8cqi,1.1rem)/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:32em}
.fun-poster-reward{margin:.9em 1em 1.2em;font-weight:800;padding:.35em .8em;border:3px solid #111;font-size:clamp(.8rem,3cqi,1.2rem);text-transform:uppercase;transform:rotate(-2deg)}
.fun-poster-cut{margin:auto 0 0;width:100%;padding:.25em .75em;text-align:left;font:600 clamp(.6rem,2cqi,.8rem) system-ui,sans-serif;color:#555}
.fun-strips{display:flex;width:100%;border-top:2px dashed #111}
.fun-strip{flex:1 1 0;min-width:0;overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:clamp(7rem,30cqi,11rem);padding:.6rem .15rem;border-left:2px dashed #111}
.fun-strip:first-child{border-left:0}
.fun-strip span{writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;font:700 clamp(.55rem,2.3cqw,.95rem)/1.15 system-ui,-apple-system,"Segoe UI",sans-serif}
.fun-strip small{display:block;font-weight:500;opacity:.8}
@media print{
 .fun-screen-only{display:none!important}
 html,body{background:#fff!important}
 .fun-poster-page{padding:0}
 .fun-poster{width:100%;height:calc(297mm - 20mm);min-height:0;border:0;box-shadow:none;break-inside:avoid}
 .fun-poster-flag{font-size:12pt}
 .fun-poster-title{font-size:56pt;margin:8mm 4mm 2mm}
 .fun-poster-qr{width:112mm;margin:2mm auto}
 .fun-poster-cta{font-size:30pt}
 .fun-poster-sub{font-size:11pt;margin-top:3mm}
 .fun-poster-reward{font-size:11pt;margin:4mm}
 .fun-strip{min-height:44mm}
 .fun-strip span{font-size:9pt}
}
`;

// The QR code (POSTER_QR_SVG) is made at build time by scripts/poster-qr.ts: it never changes,
// and encoding it tries eight masks, about 3 ms of CPU on every cold isolate.
funRoutes.get('/poster', (c) => {
	const strips = Array.from(
		{ length: TEAR_OFF_STRIPS },
		() => html`<div class="fun-strip"><span>${DOMAIN}<small>Is Zack a dad?</small></span></div>`,
	);
	const body = html`${printBar('poster')}
<div class="fun-poster-page">
	<article class="fun-poster" aria-label="Fridge poster">
		<p class="fun-poster-flag">Public information notice</p>
		<h1 class="fun-poster-title">Is Zack a dad?</h1>
		<div class="fun-poster-qr">${raw(POSTER_QR_SVG)}</div>
		<p class="fun-poster-cta">Scan to find out</p>
		<p class="fun-poster-sub">Or visit ${DOMAIN}. Answers 24 hours a day. Updated the moment it happens. No app required. Fridge-safe.</p>
		<p class="fun-poster-reward">Reward: the smug feeling of knowing first</p>
		<p class="fun-poster-cut" aria-hidden="true">✂ Please take one</p>
		<div class="fun-strips" aria-hidden="true">${strips}</div>
	</article>
</div>`;
	return renderPage(c, {
		title: 'Fridge poster',
		description: 'A printable fridge poster with a QR code that answers the question.',
		body,
		head: html`<style>${raw(POSTER_CSS)}</style>`,
		bodyClass: 'printable',
		bare: true,
		path: '/poster',
	});
});

// ─── /admin/pool ─────────────────────────────────────────────────────────────

funRoutes.use('/admin/pool', requireAdmin);
funRoutes.use('/admin/pool/*', requireAdmin);

const ADMIN_NOTICES: Record<string, PoolNotice> = {
	hidden: { kind: 'ok', text: 'Guess hidden. It no longer appears on the public leaderboard.' },
	shown: { kind: 'ok', text: 'Guess restored to the public leaderboard.' },
	missing: { kind: 'error', text: 'No such guess.' },
	forbidden: { kind: 'error', text: 'That request did not come from this site, so it was ignored.' },
};

funRoutes.get('/admin/pool', async (c) => {
	const state = c.get('state');
	let guesses: GuessRecord[] = [];
	let failed = false;
	try {
		guesses = await listGuesses(c.env, { includeHidden: true });
	} catch (err) {
		console.error('admin pool: list failed:', err);
		failed = true;
	}
	const board = buildLeaderboard(guesses, state, nowIso());
	const rankById = new Map(board.entries.map((e) => [e.id, e]));
	const hiddenCount = guesses.filter((g) => g.hidden).length;
	const notice = ADMIN_NOTICES[c.req.query('done') ?? ''];
	const sorted = state.status === 'yes' ? [...guesses].sort((a, b) => (rankById.get(a.id)?.rank ?? Infinity) - (rankById.get(b.id)?.rank ?? Infinity)) : guesses;

	const body = html`<div class="wrap stack">
	<header class="page-head">
		<p class="kicker">Admin</p>
		<h1>Baby pool</h1>
		<p class="lede">Every guess, including hidden ones. Hide anything rude, spammy or suspiciously like a real name someone didn't consent to.</p>
	</header>
	${notice ? html`<div class="notice notice-${notice.kind}" role="status">${notice.text}</div>` : ''}
	${failed ? html`<div class="notice notice-error" role="alert">Could not load guesses from the database.</div>` : ''}
	<div class="stats">
		<div class="stat"><span class="stat-value">${guesses.length}</span><span class="stat-label">total</span></div>
		<div class="stat"><span class="stat-value">${guesses.length - hiddenCount}</span><span class="stat-label">public</span></div>
		<div class="stat"><span class="stat-value">${hiddenCount}</span><span class="stat-label">hidden</span></div>
	</div>
	${guesses.length === 0
		? html`<p class="empty">No guesses yet.</p>`
		: html`<div class="table-wrap"><table class="table">
		<thead><tr><th scope="col">ID</th><th scope="col">Name</th><th scope="col">Guess (UK time)</th><th scope="col">Standing</th><th scope="col">Via</th><th scope="col">Entered</th><th scope="col">Visibility</th></tr></thead>
		<tbody>
			${sorted.map((g) => {
				const entry = rankById.get(g.id);
				return html`<tr class="${g.hidden ? 'fun-out' : ''}">
				<td class="mono">${g.id}</td>
				<td>${g.name}</td>
				<td><time datetime="${g.guessAt}">${formatLondon(g.guessAt)}</time></td>
				<td>${entry ? (board.mode === 'final' ? `#${entry.rank}: ${entry.label}` : entry.label) : html`<span class="muted">hidden</span>`}</td>
				<td>${g.source}</td>
				<td class="tiny"><time datetime="${g.createdAt}">${formatLondon(g.createdAt)}</time></td>
				<td>
					<form class="fun-inline-form" method="post" action="/admin/pool/${g.id}/${g.hidden ? 'unhide' : 'hide'}">
						<button class="btn ${g.hidden ? 'btn-ghost' : 'btn-danger'}" type="submit" aria-label="${g.hidden ? 'Unhide' : 'Hide'} guess #${g.id} by ${g.name}">${g.hidden ? 'Unhide' : 'Hide'}</button>
					</form>
				</td>
			</tr>`;
			})}
		</tbody>
	</table></div>`}
	<p><a href="/pool">View the public pool</a> · <a href="/admin">Back to admin</a></p>
</div>`;
	return renderAdminPage(c, { title: 'Baby pool', body });
});

async function moderate(c: Ctx, hidden: boolean): Promise<Response> {
	const json = wantsJson(c);
	if (!sameOrigin(c)) {
		return json ? c.json({ ok: false, error: 'Cross-site request refused.' }, 403) : c.redirect('/admin/pool?done=forbidden', 303);
	}
	const id = Number(c.req.param('id'));
	let changed = false;
	try {
		changed = await setGuessHidden(c.env, id, hidden);
	} catch (err) {
		console.error('admin pool: moderate failed:', err);
		return json ? c.json({ ok: false, error: 'Database error.' }, 500) : c.redirect('/admin/pool?done=missing', 303);
	}
	if (json) return changed ? c.json({ ok: true, id, hidden }) : c.json({ ok: false, error: 'No such guess.' }, 404);
	return c.redirect(`/admin/pool?done=${changed ? (hidden ? 'hidden' : 'shown') : 'missing'}`, 303);
}

funRoutes.post('/admin/pool/:id/hide', (c) => moderate(c, true));
funRoutes.post('/admin/pool/:id/unhide', (c) => moderate(c, false));

/** Exported for anyone who wants the status page's headline without the HTML. */
export { overallBanner };
