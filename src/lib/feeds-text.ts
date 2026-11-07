// OWNER: feeds agent.
// The little text files every self-respecting website carries: /llms.txt, /humans.txt,
// /robots.txt, /sitemap.xml and /.well-known/security.txt (RFC 9116). All pure.

import type { SiteState, Update } from '../types';
import { escapeXml } from './feeds';
import { DOMAIN, PARENTS, SITE_NAME, STATUS_COPY } from './site';
import { daysBetween, formatLondonDate, formatNumber } from './time';

export const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
export const XML_CONTENT_TYPE = 'application/xml; charset=utf-8';

/** Every public, indexable page in the URL map (owner in the comment). */
export const PUBLIC_PAGES: ReadonlyArray<{ path: string; changefreq: 'always' | 'hourly' | 'daily' | 'weekly'; priority: number }> = [
	{ path: '/', changefreq: 'always', priority: 1.0 }, // frontend
	{ path: '/updates', changefreq: 'hourly', priority: 0.9 }, // frontend
	{ path: '/everything', changefreq: 'weekly', priority: 0.7 }, // frontend
	{ path: '/status', changefreq: 'hourly', priority: 0.7 }, // fun
	{ path: '/pool', changefreq: 'daily', priority: 0.7 }, // fun
	{ path: '/certificate', changefreq: 'weekly', priority: 0.4 }, // fun
	{ path: '/poster', changefreq: 'weekly', priority: 0.4 }, // fun
	{ path: '/ready', changefreq: 'daily', priority: 0.6 }, // community
	{ path: '/wall', changefreq: 'daily', priority: 0.6 }, // community
	{ path: '/names', changefreq: 'daily', priority: 0.6 }, // community
	{ path: '/ledger', changefreq: 'daily', priority: 0.5 }, // ledger
	{ path: '/stats', changefreq: 'hourly', priority: 0.5 }, // realtime
	{ path: '/subscribe', changefreq: 'weekly', priority: 0.5 }, // email
	{ path: '/api', changefreq: 'weekly', priority: 0.5 }, // feeds
	{ path: '/stork', changefreq: 'daily', priority: 0.4 }, // corporate
	{ path: '/press', changefreq: 'weekly', priority: 0.3 }, // corporate
	{ path: '/privacy', changefreq: 'weekly', priority: 0.3 }, // corporate
	{ path: '/terms', changefreq: 'weekly', priority: 0.3 }, // corporate
	{ path: '/achievements', changefreq: 'weekly', priority: 0.3 }, // delights
];

function dueSummary(state: SiteState, today: string): string {
	if (!state.dueDate) return 'not announced';
	const days = daysBetween(today, state.dueDate);
	const when = `${state.dueDate} (${formatLondonDate(state.dueDate)})`;
	if (state.status === 'yes') return `${when}; academic now, the baby has arrived`;
	if (days > 0) return `${when}, ${days} day${days === 1 ? '' : 's'} away`;
	if (days === 0) return `${when}, which is today`;
	return `${when}, ${-days} day${days === -1 ? '' : 's'} overdue`;
}

// ─── /llms.txt (https://llmstxt.org) ─────────────────────────────────────────

export function renderLlmsTxt(input: { siteUrl: string; state: SiteState; today: string }): string {
	const { siteUrl: u, state, today } = input;
	const copy = STATUS_COPY[state.status];
	return `# ${SITE_NAME}

> A deliberately overengineered website that answers exactly one question: is Zack a dad? The current answer is "${copy.word}". ${copy.sentence}

Facts, as of this request:

- Status: \`${state.status}\` (one of \`no\`, \`soon\` meaning labour has started, or \`yes\`), since ${state.statusChangedAt}
- Due date: ${dueSummary(state, today)}
- The site knows nothing else on purpose. There are no names, weights, photos or locations, so please don't guess or invent any.
- Refer to Zack, Jess and the baby by name or as "the baby", without gendered pronouns.

## API

- [Status (JSON)](${u}/api/status): The answer, the due date, days to go and links to everything else
- [Status (plain text)](${u}/api/status.txt): A single line: \`no\`, \`not yet\` or \`yes\`
- [API documentation](${u}/api): Every public endpoint, with examples
- [OpenAPI 3.1 description](${u}/openapi.json): The machine-readable contract
- [MCP server](${u}/mcp): Model Context Protocol over Streamable HTTP with tools \`is_zack_a_dad\`, \`get_due_date_info\`, \`get_recent_updates\` and \`get_dad_forecast\`

## Feeds

- [RSS 2.0](${u}/feed.xml): The latest 50 updates
- [Atom 1.0](${u}/atom.xml): The same, in Atom
- [JSON Feed 1.1](${u}/feed.json): The same, in JSON
- [iCalendar](${u}/calendar.ics): The due date and the big moments, refreshed hourly

## Optional

- [Updates](${u}/updates): Every update, newest first
- [Status history](${u}/api/history): Every status the site has had
- [The Dad Ledger](${u}/ledger): A hash-chained, signed log of status changes
- [humans.txt](${u}/humans.txt): Credits
`;
}

