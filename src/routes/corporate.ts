// OWNER: corporate agent (pages & game). Mounted in src/index.ts.
//
//   /press, /privacy, /terms           the corporate pages (content in lib/corporate.ts)
//   POST /pigeon, /smoke-signal, /fax  joke notification methods from /everything. They store
//                                      nothing, log nothing and don't even read the form: the
//                                      body is never parsed. Rate-limited anyway. No Turnstile:
//                                      nothing is written, and three more challenge frames on
//                                      /everything would cost every visitor for a joke.
//   /stork                             Catch the Stork (public/stork.js) and its leaderboard
//   POST /api/stork/start              a signed game token
//   POST /api/stork/score              a high score (RL_FORMS, Turnstile, token, plausibility, cap)
//   GET  /api/stork/scores             the top 10, cached for about 30 s

import type { Context } from 'hono';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { boilerplate, pressBody, privacyBody, termsBody } from '../lib/corporate';
import { renderPage, type Html } from '../lib/layout';
import { emailDailyLimit } from '../notify/email';
import { allow, clientIp, clientKey, hashIdentifier, turnstileWidget, verifyTurnstile, wantsJson } from '../lib/security';
import { DAD, STATUS_COPY } from '../lib/site';
import {
	DAILY_SCORE_CAP,
	LEADERBOARD_TTL_MS,
	isRudeInitials,
	issueGameToken,
	maxPlausibleScore,
	normaliseInitials,
	parseScore,
	submitScore,
	topScores,
	verifyGameToken,
	type ScoreEntry,
} from '../lib/stork';
import { formatLondon, formatNumber } from '../lib/time';
import type { AppEnv } from '../types';

type Ctx = Context<AppEnv>;

export const corporateRoutes = new Hono<AppEnv>();

const CORP_CSS = html`<link rel="stylesheet" href="/corporate.css">`;

// ─── /press, /privacy, /terms ────────────────────────────────────────────────

corporateRoutes.get('/press', (c) => {
	const status = c.get('state').status;
	return renderPage(c, {
		title: 'Press kit',
		description: `Brand guidelines, logos, colours and downloads. ${boilerplate(status).split('. ')[0]}.`,
		path: '/press',
		head: CORP_CSS,
		body: pressBody(status),
	});
});

corporateRoutes.get('/privacy', (c) =>
	renderPage(c, {
		title: 'Privacy policy',
		description: 'Exactly what this website stores about you, for how long, and how to get rid of it. It is not much.',
		path: '/privacy',
		head: CORP_CSS,
		body: privacyBody(),
	}),
);

corporateRoutes.get('/terms', (c) =>
	renderPage(c, {
		title: 'Terms of service',
		description: `By using this website you agree that ${DAD} is not a dad, until ${DAD} is.`,
		path: '/terms',
		head: CORP_CSS,
		body: termsBody(emailDailyLimit(c.env)),
	}),
);

// ─── Joke notification methods (/everything fragments + their result pages) ──

/** Method fragment for /everything: carrier pigeon. */
export function pigeonForm(): Html {
	return html`<form class="form stack" method="post" action="/pigeon">
		<div class="field">
			<label for="pigeon-to">Where should the pigeon go?</label>
			<input id="pigeon-to" name="to" type="text" maxlength="120" autocomplete="off" placeholder="A windowsill, a rooftop, a statue of someone important">
			<p class="hint">We won't write it down. The pigeon will have to remember.</p>
		</div>
		<div class="field">
			<label for="pigeon-class">Service level</label>
			<select id="pigeon-class" name="class">
				<option>Second class (any available pigeon)</option>
				<option>First class (a confident pigeon)</option>
				<option>Racing pigeon (extra seed, no guarantees)</option>
			</select>
		</div>
		<p><button class="btn btn-primary" type="submit">Dispatch a pigeon</button></p>
	</form>`;
}

/** Method fragment for /everything: smoke signal. */
export function smokeSignalForm(): Html {
	return html`<form class="form stack" method="post" action="/smoke-signal">
		<p class="hint">One small, controlled fire on a nearby hill, visible for miles in clear weather. Not available in rain, wind, smoke-control zones or most of the British summer.</p>
		<p><button class="btn btn-primary" type="submit">Light the fire</button></p>
	</form>`;
}

