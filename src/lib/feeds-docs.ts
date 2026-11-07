// OWNER: feeds agent.
// The /api documentation page body: every public endpoint, with examples that are
// generated from live data at request time (so they're never out of date).

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Status } from '../types';
import { BADGE_LABEL_MAX } from './feeds-badge';
import type { DadVerdict, PublicUpdate, StatusDocument } from './feeds-api';
import { UPDATES_DEFAULT_LIMIT, UPDATES_MAX_LIMIT, statusText } from './feeds-api';
import { MCP_SUPPORTED_VERSIONS } from './feeds-mcp';
import { DOMAIN } from './site';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface ApiDocsInput {
	siteUrl: string;
	status: StatusDocument;
	dad: DadVerdict;
	updates: { updates: PublicUpdate[]; nextBefore: number | null; next: string | null };
	/**
	 * The DNS TXT record that carries the answer, or null when it isn't kept up to date
	 * (no DNS_API_TOKEN), which leaves the `dig` example out. Undefined: `answer.<domain>`.
	 */
	dnsName?: string | null;
}

interface Endpoint {
	method: string;
	path: string;
	what: string;
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

function endpointTable(caption: string, rows: Endpoint[]): Html {
	return html`<div class="table-wrap">
<table class="table">
<caption class="muted tiny">${caption}</caption>
<thead><tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">What it does</th></tr></thead>
<tbody>
${rows.map((r) => html`<tr><td><span class="pill mono">${r.method}</span></td><td><code>${r.path}</code></td><td>${r.what}</td></tr>`)}
</tbody>
</table>
</div>`;
}

function toolTable(rows: Array<{ name: string; what: string }>): Html {
	return html`<div class="table-wrap">
<table class="table">
<caption class="muted tiny">MCP tools (all read-only)</caption>
<thead><tr><th scope="col">Tool</th><th scope="col">What it does</th></tr></thead>
<tbody>
${rows.map((r) => html`<tr><td><code>${r.name}</code></td><td>${r.what}</td></tr>`)}
</tbody>
</table>
</div>`;
}

function example(title: string, code: string): Html {
	return html`<figure class="stack">
<figcaption class="kicker">${title}</figcaption>
<pre class="code"><code>${code}</code></pre>
</figure>`;
}

function section(id: string, title: string, lede: string, body: Html): Html {
	return html`<section class="section stack" id="${id}" aria-labelledby="${id}-title">
<h2 id="${id}-title">${title}</h2>
<p class="lede">${lede}</p>
${body}
</section>`;
}

const STATUS_BADGE: Record<Status, string> = { no: 'badge-no', soon: 'badge-soon', yes: 'badge-yes' };

export function renderApiDocs(input: ApiDocsInput): Html {
	const u = input.siteUrl;
	const s = input.status;
	const host = (() => {
		try {
			return new URL(u).host;
		} catch {
			return DOMAIN;
		}
	})();

	const modernMcp = `curl -s ${u}/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -H 'MCP-Protocol-Version: 2026-07-28' \\
  -H 'Mcp-Method: tools/call' \\
  -H 'Mcp-Name: is_zack_a_dad' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"is_zack_a_dad","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'`;

	const legacyMcp = `curl -s ${u}/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'`;

	const mcpConfig = pretty({ mcpServers: { 'is-zack-a-dad': { type: 'http', url: `${u}/mcp` } } });

	const dadHeaders = [
		`HTTP/1.1 ${input.dad.httpStatus} ${input.dad.httpStatus === 201 ? 'Created' : 'Too Early'}`,
		'Content-Type: application/json',
		...Object.entries(input.dad.headers).map(([k, v]) => `${k}: ${v}`),
		'',
		pretty(input.dad.body),
	].join('\n');

	return html`<div class="wrap stack">
<header class="page-head">
<p class="kicker">Developer documentation</p>
<h1>The ${DOMAIN} API</h1>
<p class="lede">One yes/no question. Twenty-odd endpoints, four feed formats, an MCP server and an HTTP status code from RFC 8470. You're welcome.</p>
<p class="cluster"><span class="badge ${STATUS_BADGE[s.status]}">Right now: ${statusText(s.status)}</span> <a class="btn btn-ghost" href="/openapi.json">OpenAPI 3.1</a> <a class="btn btn-ghost" href="/llms.txt">llms.txt</a></p>
</header>

<nav class="card stack" aria-label="On this page">
<h2 class="card-title">On this page</h2>
<ul class="cluster" role="list" style="list-style:none;padding:0;margin:0">
<li><a href="#quick-start">Quick start</a></li>
<li><a href="#status">Status</a></li>
<li><a href="#updates">Updates</a></li>
<li><a href="#dad">/api/dad</a></li>
<li><a href="#feeds">Feeds</a></li>
<li><a href="#widgets">Badges &amp; embeds</a></li>
<li><a href="#mcp">MCP</a></li>
<li><a href="#machines">Machine-readable</a></li>
<li><a href="#elsewhere">Elsewhere</a></li>
<li><a href="#etiquette">Etiquette</a></li>
</ul>
</nav>

${section(
	'quick-start',
	'Quick start',
	'No keys, no sign-up, no SDK. If you can make an HTTP request, you can know whether Zack is a dad.',
	html`${example('The shortest possible answer', `$ curl ${u}/api/status.txt\n${statusText(s.status)}`)}
${example('The answer, in enormous coloured letters', `curl ${host}`)}
${example('Watch it happen live (Server-Sent Events)', `curl -N ${u}/api/stream`)}
${input.dnsName === null ? '' : example('Over DNS, because why not', `dig TXT ${input.dnsName ?? `answer.${DOMAIN}`} +short`)}`,
)}

${section(
	'status',
	'Status',
	'The answer, in increasing levels of verbosity. These never cache (Cache-Control: no-store), because the answer could change at any moment.',
	html`${endpointTable('Status endpoints', [
		{ method: 'GET', path: '/api/status', what: 'The answer as JSON, with the due date, days to go, the check counter and links to everything else.' },
		{ method: 'GET', path: '/api/status.json', what: 'Identical to /api/status, for people who like file extensions.' },
		{ method: 'GET', path: '/api/status.txt', what: 'One line of plain text: no, not yet or yes.' },
		{ method: 'GET', path: '/api/stream', what: 'Server-Sent Events: a hello on connect, then state changes, new updates and live numbers as they happen.' },
	])}
${example('GET /api/status (live, as of this page load)', pretty(s))}
<p class="muted">Fields: <code>status</code> is <code>no</code>, <code>soon</code> (labour has started) or <code>yes</code>. <code>daysUntilDue</code> counts whole days in Europe/London and goes negative when overdue; it is <code>null</code> without a due date. <code>checks</code> is how many times anyone has asked.</p>`,
)}

${section(
	'updates',
	'History and updates',
	'Every status change, the daily "still no" bulletin and the occasional announcement. Cached for 30 seconds.',
	html`${endpointTable('Update endpoints', [
		{ method: 'GET', path: '/api/history', what: 'Every status the site has had, oldest first.' },
		{ method: 'GET', path: `/api/updates?limit=${UPDATES_DEFAULT_LIMIT}&before=`, what: `Updates, newest first. limit is 1 to ${UPDATES_MAX_LIMIT} (default ${UPDATES_DEFAULT_LIMIT}); pass nextBefore as before for the next page.` },
	])}
${example('GET /api/updates?limit=2 (live)', pretty(input.updates))}`,
)}

${section(
	'dad',
	'GET /api/dad',
	'Request one dad. Until the baby arrives this returns 425 Too Early (RFC 8470), with a Retry-After computed from the due date; afterwards it returns 201 Created with Location: /. POST works too.',
	html`${example('Right now', dadHeaders)}
<p class="muted">Retry-After counts down to midnight (London time) on the due date, drops to an hour once overdue, and to a minute during labour. Without a due date there is no Retry-After, only hope.</p>`,
)}

${section(
	'feeds',
	'Feeds',
	'The latest 50 updates in every syndication format worth having. Cached for 60 seconds, with ETags, so a polite reader gets a 304.',
	html`${endpointTable('Feeds', [
		{ method: 'GET', path: '/feed.xml', what: 'RSS 2.0 (also at /rss.xml).' },
		{ method: 'GET', path: '/atom.xml', what: 'Atom 1.0.' },
		{ method: 'GET', path: '/feed.json', what: 'JSON Feed 1.1.' },
		{ method: 'GET', path: '/calendar.ics', what: "iCalendar: the due date as an all-day event, plus \"It's happening\" and \"Zack became a dad\" at the moments they happen. Subscribe once; it refreshes hourly." },
	])}
${example('Subscribe in your calendar app', `webcal://${host}/calendar.ics`)}
${example('Conditional requests', `curl -sI ${u}/feed.xml | grep -i etag\ncurl -s -o /dev/null -w '%{http_code}\\n' -H 'If-None-Match: "<etag>"' ${u}/feed.xml   # 304`)}`,
)}

${section(
	'widgets',
	'Badges and embeds',
	'Put the answer on your README, your wiki, your intranet or your fridge (see /poster for the fridge).',
	html`<div class="card stack">
<h3 class="card-title">Badge</h3>
<p><img src="/badge.svg" alt="Badge: is zack a dad? ${statusText(s.status)}" height="20"> <img src="/badge.svg?style=flat-square" alt="Flat-square badge" height="20"> <img src="/badge.svg?style=for-the-badge" alt="For-the-badge badge" height="28"></p>
<p>Options: <code>?style=flat|flat-square|for-the-badge</code> and <code>?label=</code> (up to ${BADGE_LABEL_MAX} characters; empty hides the label). Red for no, amber for not yet, green for yes.</p>
${example('Markdown', `[![Is Zack a dad?](${u}/badge.svg)](${u}/)`)}
</div>
<div class="card stack">
<h3 class="card-title">iframe</h3>
<p>A bare little widget that can be framed from anywhere and refreshes itself every minute. Add <code>?theme=light</code> or <code>?theme=dark</code> to override the system theme.</p>
${example('HTML', `<iframe src="${u}/embed" title="Is Zack a dad?" width="320" height="180" style="border:0"></iframe>`)}
</div>
<div class="card stack">
<h3 class="card-title">Script tag</h3>
<p>Renders the widget in a shadow DOM right where the script tag is, so your styles and ours never meet. Polls <code>/api/status</code> every 60 seconds (pausing while the tab is hidden).</p>
${example('HTML', `<script src="${u}/embed.js" data-theme="auto" data-size="medium" async></script>`)}
<p class="muted">Attributes: <code>data-theme</code> (auto, light, dark), <code>data-size</code> (small, medium, large), <code>data-target</code> (a CSS selector to render into instead) and <code>data-link="false"</code> to drop the link back here.</p>
</div>`,
)}

${section(
	'mcp',
	'MCP server',
	'For AI assistants that want to ask nicely. A stateless Model Context Protocol server over Streamable HTTP at /mcp, answering with plain JSON.',
	html`<p>Protocol versions: ${MCP_SUPPORTED_VERSIONS.map((v, i) => html`${i ? ', ' : ''}<code>${v}</code>`)}. Version 2026-07-28 clients send per-request <code>_meta</code> and the <code>MCP-Protocol-Version</code>, <code>Mcp-Method</code> and <code>Mcp-Name</code> headers (all validated); older clients <code>initialize</code> first. <code>GET /mcp</code> returns 405: there is no stream to listen to.</p>
${toolTable([
	{ name: 'is_zack_a_dad', what: 'The answer, the sentence, when it changed and the check counter.' },
	{ name: 'get_due_date_info', what: 'Due date, days to go (or overdue) and the fruit-based size comparison.' },
	{ name: 'get_recent_updates', what: 'The update stream. Arguments: limit (1 to 20), before (an update id).' },
	{ name: 'get_dad_forecast', what: 'A seven-day, weather-style forecast of becoming a dad.' },
])}
${example('Client configuration', mcpConfig)}
${example('Claude Code', `claude mcp add --transport http is-zack-a-dad ${u}/mcp`)}
${example('A 2026-07-28 tool call with curl', modernMcp)}
${example('A 2025-06-18 handshake with curl', legacyMcp)}`,
)}

${section(
	'machines',
	'Machine-readable odds and ends',
	'For crawlers, auditors, language models and the terminally curious.',
	endpointTable('Machine-readable files', [
		{ method: 'GET', path: '/openapi.json', what: 'OpenAPI 3.1 description of the API.' },
		{ method: 'GET', path: '/llms.txt', what: 'A summary for language models, per llmstxt.org.' },
		{ method: 'GET', path: '/humans.txt', what: 'Credits, per humanstxt.org.' },
		{ method: 'GET', path: '/robots.txt', what: 'Crawler rules.' },
		{ method: 'GET', path: '/sitemap.xml', what: 'Every public page.' },
		{ method: 'GET', path: '/.well-known/security.txt', what: 'Where to report vulnerabilities (RFC 9116). Vulnerabilities in the baby go to Jess.' },
		{ method: 'GET', path: '/badge.svg', what: 'The status badge.' },
		{ method: 'GET', path: '/embed', what: 'The iframe widget.' },
		{ method: 'GET', path: '/embed.js', what: 'The script-tag widget.' },
		{ method: 'GET', path: '/', what: 'With curl, wget, HTTPie or xh: the answer as giant ANSI art.' },
	]),
)}

${section(
	'elsewhere',
	'Elsewhere on the site',
	'Endpoints run by other parts of the operation, listed here so this page can honestly claim to cover everything.',
	endpointTable('Other public endpoints', [
		{ method: 'GET', path: '/ws', what: 'WebSocket: the same live messages as /api/stream, plus vibes you can send.' },
		{ method: 'GET', path: '/api/live', what: 'Live numbers, the current state and the reload nonce, as JSON. For clients that poll instead of holding a WebSocket.' },
		{ method: 'GET', path: '/stats', what: 'Anxiety analytics: who checks, when, and from where (aggregated).' },
		{ method: 'GET', path: '/api/countries', what: 'All-time checks per country (country only), for the live map. Cached for a minute; CORS open.' },
		{ method: 'GET', path: '/api/ledger', what: 'The Dad Ledger: a hash-chained, Ed25519-signed log of status changes.' },
		{ method: 'GET', path: '/.well-known/dad-ledger.json', what: 'The ledger and its public key, for independent verification.' },
		{ method: 'GET', path: '/og.png', what: 'The social preview image for the current status (pre-rendered).' },
		{ method: 'GET', path: '/api/push/key', what: 'The VAPID public key for Web Push.' },
		{ method: 'POST', path: '/api/push/subscribe', what: 'Subscribe a browser to push notifications.' },
		{ method: 'POST', path: '/api/push/unsubscribe', what: 'Unsubscribe it again.' },
		{ method: 'POST', path: '/subscribe', what: 'Email updates (double opt-in).' },
		{ method: 'POST', path: '/webhooks', what: 'Register a Discord, Slack or generic webhook.' },
	]),
)}

${section(
	'etiquette',
	'Etiquette',
	'The small print, kept small.',
	html`<ul class="stack">
<li><strong>CORS:</strong> every /api endpoint and /mcp sends <code>Access-Control-Allow-Origin: *</code> and answers preflight <code>OPTIONS</code> requests. Feeds and the badge do too.</li>
<li><strong>Rate limits:</strong> 120 requests a minute per IP across the API. Go over and you get <code>429</code>, a JSON body and a <code>Retry-After</code>. Polling once a minute is plenty; the baby will not arrive faster if you refresh harder.</li>
<li><strong>Caching:</strong> status endpoints are <code>no-store</code>; history and updates cache for 30 seconds; feeds and the badge for 60 seconds with ETags.</li>
<li><strong>Polling:</strong> add <code>?poll=1</code> to <code>/api/status</code> when a timer, not a person, is asking. You get the same answer, and the public "times checked" counter isn't inflated by your dashboard.</li>
<li><strong>Headers:</strong> every response carries <code>X-Is-Zack-A-Dad</code> and, when there's a due date, <code>X-Days-Until-Due</code>. <code>Server-Timing</code> includes the estimated gestation so far, in milliseconds, because it can.</li>
<li><strong>Privacy:</strong> the site knows the status, when it changed and the due date. That is all it will ever know, so please don't ask the API for names or weights.</li>
</ul>`,
)}
</div>`;
}