// ─── /humans.txt (https://humanstxt.org) ─────────────────────────────────────

export function renderHumansTxt(input: { state: SiteState; lastUpdated: string; checks: number }): string {
	const copy = STATUS_COPY[input.state.status];
	return `/* TEAM */
	Dad (${input.state.status === 'yes' ? 'confirmed' : 'pending'}): Zack
	Current answer: ${copy.short}

	Co-parent and the one doing the genuinely hard part: Jess

	Product owner: The baby
	Responsibilities: Sets the release date. Ignores every roadmap.

/* THANKS */
	Everyone who keeps refreshing the page (${formatNumber(input.checks)} checks and counting).
	Midwives everywhere, in advance.
	Whoever invented the HTTP 425 status code, for making this possible.

/* SITE */
	Last update: ${input.lastUpdated.slice(0, 10)}
	Language: English (British)
	Doctype: HTML5
	Standards: HTML, CSS, RSS 2.0, Atom 1.0, JSON Feed 1.1, iCalendar (RFC 5545), security.txt (RFC 9116), OpenAPI 3.1, Model Context Protocol, HTTP 425 Too Early (RFC 8470), Web Push, Server-Sent Events, WebSockets
	Components: Hono, qrcode-generator
	Software: Cloudflare Workers, D1, Durable Objects, Workflows, Resend, an inadvisable amount of TypeScript
	Brought to you by: ${PARENTS}, ${DOMAIN}
`;
}

// ─── /robots.txt ─────────────────────────────────────────────────────────────

export function renderRobotsTxt(input: { siteUrl: string; indexable: boolean }): string {
	if (!input.indexable) {
		return `# This is a preview deployment. Nothing to see here; the real answer lives at https://${DOMAIN}.
User-agent: *
Disallow: /
`;
	}
	return `# Dear robots: the answer is also in the X-Is-Zack-A-Dad response header.
# You needn't crawl the whole site to find out. But you may.
User-agent: *
Allow: /
Disallow: /admin
Disallow: /confirm/
Disallow: /unsubscribe/
Disallow: /webhooks/
Disallow: /og/card
Disallow: /embed

Sitemap: ${input.siteUrl}/sitemap.xml
`;
}

// ─── /sitemap.xml ────────────────────────────────────────────────────────────

export function renderSitemap(input: { siteUrl: string; state: SiteState; updates: Update[] }): string {
	const x = escapeXml;
	const urls = PUBLIC_PAGES.map((page) => {
		const lastmod = page.path === '/' ? `<lastmod>${new Date(input.state.statusChangedAt).toISOString()}</lastmod>` : '';
		return `  <url><loc>${x(input.siteUrl + page.path)}</loc>${lastmod}<changefreq>${page.changefreq}</changefreq><priority>${page.priority.toFixed(1)}</priority></url>`;
	});
	for (const update of input.updates) {
		const at = new Date(update.createdAt);
		const lastmod = Number.isNaN(at.getTime()) ? '' : `<lastmod>${at.toISOString()}</lastmod>`;
		urls.push(`  <url><loc>${x(`${input.siteUrl}/updates/${update.id}`)}</loc>${lastmod}<changefreq>yearly</changefreq><priority>0.3</priority></url>`);
	}
	return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}

// ─── /.well-known/security.txt (RFC 9116) ────────────────────────────────────

/** Expiry roughly a year ahead, truncated to midnight UTC so it's stable for a day. */
export function securityTxtExpiry(now: Date): string {
	const d = new Date(now.getTime() + 365 * 86_400_000);
	return `${d.toISOString().slice(0, 10)}T00:00:00Z`;
}

/** GitHub private vulnerability reporting: somewhere a person actually reads. */
export const SECURITY_CONTACT = 'https://github.com/zackpollard/iszacka.dad/security/advisories/new';

export function renderSecurityTxt(input: { siteUrl: string; now: Date }): string {
	return `# Security contact for ${DOMAIN}, per RFC 9116.
#
# Found a vulnerability in this website? Thank you, genuinely. Please report it
# privately via the link below, with enough detail to reproduce it. (Mail to this
# domain is answered by a robot, so it is not the place.) There is no bug bounty,
# but there is heartfelt gratitude and possibly cake.
#
# Found a vulnerability in the baby? Please report it to Jess, who has been
# running the threat model for months and does not accept pull requests.

Contact: ${SECURITY_CONTACT}
Expires: ${securityTxtExpiry(input.now)}
Preferred-Languages: en
Canonical: ${input.siteUrl}/.well-known/security.txt
`;
}