/** Method fragment for /everything: fax. */
export function faxForm(): Html {
	return html`<form class="form stack" method="post" action="/fax">
		<div class="field">
			<label for="fax-number">Your fax number</label>
			<input id="fax-number" name="fax" type="tel" inputmode="tel" maxlength="40" autocomplete="off" placeholder="01632 960000">
			<p class="hint">Group 3 compatible machines only. Please ensure the paper roll is loaded.</p>
		</div>
		<p><button class="btn btn-primary" type="submit">Send my fax number</button></p>
	</form>`;
}

type JokeMethod = 'pigeon' | 'smoke-signal' | 'fax';

/** A random reference in the house style, e.g. PGN-4F2A-91C0. Never derived from the request. */
function reference(prefix: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(4));
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
	return `${prefix}-${hex.slice(0, 4)}-${hex.slice(4)}`;
}

const NOT_STORED = 'Nothing you typed was read, stored or logged. The form went straight in the bin, unopened.';

async function jokeLimited(c: Ctx, method: JokeMethod): Promise<Response | null> {
	if (await allow(c.env.RL_FORMS, `${method}:${clientKey(c)}`)) return null;
	const error = 'That is a lot of dispatching for one minute. The loft needs a breather. Try again shortly.';
	if (wantsJson(c)) return c.json({ ok: false, error }, 429);
	return renderPage(c, {
		title: 'Steady on',
		path: `/${method}`,
		noindex: true,
		status: 429,
		body: html`<div class="wrap section stack">
			<header class="page-head"><p class="kicker">Heritage channels</p><h1>Steady on</h1></header>
			<div class="notice notice-error" role="alert"><p>${error}</p></div>
			<p><a class="btn btn-ghost" href="/everything#${method}">Back to every possible way</a></p>
		</div>`,
	});
}

// A stray GET (a bookmarked result, a refresh after the POST) goes back to the method.
for (const method of ['pigeon', 'smoke-signal', 'fax'] as const) {
	corporateRoutes.get(`/${method}`, (c) => c.redirect(`/everything#${method}`, 303));
}

corporateRoutes.post('/pigeon', async (c) => {
	const limited = await jokeLimited(c, 'pigeon');
	if (limited) return limited;
	const tracking = reference('PGN');
	const word = STATUS_COPY[c.get('state').status].word;
	if (wantsJson(c)) return c.json({ ok: true, method: 'pigeon', tracking, carrying: word, eta: '3–5 business years', stored: false });
	return renderPage(c, {
		title: 'Pigeon dispatched',
		path: '/pigeon',
		noindex: true,
		head: CORP_CSS,
		body: html`<div class="wrap section stack-lg corp joke">
			<header class="page-head">
				<p class="kicker">Carrier pigeon · tracking ${tracking}</p>
				<h1>Pigeon dispatched 🕊️</h1>
				<p class="lede">ETA 3–5 business years.</p>
			</header>
			<ol class="timeline">
				<li class="timeline-item card"><p class="kicker">Just now</p><p>Pigeon selected for temperament and general sense of direction.</p></li>
				<li class="timeline-item card"><p class="kicker">Just now</p><p>Message attached to leg. It reads, in full: <strong>${word}</strong>. If the answer changes in transit, the pigeon will not be told.</p></li>
				<li class="timeline-item card"><p class="kicker">Shortly</p><p>Pigeon distracted by chips (estimated).</p></li>
				<li class="timeline-item card"><p class="kicker">3–5 business years</p><p>Arrival. Business years exclude weekends, bank holidays and moulting season.</p></li>
			</ol>
			<div class="notice notice-ok" role="status"><p>${NOT_STORED} The destination is between you and the pigeon.</p></div>
			<p class="cluster"><a class="btn btn-primary" href="/everything#email">Get something faster</a> <a class="btn btn-ghost" href="/everything#pigeon">Dispatch another</a></p>
		</div>`,
	});
});

const PUFF_CODE = {
	no: 'one long, disappointed puff',
	soon: 'two short puffs, urgently, then a lot of waving',
	yes: 'three puffs and a small cheer',
} as const;

