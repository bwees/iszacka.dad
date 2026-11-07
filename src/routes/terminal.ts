// OWNER: terminal agent.
// GET /live: `curl -N` gets a live whole-screen dashboard (a stream from the WaitingRoom),
// `websocat wss://…/live` the same frames over a WebSocket, and browsers a page explaining how.
// GET /.plan: the Unix plan file. GET /is-zack-a-grandad: the long-range forecast (page, or
// ASCII for curl). Mounted in src/index.ts.

import { type Context, Hono } from 'hono';
import { html, raw } from 'hono/html';
import { LinearRouter } from 'hono/router/linear-router';
import { GRADIENTS, ACCENT, isTerminalClient } from '../lib/ascii';
import { LIVE_MAX_MINUTES, type Line, type LiveModel, liveFrameLines } from '../lib/ascii-live';
import { getCheckTotal } from '../lib/counters';
import { FORMATS } from '../lib/formats';
import { type Html, renderPage } from '../lib/layout';
import { liveSnapshot, waitingRoom } from '../lib/live';
import { allow, clientKey } from '../lib/security';
import { DOMAIN, siteUrl } from '../lib/site';
import {
	GENERATION_YEARS,
	GRANDAD_ERROR_YEARS,
	type GrandadEstimate,
	grandadEstimate,
	grandadSentence,
	grandadSummary,
	grandadWhen,
	renderGrandadAscii,
	renderPlan,
} from '../lib/terminal';
import { listUpdates } from '../lib/updates';
import { formatLondon, formatLondonDate } from '../lib/time';
import type { AppEnv, SiteState, Status } from '../types';
import { MAX_TERMINALS } from '../do/waiting-room-protocol';

export const terminalRoutes = new Hono<AppEnv>({ router: new LinearRouter() });

const TEXT = 'text/plain; charset=utf-8';
const NO_STORE = 'no-store';

/** A browser asking for a page (not curl, not a WebSocket), which gets the how-to instead. */
function wantsPage(c: Context<AppEnv>): boolean {
	return !isTerminalClient(c.req.header('user-agent')) && (c.req.header('accept') ?? '').includes('text/html');
}

function withVary(res: Response, vary: string): Response {
	res.headers.set('Vary', vary);
	return res;
}

// ─── /live ───────────────────────────────────────────────────────────────────