corporateRoutes.post('/smoke-signal', async (c) => {
	const limited = await jokeLimited(c, 'smoke-signal');
	if (limited) return limited;
	const status = c.get('state').status;
	const word = STATUS_COPY[status].word;
	if (wantsJson(c)) return c.json({ ok: true, method: 'smoke-signal', signal: word, code: PUFF_CODE[status], stored: false });
	return renderPage(c, {
		title: 'Smoke signal sent',
		path: '/smoke-signal',
		noindex: true,
		head: CORP_CSS,
		body: html`<div class="wrap section stack-lg corp joke">
			<header class="page-head">
				<p class="kicker">Smoke signal · ${reference('SMK')}</p>
				<h1>Signal sent</h1>
				<p class="lede">The message reads <strong>${word}</strong>: ${PUFF_CODE[status]}.</p>
			</header>
			<figure class="smoke-scene" aria-labelledby="smoke-caption">
				<div class="smoke-stage" aria-hidden="true">
					${[0, 1, 2, 3, 4, 5].map((i) => html`<span class="smoke-puff" style="--i:${i}"></span>`)}
					<span class="smoke-hill"></span>
					<span class="smoke-fire"><span class="smoke-log smoke-log-a"></span><span class="smoke-log smoke-log-b"></span><span class="smoke-flame"></span></span>
				</div>
				<figcaption id="smoke-caption" class="tiny muted">A small, responsible fire, signalling ${word} to anyone on a nearby hill who happens to be looking.</figcaption>
			</figure>
			<div class="notice notice-ok" role="status"><p>Visible for up to 20 miles, weather permitting. There was nothing to type, and we kept none of it.</p></div>
			<p class="cluster"><a class="btn btn-primary" href="/everything#push">Get something with fewer emissions</a> <a class="btn btn-ghost" href="/everything#smoke-signal">Back to the hill</a></p>
		</div>`,
	});
});

corporateRoutes.post('/fax', async (c) => {
	const limited = await jokeLimited(c, 'fax');
	if (limited) return limited;
	const word = STATUS_COPY[c.get('state').status].word;
	if (wantsJson(c)) return c.json({ ok: true, method: 'fax', instruction: 'Please send your fax number to 1997.', stored: false });
	return renderPage(c, {
		title: 'Fax received',
		path: '/fax',
		noindex: true,
		head: CORP_CSS,
		body: html`<div class="wrap section stack-lg corp joke">
			<header class="page-head">
				<p class="kicker">Fax · ${reference('FAX')}</p>
				<h1>Please send your fax number to 1997.</h1>
				<p class="lede">That's where the fax machines are. This website only goes back as far as 2026.</p>
			</header>
			<div class="fax-sheet" role="img" aria-label="A fax cover sheet addressed to 1997, saying the answer is ${word}">
				<p class="fax-banner" aria-hidden="true">FAX TRANSMISSION</p>
				<dl class="fax-fields" aria-hidden="true">
					<div><dt>To</dt><dd>1997</dd></div>
					<div><dt>From</dt><dd>iszacka.dad</dd></div>
					<div><dt>Pages</dt><dd>1 (including this one)</dd></div>
					<div><dt>Re</dt><dd>Is Zack a dad?</dd></div>
				</dl>
				<p class="fax-message" aria-hidden="true">${word}</p>
				<p class="fax-noise" aria-hidden="true">BEEEEEP ‑ krrrsshhhh ‑ bweeoo‑bweeoo ‑ ksshhhh</p>
			</div>
			<div class="notice notice-ok" role="status"><p>${NOT_STORED} Your number has not been faxed anywhere, including 1997.</p></div>
			<p class="cluster"><a class="btn btn-primary" href="/everything#email">Try email, the fax of today</a> <a class="btn btn-ghost" href="/everything#fax">Back</a></p>
		</div>`,
	});
});

// ─── Catch the Stork ─────────────────────────────────────────────────────────

const SCORE_BODY_MAX = 4096;

/** Form or JSON body as trimmed-to-length string fields; null if it's too big or unreadable. */
async function readScoreBody(c: Ctx): Promise<Record<string, string> | null> {
	const length = Number(c.req.header('content-length') ?? '0');
	if (Number.isFinite(length) && length > SCORE_BODY_MAX) return null;
	try {
		const type = c.req.header('content-type') ?? '';
		const data: unknown = type.includes('application/json') ? await c.req.json() : await c.req.parseBody();
		const out: Record<string, string> = {};
		if (data && typeof data === 'object' && !Array.isArray(data)) {
			for (const [key, value] of Object.entries(data)) {
				if (typeof value === 'string') out[key] = value.slice(0, 2048);
				else if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value);
			}
		}
		return out;
	} catch {
		return null;
	}
}

function dateOf(iso: string): string {
	return formatLondon(iso, { weekday: undefined, hour: undefined, minute: undefined });
}

function leaderboardRows(scores: ScoreEntry[]): Html {
	return html`${scores.map(
		(s) => html`<tr><td class="mono">${s.rank}</td><th scope="row" class="mono stork-initials">${s.initials}</th><td class="mono">${formatNumber(s.score)}</td><td class="tiny muted"><time datetime="${s.at}">${dateOf(s.at)}</time></td></tr>`,
	)}`;
}

function leaderboard(scores: ScoreEntry[] | null): Html {
	return html`<section class="card stack" id="leaderboard" aria-labelledby="leaderboard-title">
		<h2 class="card-title" id="leaderboard-title">Leaderboard</h2>
		${
			scores === null
				? html`<p class="notice notice-error">The leaderboard is having a lie-down. Scores are safe; try again in a minute.</p>`
				: html`<p class="empty" data-stork-empty${scores.length ? html` hidden` : ''}>No scores yet. The stork is undefeated.</p>
		<div class="table-wrap"${scores.length ? '' : html` hidden`} data-stork-board-wrap>
			<table class="table stork-board">
				<caption class="sr-only">Top 10 scores</caption>
				<thead><tr><th scope="col">#</th><th scope="col">Who</th><th scope="col">Score</th><th scope="col">When</th></tr></thead>
				<tbody data-stork-board>${leaderboardRows(scores)}</tbody>
			</table>
		</div>`
		}
		<p class="tiny muted">Top 10, updated every 30 seconds or so. Scores are checked against how long you could possibly have been playing.</p>
	</section>`;
}