terminalRoutes.get('/live', async (c) => {
	const upgrade = (c.req.header('upgrade') ?? '').toLowerCase() === 'websocket';
	if (!upgrade && wantsPage(c)) return withVary(await livePage(c), 'User-Agent, Accept');
	// HEAD would open a stream nobody reads: answer with the headers alone.
	if (c.req.method === 'HEAD') {
		return new Response(null, { headers: { 'Content-Type': TEXT, 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', Vary: 'User-Agent, Accept' } });
	}
	if (!(await allow(c.env.RL_API, `terminal:${clientKey(c)}`))) {
		return c.text('Too many reconnects. Breathe. The answer will still be there in a minute.\n', 429, { 'Cache-Control': NO_STORE, 'Retry-After': '60' });
	}
	try {
		const res = await waitingRoom(c.env).fetch(c.req.raw);
		// Re-wrapped so the headers are mutable (the root middleware adds its own).
		if (res.webSocket) return new Response(null, { status: 101, webSocket: res.webSocket, headers: res.headers });
		const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
		out.headers.set('Vary', 'User-Agent, Accept');
		return out;
	} catch (err) {
		console.error('waiting room unreachable (terminal):', err);
		return c.text('The waiting room is having a little lie down. Try again in a moment.\n', 503, { 'Cache-Control': NO_STORE, 'Retry-After': '5' });
	}
});

/** xterm's 256-colour palette, for the preview: the 6x6x6 cube and the grey ramp. */
export function xtermHex(n: number): string {
	const hex = (v: number) => v.toString(16).padStart(2, '0');
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return `#${hex(v)}${hex(v)}${hex(v)}`;
	}
	const levels = [0, 95, 135, 175, 215, 255];
	const i = Math.max(0, n - 16);
	return `#${hex(levels[Math.floor(i / 36) % 6] ?? 0)}${hex(levels[Math.floor(i / 6) % 6] ?? 0)}${hex(levels[i % 6] ?? 0)}`;
}

const FIREWORK_COLOURS = [196, 208, 226, 46, 51, 39, 201, 213];

/** The preview's colours: the terminal's, per status. Constant per status, so built on demand. */
function terminalCss(status: Status): string {
	const gradient = GRADIENTS[status].map((n, i) => `.t-g${i}{color:${xtermHex(n)}}`).join('');
	const fireworks = FIREWORK_COLOURS.map((n, i) => `.t-fw${i}{color:${xtermHex(n)};font-weight:700}`).join('');
	return `.term-window{background:#0d0d0d;color:#e6e3dc;border:1px solid var(--rule-2);border-radius:8px;box-shadow:var(--shadow);overflow:hidden;width:fit-content;max-width:100%}
.term-bar{display:flex;align-items:center;gap:.4rem;padding:.55rem .8rem;background:#262626;border-bottom:1px solid #000}
.term-bar i{width:.7rem;height:.7rem;border-radius:50%;background:#ff5f57}.term-bar i:nth-child(2){background:#febc2e}.term-bar i:nth-child(3){background:#28c840}
.term-bar b{margin-left:.6rem;font:500 .72rem/1 var(--font-mono);color:#a8a8a8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.term-screen{margin:0;padding:1rem 1.1rem 1.2rem;overflow-x:auto;white-space:pre;font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace;font-size:clamp(6.5px,1.45vw,15px);line-height:1.1;color:#e6e3dc;background:none}
.term-screen code{display:block;background:none;padding:0;border-radius:0;font:inherit;color:inherit;white-space:pre;overflow-wrap:normal}
.t-dim{color:#9a968e}.t-bold{font-weight:700}.t-accent{font-weight:700;color:${xtermHex(ACCENT[status])}}
.t-tape{background:#ffd700;color:#000}.t-tapeGap{background:#000;color:#ffd700}.t-tapeText{background:#ffd700;color:#000;font-weight:700}
${gradient}${fireworks}
.live-title{font-size:clamp(1.5rem,6.8vw,4.6rem)}.live-title span{white-space:nowrap}
.live-how{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr))}`;
}

function screen(lines: Line[]): Html {
	return html`${lines.map((line) => html`${line.map(([style, text]) => (style ? html`<span class="t-${style}">${text}</span>` : text))}\n`)}`;
}

async function livePage(c: Context<AppEnv>): Promise<Response> {
	const state = c.get('state');
	const [live, rows] = await Promise.all([liveSnapshot(c.env), listUpdates(c.env, { limit: 1 }).catch(() => [])]);
	const checks = live.checks ?? (await getCheckTotal(c.env).catch(() => 0));
	const latest = rows[0] ? { title: rows[0].title, createdAt: rows[0].createdAt } : null;
	const model: LiveModel = { state, viewers: live.viewers, terminals: 0, vibes: live.vibes, checks, latest };
	const lines = liveFrameLines(model, { now: Date.now(), frame: 0, preview: true });
	const host = new URL(siteUrl(c.env)).host;

	const body = html`<div class="wrap stack">
<header class="page-head">
<p class="kicker">Live, in your terminal</p>
<h1 class="live-title">curl -N <span>${host}/live</span></h1>
<p class="lede">A dashboard for your terminal that redraws itself the moment anything changes: the answer in enormous letters, who else is watching, the vibes, the countdown and the London time. Hazard tape while it's happening. Fireworks when it's happened.</p>
</header>

<section class="section stack" aria-labelledby="live-now">
<h2 id="live-now">Right now it looks like this</h2>
<div class="term-window">
<div class="term-bar" aria-hidden="true"><i></i><i></i><i></i><b>zack@iszacka.dad: ~ $ curl -N ${host}/live</b></div>
<pre class="term-screen" aria-label="A preview of the live terminal dashboard"><code>${screen(lines)}</code></pre>
</div>
<p class="muted tiny">A snapshot from when this page loaded. The real thing updates itself; this one is a web page and has made its peace with that.</p>
</section>

<section class="section stack" aria-labelledby="live-how">
<h2 id="live-how">How to watch</h2>
<div class="live-how">
<div class="card stack">
<h3 class="card-title">With curl</h3>
<pre class="code"><code>curl -N https://${host}/live</code></pre>
<p><code>-N</code> stops curl buffering, so each frame lands as it's drawn. Leave with Ctrl-C.</p>
</div>
<div class="card stack">
<h3 class="card-title">With websocat</h3>
<pre class="code"><code>websocat wss://${host}/live</code></pre>
<p>The same frames, one WebSocket message each. Anything you type is politely ignored.</p>
</div>
</div>
</section>

<section class="section stack" aria-labelledby="live-small-print">
<h2 id="live-small-print">The small print</h2>
<ul class="stack">
<li>Each connection lasts ${LIVE_MAX_MINUTES} minutes, then says goodbye. Run it again if you're still curious; the answer will have waited for you.</li>
<li>Up to ${MAX_TERMINALS} terminals can watch at once. After that it's standing room only (503, with a Retry-After).</li>
<li>Your cursor is hidden while it runs. If it's still missing after Ctrl-C, type <code>tput cnorm</code> (or <code>reset</code>).</li>
<li>Prefer machine-readable? <code>curl -N https://${host}/api/stream</code> is the same news as Server-Sent Events, and <a href="/api/formats">/api/formats</a> has the answer in ${FORMATS.length} formats, Morse and Braille included.</li>
</ul>
</section>
</div>`;

	return renderPage(c, {
		title: 'Live in your terminal',
		description: `Watch the answer live in your terminal: curl -N ${DOMAIN}/live`,
		body,
		head: html`<style>${raw(terminalCss(state.status))}</style>`,
		path: '/live',
	});
}

// ─── /.plan ──────────────────────────────────────────────────────────────────

terminalRoutes.get('/.plan', (c) =>
	new Response(renderPlan(c.get('state'), new Date()), { headers: { 'Content-Type': TEXT, 'Cache-Control': NO_STORE } }),
);

// ─── /is-zack-a-grandad ──────────────────────────────────────────────────────

const GRANDAD_CSS = `.grandad-answer{margin:.35rem 0 0;font-family:var(--font-display);font-weight:900;font-stretch:125%;font-size:clamp(3.5rem,14vw,9rem);line-height:.9;letter-spacing:-.02em;color:var(--soon)}
.grandad-when{font-family:var(--font-display);font-weight:800;font-size:clamp(1.5rem,4.5vw,2.6rem);line-height:1.1;margin:0}
.grandad-count{font-variant-numeric:tabular-nums}`;

/** Methodology, step one: what the estimate counts from. */
function grandadBasis(state: SiteState, estimate: GrandadEstimate): string {
	if (estimate.basis === 'yes') return `Take the moment Zack became a dad: ${formatLondon(state.statusChangedAt)}.`;
	if (estimate.basis === 'due' && state.dueDate) return `Take the due date: ${formatLondonDate(state.dueDate)}.`;
	return "Take the due date. There isn't one yet, which rather holds things up.";
}

terminalRoutes.get('/is-zack-a-grandad', async (c) => {
	const state = c.get('state');
	const now = new Date();
	if (isTerminalClient(c.req.header('user-agent'))) {
		return new Response(renderGrandadAscii(state, now), { headers: { 'Content-Type': TEXT, 'Cache-Control': NO_STORE, Vary: 'User-Agent' } });
	}
	const estimate = grandadEstimate(state, now);
	const body = html`<div class="wrap stack">
<header class="page-head">
<p class="kicker">Long-range forecast</p>
<h1>Is Zack a grandad?</h1>
</header>
<p class="grandad-answer">${estimate.answer}</p>
<p class="lede">${grandadSentence(state)}</p>

<section class="card stack" aria-labelledby="grandad-estimate">
<h2 class="card-title" id="grandad-estimate">Our best estimate</h2>
${estimate.at
	? html`<p class="grandad-when"><time datetime="${estimate.at}">${grandadWhen(estimate)}</time></p>
<p>Give or take ${GRANDAD_ERROR_YEARS} years, depending on decisions that are firmly not Zack's to make.</p>
<p class="mono grandad-count" data-grandad-at="${estimate.at}">${grandadSummary(estimate)}</p>`
	: html`<p>${grandadSummary(estimate)}</p>`}
</section>

<div class="stats">
<div class="stat"><span class="stat-value">+${GENERATION_YEARS}y</span><span class="stat-label">One generation, roughly</span></div>
<div class="stat"><span class="stat-value">±${GRANDAD_ERROR_YEARS}y</span><span class="stat-label">Error bars (generous)</span></div>
<div class="stat"><span class="stat-value">3%</span><span class="stat-label">Confidence, rounded up</span></div>
<div class="stat"><span class="stat-value">0</span><span class="stat-label">People consulted</span></div>
</div>

<section class="section stack" aria-labelledby="grandad-method">
<h2 id="grandad-method">Methodology</h2>
<ol class="stack">
<li>${grandadBasis(state, estimate)}</li>
<li>Add one generation: ${GENERATION_YEARS} years, a figure chosen by a demographer we did not consult.</li>
<li>Ignore every variable that matters, especially the baby's own opinions, which will be considerable.</li>
<li>Quote the result to the second. Precision isn't accuracy, but it looks lovely.</li>
</ol>
<p class="muted">Prefer a terminal? <code>curl ${DOMAIN}/is-zack-a-grandad</code>. Meanwhile, the question that matters is still <a href="/">the original one</a>.</p>
</section>
</div>`;

	const res = await renderPage(c, {
		title: 'Is Zack a grandad?',
		description: `Not yet. Estimated grandad date: ${grandadWhen(estimate)}, give or take ${GRANDAD_ERROR_YEARS} years.`,
		body,
		head: html`<style>${raw(GRANDAD_CSS)}</style>`,
		scripts: ['/grandad.js'],
		path: '/is-zack-a-grandad',
	});
	return withVary(res, 'User-Agent');
});