corporateRoutes.get('/stork', async (c) => {
	let scores: ScoreEntry[] | null = null;
	try {
		scores = await topScores(c.env);
	} catch (err) {
		console.error('stork: leaderboard failed:', err);
	}
	const body = html`<div class="wrap section stack-lg corp stork-page">
	<header class="page-head">
		<p class="kicker">Mandatory team-building · Catch the Stork</p>
		<h1>Catch the Stork</h1>
		<p class="lede">The stork is making deliveries and its aim is not what it was. Catch the bundles, grab the bottles, drink the coffee and dodge the unsolicited advice.</p>
	</header>
	<div class="stork-layout">
		<section class="stork-main stack" aria-label="The game">
			<div class="stork-stage" data-stork hidden>
				<canvas class="stork-canvas" width="480" height="560" data-stork-canvas role="img" aria-label="Catch the Stork: a stork drops bundles that you catch in a basket at the bottom of the screen"></canvas>
				<div class="stork-overlay" data-stork-overlay>
					<p class="kicker" data-stork-kicker>Shift starts now</p>
					<p class="stork-overlay-title" data-stork-title>Ready when you are</p>
					<p data-stork-message>Move the basket with ← → (or A and D), or drag along the bottom of the screen.</p>
					<p><button class="btn btn-primary btn-lg" type="button" data-stork-start>Start</button></p>
				</div>
			</div>
			<div class="stork-bar" data-stork-bar hidden>
				<button class="btn btn-ghost stork-move" type="button" data-stork-left aria-label="Move left">◀</button>
				<button class="btn btn-ghost" type="button" data-stork-pause disabled>Pause</button>
				<button class="btn btn-ghost" type="button" data-stork-sound aria-pressed="false">Sound: off</button>
				<button class="btn btn-ghost stork-move" type="button" data-stork-right aria-label="Move right">▶</button>
			</div>
			<p class="tiny muted" data-stork-bar hidden>Your best: <strong class="mono" data-stork-best>none yet</strong> · Space or P pauses · M toggles sound · the game pauses itself if you switch tabs.</p>
			<noscript><p class="notice notice-error">The game needs JavaScript. The leaderboard, being a table, does not.</p></noscript>
		</section>
		<aside class="stork-side stack">
			<form class="card form stack" id="submit-score" method="post" action="/api/stork/score" data-stork-form>
				<fieldset class="stack" data-stork-fieldset disabled>
					<legend class="card-title">Lodge a score</legend>
					<p class="hint" data-stork-form-hint>Finish a game first. The stork doesn't take IOUs.</p>
					<input type="hidden" name="token" value="" data-stork-token>
					<input type="hidden" name="score" value="" data-stork-score>
					<div class="field">
						<label for="stork-initials">Your initials</label>
						<input class="mono stork-initials-input" id="stork-initials" name="initials" type="text" required minlength="3" maxlength="3" pattern="[A-Za-z]{3}" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="stork-initials-hint">
						<p class="hint" id="stork-initials-hint">Three letters, arcade style. They go on the public leaderboard. ${DAILY_SCORE_CAP} scores a day each.</p>
					</div>
					${turnstileWidget(c.env)}
					<p><button class="btn btn-primary" type="submit">Lodge score</button></p>
					<div data-stork-form-notice></div>
				</fieldset>
			</form>
			${leaderboard(scores)}
			<section class="card stack" aria-labelledby="stork-how">
				<h2 class="card-title" id="stork-how">The rules</h2>
				<ul class="stork-legend">
					<li><span class="stork-legend-icon" aria-hidden="true">🧺</span> You are the basket.</li>
					<li><span class="stork-legend-icon" aria-hidden="true">🎁</span> Bundle: 1 point. Dropping one costs a life.</li>
					<li><span class="stork-legend-icon" aria-hidden="true">🍼</span> Bottle: 3 points. Dropping one costs nothing but pride.</li>
					<li><span class="stork-legend-icon" aria-hidden="true">☕</span> Coffee: a life back (three at most).</li>
					<li><span class="stork-legend-icon" aria-hidden="true">💬</span> Unsolicited advice: catching it costs a life. Let it fall.</li>
				</ul>
				<p class="tiny muted">It speeds up. The stork does not apologise. Sound is off until you turn it on. <a href="/privacy">What we keep</a>: your initials, your score and not much else.</p>
			</section>
		</aside>
	</div>
</div>`;
	return renderPage(c, {
		title: 'Catch the Stork',
		description: 'A small game about a large bird. Catch the bundles, dodge the advice, top the leaderboard.',
		path: '/stork',
		head: CORP_CSS,
		scripts: ['/stork.js'],
		turnstile: true,
		body,
	});
});

corporateRoutes.post('/api/stork/start', async (c) => {
	c.header('Cache-Control', 'no-store');
	if (!(await allow(c.env.RL_API, `stork-start:${clientKey(c)}`))) {
		return c.json({ ok: false, error: 'Too many games in one minute. Have a sit down.' }, 429);
	}
	try {
		const { token, startedAt } = await issueGameToken(c.env);
		return c.json({ ok: true, token, startedAt: new Date(startedAt).toISOString() });
	} catch (err) {
		console.error('stork: token failed:', err);
		return c.json({ ok: false, error: 'The scorekeeper is out. You can still play, just not for glory.' }, 503);
	}
});

corporateRoutes.get('/api/stork/scores', async (c) => {
	try {
		const scores = await topScores(c.env);
		c.header('Cache-Control', `public, max-age=${LEADERBOARD_TTL_MS / 1000}`);
		return c.json({ scores });
	} catch (err) {
		console.error('stork: leaderboard failed:', err);
		c.header('Cache-Control', 'no-store');
		return c.json({ ok: false, error: 'The leaderboard is having a lie-down.' }, 503);
	}
});

type ScoreFailure = { status: 400 | 403 | 409 | 413 | 429 | 503; code: string; error: string };

const fail = (status: ScoreFailure['status'], code: string, error: string): ScoreFailure => ({ status, code, error });

corporateRoutes.post('/api/stork/score', async (c) => {
	c.header('Cache-Control', 'no-store');
	const json = wantsJson(c);
	const respond = async (f: ScoreFailure, initials = '') =>
		json
			? c.json({ ok: false, code: f.code, error: f.error }, f.status)
			: scoreResultPage(c, { error: f.error, initials, status: f.status });

	if (!(await allow(c.env.RL_FORMS, `stork:${clientKey(c)}`))) {
		return respond(fail(429, 'rate_limited', 'Steady on: that is a lot of scores for one minute. Try again shortly.'));
	}
	const body = await readScoreBody(c);
	if (!body) return respond(fail(413, 'too_large', 'That score arrived in pieces. Please try again.'));
	if (!(await verifyTurnstile(c.env, body['cf-turnstile-response'], clientIp(c)))) {
		return respond(fail(403, 'turnstile', 'The robot check did not pass. Please try again (humans and storks only).'));
	}

	const now = Date.now();
	const token = await verifyGameToken(c.env, body.token, now).catch(() => null);
	if (token === null) return respond(fail(503, 'unavailable', 'The scorekeeper is out. Please try again in a minute.'));
	if (!token.ok) {
		const error =
			token.reason === 'expired'
				? 'That game is too old to count. Scores have to be lodged within two hours of the whistle.'
				: 'No game, no score. Play a round first, then lodge it from the same page.';
		return respond(fail(400, `token_${token.reason}`, error));
	}

	const initials = normaliseInitials(body.initials);
	if (!initials) return respond(fail(400, 'initials', 'Initials are exactly three letters, A to Z. Arcade rules.'));
	if (isRudeInitials(initials)) {
		return respond(fail(400, 'initials_rude', "The stork's lawyers have rejected those initials. Try some others."), initials);
	}
	const score = parseScore(body.score);
	if (score === null) return respond(fail(400, 'score', 'That is not a score. Scores are whole numbers, one or more.'), initials);
	if (score > maxPlausibleScore(now - token.startedAt)) {
		return respond(fail(400, 'implausible', 'That score is faster than the stork can drop things. It has been referred to the stewards.'), initials);
	}

	let ipHash: string;
	try {
		ipHash = await hashIdentifier(c.env, clientKey(c));
	} catch (err) {
		console.error('stork: hashIdentifier failed:', err);
		return respond(fail(503, 'unavailable', 'The scorekeeper is out. Please try again in a minute.'), initials);
	}
	let result;
	try {
		result = await submitScore(c.env, { initials, score, ipHash, game: token.game, now });
	} catch (err) {
		console.error('stork: submitScore failed:', err);
		return respond(fail(503, 'unavailable', 'The scorekeeper is out. Please try again in a minute.'), initials);
	}
	if (!result.ok) {
		return result.code === 'duplicate'
			? respond(fail(409, 'duplicate', 'That game has already been lodged. One game, one score.'), initials)
			: respond(fail(429, 'daily_limit', `That's ${DAILY_SCORE_CAP} scores today. The stork needs to rest. Come back tomorrow.`), initials);
	}
	if (json) return c.json({ ok: true, id: result.id, rank: result.rank, initials, score, scores: result.scores }, 201);
	return scoreResultPage(c, { initials, score, rank: result.rank, scores: result.scores, status: 200 });
});

function scoreResultPage(
	c: Ctx,
	o: { error?: string; initials: string; score?: number; rank?: number; scores?: ScoreEntry[]; status: number },
): Promise<Response> {
	const ok = !o.error;
	const body = html`<div class="wrap section stack-lg corp stork-page">
		<header class="page-head">
			<p class="kicker">Catch the Stork</p>
			<h1>${ok ? 'Score lodged' : 'Score not lodged'}</h1>
			${ok ? html`<p class="lede"><strong class="mono">${o.initials}</strong> with ${formatNumber(o.score ?? 0)}: number ${o.rank} on the board.</p>` : ''}
		</header>
		${ok ? '' : html`<div class="notice notice-error" role="alert"><p>${o.error}</p></div>`}
		${o.scores ? leaderboard(o.scores) : ''}
		<p class="cluster"><a class="btn btn-primary" href="/stork">Play again</a> <a class="btn btn-ghost" href="/stork#leaderboard">The leaderboard</a></p>
	</div>`;
	return renderPage(c, { title: ok ? 'Score lodged' : 'Score not lodged', path: '/stork', noindex: true, head: CORP_CSS, status: o.status, body });
}
