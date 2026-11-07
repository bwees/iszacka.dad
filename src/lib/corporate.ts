// OWNER: corporate agent (pages & game).
// The corporate pages' content: /press (brand guidelines), /privacy and /terms. Pure renderers;
// the routes live in src/routes/corporate.ts.
//
// /privacy is meant to be funny but *accurate*: every claim maps to a table in migrations/ or
// to code. If you add a table, a column, a cookie or a localStorage key, update it here too.
// test/corporate-pages.test.ts checks the palette against public/styles.css and the retention
// periods against the constants the purge jobs use.

import { html } from 'hono/html';
import type { Status } from '../types';
import { fragmentCache, type Html } from './layout';
import { MAX_GUESSES_PER_PERSON } from './pool';
import { INBOUND_SUCCESS_RETENTION, RESEND_EVENT_TTL_DAYS } from '../routes/resend-webhook';
import { UNCONFIRMED_TTL_DAYS, UNSUBSCRIBED_TTL_DAYS } from './retention';
import { DAD, DOMAIN, PARENTS, SITE_NAME, STATUS_COPY } from './site';
import { DAILY_SCORE_CAP } from './stork';

export const REPO_URL = 'https://github.com/zackpollard/iszacka.dad';
export const ISSUES_URL = `${REPO_URL}/issues/new`;

/** The egg in the site header (lib/layout.ts siteHeader), for the logo section. */
const EGG_PATH = 'M16 3C10 3 5 12 5 19a11 11 0 0 0 22 0C27 12 22 3 16 3Z';

// ─── /press ──────────────────────────────────────────────────────────────────

export interface Swatch {
	name: string;
	/** The CSS custom property in public/styles.css. */
	token: string;
	/** Its value in :root (light) and under prefers-color-scheme: dark. */
	light: string;
	dark: string;
	note: string;
}

/** The real palette, as declared in public/styles.css (a test keeps these honest). */
export const PRESS_PALETTE: readonly Swatch[] = [
	{ name: 'Signal NO', token: '--no', light: '#e2491f', dark: '#ff7448', note: 'Reserved for the word NO. Currently in heavy use.' },
	{ name: 'Imminent Amber', token: '--soon', light: '#f2a300', dark: '#ffc23d', note: 'Labour only. Using it for a late train causes panic.' },
	{ name: 'Dad Green', token: '--yes', light: '#14864a', dark: '#3fd58a', note: 'Embargoed until further notice.' },
	{ name: 'Eggshell', token: '--paper', light: '#f1ece1', dark: '#12110e', note: 'The paper everything is printed on. Dark mode: the night feed.' },
	{ name: 'Oatmeal', token: '--paper-2', light: '#e6dfcf', dark: '#1d1b16', note: 'Paper, but further down the page.' },
	{ name: 'Muslin', token: '--panel', light: '#f9f6ef', dark: '#191712', note: 'Cards and panels. Absorbent.' },
	{ name: 'Ink', token: '--ink', light: '#17140f', dark: '#f1ece1', note: 'Text, rules and the house shadow.' },
	{ name: 'Graphite', token: '--ink-2', light: '#4c4538', dark: '#c3baa7', note: 'Secondary text. Still legible, as required by law and taste.' },
	{ name: 'Pencil', token: '--ink-3', light: '#786f5d', dark: '#948b78', note: 'Tertiary text. For footnotes nobody reads.' },
	{ name: 'Focus Blue', token: '--focus', light: '#2257d8', dark: '#82a8ff', note: 'Keyboard focus. Never decorative.' },
	{ name: 'Error Red', token: '--error', light: '#c42b1c', dark: '#ff6b5b', note: 'Something went wrong. Not to be confused with Signal NO, which is fine.' },
];

export const PRESS_FONTS = [
	{ name: 'Anybody', token: '--font-display', role: 'Display: the answer, headings, anything shouted', licence: '/fonts/OFL-anybody.txt', sample: 'NO.' },
	{ name: 'Atkinson Hyperlegible Next', token: '--font-body', role: 'Body text: designed for legibility, which the answer has never lacked', licence: '/fonts/OFL-atkinson-hyperlegible-next.txt', sample: 'Zack is not a dad. Yet.' },
	{ name: 'Martian Mono', token: '--font-mono', role: 'Telemetry, kickers and code', licence: '/fonts/OFL-martian-mono.txt', sample: 'X-Is-Zack-A-Dad: no' },
] as const;

export const PRESS_ASSETS: ReadonlyArray<{ group: string; items: ReadonlyArray<{ href: string; label: string; size: string; preview?: 'card' | 'icon' }> }> = [
	{
		group: 'Social cards (1200 × 630)',
		items: [
			{ href: '/og/no.png', label: 'NO', size: 'PNG', preview: 'card' },
			{ href: '/og/soon.png', label: 'NOT YET', size: 'PNG', preview: 'card' },
			{ href: '/og/yes.png', label: 'YES (embargoed, but we are not monsters)', size: 'PNG', preview: 'card' },
		],
	},
	{
		group: 'Favicons',
		items: [
			{ href: '/favicon-no.svg', label: 'NO', size: 'SVG', preview: 'icon' },
			{ href: '/favicon-soon.svg', label: 'NOT YET', size: 'SVG', preview: 'icon' },
			{ href: '/favicon-yes.svg', label: 'YES', size: 'SVG', preview: 'icon' },
		],
	},
	{
		group: 'App icons',
		items: [
			{ href: '/icons/icon-512.png', label: 'Icon', size: '512 × 512 PNG', preview: 'icon' },
			{ href: '/icons/icon-192.png', label: 'Icon', size: '192 × 192 PNG', preview: 'icon' },
			{ href: '/icons/maskable-512.png', label: 'Maskable icon', size: '512 × 512 PNG', preview: 'icon' },
			{ href: '/icons/apple-touch-icon.png', label: 'Apple touch icon', size: '180 × 180 PNG', preview: 'icon' },
			{ href: '/badge.svg', label: 'README badge (live)', size: 'SVG' },
		],
	},
];

function egg(fill: string, label?: string): Html {
	return html`<svg class="press-egg" viewBox="0 0 32 32" ${label ? html`role="img" aria-label="${label}"` : html`aria-hidden="true"`} focusable="false"><path d="${EGG_PATH}" fill="${fill}"/></svg>`;
}

/** The boilerplate paragraph, as plain text (also offered for copying). */
export function boilerplate(status: Status): string {
	const word = STATUS_COPY[status].word;
	return `${SITE_NAME} (${DOMAIN}) is the world's leading, and only, authority on whether ${DAD} is a dad. Founded in 2026 by ${PARENTS}, it answers a single yes-or-no question through more notification channels than anyone asked for, a cryptographically signed ledger and a DNS TXT record, each request served in under 10 milliseconds of CPU. It uses no AI, stores nothing about the baby and has never knowingly been wrong. The current answer is ${word}.`;
}

const pressCache = fragmentCache(4);

export function pressBody(status: Status): Html {
	return pressCache(status, () => renderPress(status));
}

function renderPress(status: Status): Html {
	const word = STATUS_COPY[status].word;
	return html`<div class="wrap section stack-lg corp press">
	<header class="page-head">
		<p class="kicker">Press kit · Brand guidelines v1.0 · Approved by the board (two people and a bump)</p>
		<h1>Press kit</h1>
		<p class="lede">Everything a journalist, designer or curious relative needs to represent ${SITE_NAME} correctly. Please read the guidelines in full. There will not be a test, but there could be.</p>
	</header>

	<section class="stack" aria-labelledby="press-about">
		<h2 id="press-about">About ${SITE_NAME}</h2>
		<p class="kicker">Boilerplate · use verbatim · do not improve</p>
		<div class="snippet press-snippet">
			<blockquote class="press-boilerplate" id="press-boilerplate"><p>${boilerplate(status)}</p></blockquote>
			<button class="btn btn-ghost btn-copy" type="button" data-copy="#press-boilerplate" data-js-only hidden>Copy</button>
		</div>
		<dl class="meta-list">
			<div><dt>Founded</dt><dd>2026, in a fit of anticipation</dd></div>
			<div><dt>Headquarters</dt><dd>Whichever Cloudflare datacentre is nearest you</dd></div>
			<div><dt>Employees</dt><dd>Zero. Two founders. One incoming, start date approximate.</dd></div>
			<div><dt>Product</dt><dd>One bit of information, delivered redundantly</dd></div>
			<div><dt>Current answer</dt><dd><strong>${word}</strong></dd></div>
			<div><dt>Funding</dt><dd>None sought. Nappies, however, are welcome.</dd></div>
		</dl>
	</section>

	<section class="stack" aria-labelledby="press-logo">
		<h2 id="press-logo">The logo</h2>
		<p>The mark is an egg. It has always been an egg. Pair it with the wordmark, set in Anybody at full weight, and give it clear space of one egg on every side.</p>
		<div class="press-logos">
			<figure class="press-logo press-logo-light">
				<div class="press-lockup">${egg('#17140f')}<span class="press-wordmark">${SITE_NAME}</span></div>
				<figcaption class="tiny muted">Primary lockup, Ink on Eggshell</figcaption>
			</figure>
			<figure class="press-logo press-logo-dark">
				<div class="press-lockup">${egg('#f1ece1')}<span class="press-wordmark">${SITE_NAME}</span></div>
				<figcaption class="tiny">Reversed, Eggshell on Ink</figcaption>
			</figure>
			<figure class="press-logo press-logo-eggs">
				<div class="press-lockup">${egg('#e2491f', 'Egg in Signal NO')}${egg('#f2a300', 'Egg in Imminent Amber')}${egg('#14864a', 'Egg in Dad Green')}</div>
				<figcaption class="tiny muted">The egg in each status colour. Use the one that is true.</figcaption>
			</figure>
		</div>
	</section>

	<section class="stack" aria-labelledby="press-no">
		<h2 id="press-no">The NO</h2>
		<div class="notice notice-error" role="note"><p><strong>Rule 1.</strong> The NO must never be displayed smaller than 400px.</p></div>
		<p>The NO is our most recognisable asset and, for now, our only product. It is set in Anybody 900 at 150% width, in Signal NO, and it is never displayed smaller than 400 pixels. The specimen below is shown at the minimum permitted size. If your screen is narrower than that, your screen is non-compliant: scroll, rotate, or buy a bigger one.</p>
		<div class="press-specimen" role="region" aria-label="The NO at its minimum permitted size of 400 pixels" tabindex="0">
			<span class="press-no" aria-hidden="true">NO</span>
			<span class="sr-only">NO, at 400 pixels</span>
		</div>
		<p class="tiny muted">Specimen: 400px. Anything smaller is a "no", and we have enough of those.</p>
	</section>

	<section class="stack" aria-labelledby="press-colour">
		<h2 id="press-colour">Colour</h2>
		<p>These are the actual custom properties from <a href="/styles.css">/styles.css</a>, swatched live, so they follow your light or dark mode. Each status colour may only be used while that status is true.</p>
		<ul class="press-swatches">
			${PRESS_PALETTE.map(
				(s) => html`<li class="press-swatch">
				<span class="press-chip" style="background: var(${s.token})" aria-hidden="true"></span>
				<span class="press-swatch-name">${s.name}</span>
				<code class="tiny">${s.token}</code>
				<span class="tiny mono">Light ${s.light}<br>Dark&nbsp; ${s.dark}</span>
				<span class="tiny muted">${s.note}</span>
			</li>`,
			)}
		</ul>
	</section>

	<section class="stack" aria-labelledby="press-type">
		<h2 id="press-type">Typography</h2>
		<p>Three typefaces, all self-hosted and all under the SIL Open Font License. No others, please. Comic Sans has been informed.</p>
		<div class="grid">
			${PRESS_FONTS.map(
				(f) => html`<div class="card press-font">
				<p class="press-font-sample" style="font-family: var(${f.token})">${f.sample}</p>
				<h3 class="card-title">${f.name}</h3>
				<p class="tiny muted">${f.role}. <code>${f.token}</code>. <a href="${f.licence}">Licence (OFL)</a>.</p>
			</div>`,
			)}
		</div>
	</section>

	<section class="stack" aria-labelledby="press-dos">
		<h2 id="press-dos">Do's and don'ts</h2>
		<div class="press-dos">
			<div class="card press-do">
				<h3 class="card-title">Do</h3>
				<ul>
					<li>Display the NO at 400px or larger.</li>
					<li>Keep the question mark. The question mark is load-bearing.</li>
					<li>Use the current answer, and only the current answer.</li>
					<li>Use the house shadow: 3px, no blur, as nature intended.</li>
					<li>Link to <a href="/">the answer itself</a> rather than paraphrasing it.</li>
				</ul>
			</div>
			<div class="card press-dont">
				<h3 class="card-title">Don't</h3>
				<ul>
					<li>Stretch, squash, rotate, outline or gradient the NO.</li>
					<li>Write YES before it is true. Premature YES is a sackable offence.</li>
					<li>Use NOT YET for anything that isn't labour.</li>
					<li>Put the logo on a baby, or anything about the baby on anything. See the <a href="/privacy">privacy policy</a>.</li>
					<li>Add a moustache to the egg. We have been asked.</li>
					<li>Ask for comment. The comment is the answer.</li>
				</ul>
			</div>
		</div>
	</section>

	<section class="stack" aria-labelledby="press-assets">
		<h2 id="press-assets">Downloads</h2>
		<p>Approved assets, free to use for coverage, group chats and fridge doors. The social cards are pre-rendered for every status, because it is important to be ready.</p>
		${PRESS_ASSETS.map(
			(g) => html`<h3 class="kicker press-assets-group">${g.group}</h3>
			<ul class="press-assets">
				${g.items.map(
					(a) => html`<li class="press-asset${a.preview === 'card' ? ' press-asset-card' : ''}">
					${a.preview ? html`<img src="${a.href}" alt="" loading="lazy" decoding="async"${a.preview === 'card' ? html` width="1200" height="630"` : html` width="64" height="64"`}>` : ''}
					<a href="${a.href}" download>${a.label}</a>
					<span class="tiny muted mono">${a.size} · <code>${a.href}</code></span>
				</li>`,
				)}
			</ul>`,
		)}
	</section>

	<section class="stack" aria-labelledby="press-contact">
		<h2 id="press-contact">Media enquiries</h2>
		<p>Please don't. If you absolutely must, email <a href="mailto:ask@${DOMAIN}">ask@${DOMAIN}</a>: a machine will reply at once with the only fact we have. For everything else there is <a href="/everything">every possible way to find out</a>.</p>
	</section>
</div>`;
}

// ─── /privacy ────────────────────────────────────────────────────────────────

/**
 * Every D1 table, and the /privacy row that accounts for it ('site' for the site's own data,
 * which holds nothing about visitors). test/corporate-pages.test.ts fails when a migration adds
 * a table that isn't here, so the policy can't quietly fall behind the schema.
 */
export const PRIVACY_TABLES: Readonly<Record<string, string>> = {
	subscribers: 'Email updates',
	push_subscriptions: 'Push notifications',
	webhooks: 'Webhooks',
	deliveries: 'Delivery log',
	checks_daily: 'Check counts',
	checks_hourly: 'Check counts',
	checks_country: 'Check counts',
	checks_colo: 'Check counts',
	guesses: 'Baby pool guesses',
	wall: 'Congratulations wall',
	name_suggestions: 'Name suggestions',
	name_votes: 'Name suggestions',
	stork_scores: 'Catch the Stork scores',
	inbound_emails: 'Email to',
	email_sends: 'Email housekeeping',
	resend_events: 'Email housekeeping',
	settings: 'site',
	status_history: 'site',
	updates: 'site',
	ledger: 'site',
	checklist: 'site',
	og_images: 'site',
};

interface DataRow {
	what: Html | string;
	kept: Html | string;
	howLong: Html | string;
	visible: Html | string;
}

function dataRows(): DataRow[] {
	return [
		{
			what: 'Email updates',
			kept: 'Your email address, whether you want big news only or the daily "still no" too, a random token for the links in your emails, and when you signed up, confirmed and unsubscribed.',
			howLong: html`Until you unsubscribe. Sign-ups never confirmed are deleted after ${UNCONFIRMED_TTL_DAYS} days; unsubscribed addresses ${UNSUBSCRIBED_TTL_DAYS} days after you leave (so "resubscribe" still works in the meantime).`,
			visible: 'Never',
		},
		{
			what: 'Push notifications',
			kept: "The endpoint your browser's push service gives us (a long URL at Google, Mozilla, Apple or Microsoft), the two encryption keys that come with it, and a count of failed deliveries.",
			howLong: 'Until you turn notifications off, which deletes it. If the push service says the subscription has died, it is switched off and never used again.',
			visible: 'Never',
		},
		{
			what: 'Webhooks',
			kept: 'The URL you pasted, its type (Discord, Slack or generic), how often it wants news, a random management token, and the status code and time of the last delivery.',
			howLong: 'Until you delete it from its management page.',
			visible: 'Never',
		},
		{
			what: 'Delivery log',
			kept: 'Which update went to which subscriber, push subscription or webhook, by row number, and whether it worked. No addresses or URLs, just numbers.',
			howLong: 'Kept with the update, so a retry never sends anything twice.',
			visible: 'Never',
		},
		{
			what: 'Check counts',
			kept: 'How many times people checked the answer, added up per day, per hour of the day, per country and per Cloudflare datacentre. Nothing per visitor: you are a +1, nothing more.',
			howLong: 'Forever. It is the only vanity metric we have.',
			visible: html`Yes, as totals on <a href="/stats">/stats</a>`,
		},
		{
			what: 'Baby pool guesses',
			kept: html`The name you type and the moment you guess (both public), whether it came by web or email, a hashed connection identifier (or, by email, the hashed sender address) to enforce ${MAX_GUESSES_PER_PERSON} guesses each, and when you guessed.`,
			howLong: 'Until the admin hides or deletes it, or you ask.',
			visible: 'Name and guess: straight away',
		},
		{
			what: 'Congratulations wall',
			kept: 'Your name and message, a hashed connection identifier, and when you wrote it.',
			howLong: 'Until the admin rejects or deletes it, or you ask.',
			visible: 'Name and message: once approved',
		},
		{
			what: 'Name suggestions',
			kept: 'The suggested name, the optional "suggested by", a hashed connection identifier, the vote count, and one hashed identifier per vote so everyone votes once.',
			howLong: 'Until the admin rejects or deletes it, or you ask.',
			visible: 'Name and "suggested by": once approved',
		},
		{
			what: 'Catch the Stork scores',
			kept: html`Your three initials and score (both public), a hashed connection identifier to enforce ${DAILY_SCORE_CAP} scores a day, the game's id so it only counts once, and when you scored.`,
			howLong: 'Until the admin deletes it, or you ask.',
			visible: 'Initials and score: straight away',
		},
		{
			what: html`Email to <span class="mono">ask@${DOMAIN}</span>`,
			kept: 'What kind of email it was (a question, a pool guess, or ignored), the sender address hashed, and when it arrived. The message is read to write the reply and never goes in the database; a guess goes into the pool as above.',
			howLong: html`The hashed record: kept, to cap replies per sender. The Cloudflare Workflow that handles each email keeps its working copy (sender included) for ${INBOUND_SUCCESS_RETENTION}, a little longer if handling it failed, then discards it.`,
			visible: 'Never (a guess: as above)',
		},
		{
			what: 'Email housekeeping',
			kept: html`How many emails went out each day (a number, for the quota), and the ids of Resend's webhook deliveries, so none is handled twice.`,
			howLong: html`Daily counts: kept. Delivery ids: ${RESEND_EVENT_TTL_DAYS} days.`,
			visible: 'Never',
		},
		{
			what: 'Good vibes',
			kept: 'A tally per emoji of the good-vibes buttons on the homepage. Counts only.',
			howLong: 'Forever, for morale.',
			visible: 'Yes, as totals',
		},
		{
			what: 'Pigeon, smoke signal and fax',
			kept: 'Nothing. What you type into those forms is not read, stored or logged. The pigeon is working from memory.',
			howLong: 'Not applicable, gloriously.',
			visible: 'There is nothing to see',
		},
	];
}

const privacyCache = fragmentCache(2);

export function privacyBody(): Html {
	return privacyCache('privacy', renderPrivacy);
}

function renderPrivacy(): Html {
	return html`<div class="wrap section stack-lg corp legal">
	<header class="page-head">
		<p class="kicker">Privacy policy · the whole thing, no small print</p>
		<h1>What we know about you</h1>
		<p class="lede">Very little, on purpose. Here is all of it, with how long we keep it, because a website this pointless has no excuse for being vague.</p>
	</header>

	<section class="card stack" aria-labelledby="privacy-short">
		<h2 class="card-title" id="privacy-short">The short version</h2>
		<ul>
			<li>No adverts, no analytics, no tracking pixels, no fingerprinting. Nothing is sold, partly on principle and partly because nobody would buy it.</li>
			<li>We store only what a feature needs to work: your email if you want emails, your webhook if you want webhooks, your initials if you want glory.</li>
			<li>IP addresses are never stored. Where we need to tell people apart, we keep a salted hash (see below).</li>
			<li>Visitors get no cookies. The admin gets two.</li>
			<li>Nothing about the baby is stored, shown or wanted. The baby's privacy policy is very short: there is no data.</li>
		</ul>
	</section>

	<section class="stack" aria-labelledby="privacy-what">
		<h2 id="privacy-what">What is stored, and for how long</h2>
		<p>Everything lives in one Cloudflare D1 database (and one Durable Object for the live counters). The schema is public in <a href="${REPO_URL}/tree/main/migrations">the repository</a>, if you'd like to check our working.</p>
		<div class="table-wrap">
			<table class="table legal-table">
				<thead><tr><th scope="col">Thing</th><th scope="col">What we keep</th><th scope="col">For how long</th><th scope="col">Public?</th></tr></thead>
				<tbody>
					${dataRows().map((r) => html`<tr><th scope="row">${r.what}</th><td data-label="What we keep">${r.kept}</td><td data-label="For how long">${r.howLong}</td><td data-label="Public?">${r.visible}</td></tr>`)}
				</tbody>
			</table>
		</div>
		<p>The rest of the database is the site's own business: the answer, when it changed, the due date, the updates, the Dad Ledger, the readiness checklist, and a few randomly generated keys and salts.</p>
	</section>

	<section class="stack" aria-labelledby="privacy-hash">
		<h2 id="privacy-hash">Hashed connection identifiers</h2>
		<p>Some features need to tell one person from another without knowing who anyone is: ${MAX_GUESSES_PER_PERSON} pool guesses each, ${DAILY_SCORE_CAP} stork scores a day, one vote per name. For those, we take your IP address (for IPv6, just the first half, the /64 your whole household shares), add a random salt that only this database knows, run it through SHA-256 and keep the first 32 characters. The IP itself is never written down.</p>
		<p>A hash is a pseudonym, not a disguise: someone with both the database and the salt could check whether a particular IP made a particular entry. Nobody but the site has either. Email senders to <span class="mono">ask@${DOMAIN}</span> are hashed the same way.</p>
		<p>Rate limits (10 form posts a minute per connection, for example) are counted by Cloudflare in memory for a minute and leave no record with us. Pages with a form use Cloudflare Turnstile to check you are human, which sees your IP address while it does so.</p>
	</section>

	<section class="stack" aria-labelledby="privacy-cookies">
		<h2 id="privacy-cookies">Cookies and your device</h2>
		<p><strong>Cookies:</strong> visitors get none, so there is no banner to dismiss. The admin's browser gets two: a session cookie that keeps the admin signed in (30 days, HttpOnly, SameSite=Strict, only ever set by logging in at <span class="mono">/admin</span>) and a one-minute cookie that carries a "done" message from one admin page to the next.</p>
		<p><strong>Local storage:</strong> the site remembers a few things in your own browser, under keys starting <code>iszackadad:</code>. They never leave your device and we never see them:</p>
		<ul>
			<li>how many times you've checked the answer from the homepage (you may not want to know);</li>
			<li>whether you've already had the YES celebration, so it only ambushes you once;</li>
			<li>achievements you've unlocked, and similar party tricks;</li>
			<li>Catch the Stork: your personal best, your last initials, and whether you turned the sound on.</li>
		</ul>
		<p>One more lives in session storage, which forgets it when you close the tab: when the page last reloaded itself after a site update, so it can never get stuck reloading.</p>
		<p>Clear them any time by clearing this site's data in your browser. Installing the site as an app also stores a copy of the offline page on your device, and turning on push stores the subscription in your browser as well as with us.</p>
	</section>

	<section class="stack" aria-labelledby="privacy-processors">
		<h2 id="privacy-processors">Who else is involved</h2>
		<dl class="meta-list">
			<div><dt>Cloudflare</dt><dd>Hosts the whole thing: the Worker, the database, the Durable Object, DNS, the Turnstile robot check and the rate limits. Cloudflare's Workers Logs keep the Worker's log lines and basic request details (address, status, timing) for a few days so problems can be debugged. Form contents are not logged.</dd></div>
			<div><dt>Resend</dt><dd>Sends our emails and receives mail to <span class="mono">@${DOMAIN}</span>, so it handles your address (and, for incoming mail, the message) and keeps its own delivery records under its own privacy policy.</dd></div>
			<div><dt>GitHub</dt><dd>Hosts the source code, and any issue you open, publicly.</dd></div>
		</dl>
		<p>That's the list. No analytics provider, no advertising network, no data broker, no AI. The site's Content-Security-Policy wouldn't let anyone else's scripts run, Turnstile's apart, even if we tried.</p>
	</section>

	<section class="stack" aria-labelledby="privacy-delete">
		<h2 id="privacy-delete">Getting your data deleted</h2>
		<ul>
			<li><strong>Email updates:</strong> every email has an unsubscribe link (one click, no "are you sure"). The address is deleted ${UNSUBSCRIBED_TTL_DAYS} days later.</li>
			<li><strong>Push notifications:</strong> press "turn off" in the <a href="/everything#push">push section</a> on the device concerned. The subscription is deleted on the spot.</li>
			<li><strong>Webhooks:</strong> open the management link you were given when you added it (<span class="mono">/webhooks/…</span>) and press delete.</li>
			<li><strong>Everything else</strong> (a pool guess, a wall message, a name suggestion, a stork score): <a href="${ISSUES_URL}">open an issue on GitHub</a> saying what to remove. Issues are public, so describe the entry (for example "the pool guess for Alex at 14 Nov 15:30"), and please don't post your email address or anything else personal there.</li>
		</ul>
		<p>Under UK data protection law you can also ask what we hold about you, have it corrected, or object to it being kept, by the same route. If you think we've got it wrong, you can complain to the <a href="https://ico.org.uk/make-a-complaint/">Information Commissioner's Office</a>, who will be surprised to hear from you about this website.</p>
	</section>

	<section class="stack" aria-labelledby="privacy-changes">
		<h2 id="privacy-changes">Changes</h2>
		<p>This policy lives in a <a href="${REPO_URL}">public repository</a>, so every change is a commit with a date on it. The policy is run by ${PARENTS}, who would rather be choosing a pram.</p>
		<p><a href="/terms">Terms of service</a> · <a href="/press">Press kit</a></p>
	</section>
</div>`;
}

// ─── /terms ──────────────────────────────────────────────────────────────────

const termsCache = fragmentCache(8);

export function termsBody(emailDailyLimit: number): Html {
	return termsCache(String(emailDailyLimit), () => renderTerms(emailDailyLimit));
}

function renderTerms(emailDailyLimit: number): Html {
	return html`<div class="wrap section stack-lg corp legal">
	<header class="page-head">
		<p class="kicker">Terms of service · by reading this you have already agreed to read it</p>
		<h1>Terms of service</h1>
		<p class="lede">By using this website you agree that ${DAD} is not a dad, until such time as ${DAD} is, at which point you agree to that instead.</p>
	</header>

	<ol class="legal-terms stack">
		<li>
			<h2>The service</h2>
			<p>${SITE_NAME} provides one bit of information: whether ${DAD} is a dad. It is provided as is, free, and without warranty of any kind, express, implied or gestational.</p>
		</li>
		<li>
			<h2>Accuracy</h2>
			<p>The answer is changed by hand, by the admin, from a button. There may be a delay between ${DAD} becoming a dad and this website saying so. That delay is called "holding the baby" and is not a fault. Notifications wait a 60-second grace period after a change, in case of fat fingers, and are skipped if the answer is changed back in that time.</p>
		</li>
		<li>
			<h2>Service levels</h2>
			<p>We aim for the website to be up and the answer to be right. We make no promises about anyone's sleep after YES. Email is sent through Resend's free plan, so at most ${emailDailyLimit} emails go out a day: if more are due, the rest go after midnight UTC, and the daily "still no" email is skipped rather than crowd out real news. Push, webhooks and DNS don't wait for email.</p>
		</li>
		<li>
			<h2>Acceptable use</h2>
			<p>Please don't hammer the site. Forms accept 10 posts a minute per connection and the API 120 requests a minute; the automated email reply answers at most 5 emails a minute and 20 a day from any one sender. Beyond that you get a polite 429. Don't use the forms to post anything about anyone else, and nothing at all about the baby.</p>
		</li>
		<li>
			<h2>Things you post</h2>
			<p>Pool names, wall messages, name suggestions and stork initials are shown publicly (the wall and name suggestions only once approved). By posting them you let this site display them. The admin may approve, hide or delete anything, for any reason or none, and does not have to explain, being busy. Be kind; links are not allowed on the wall or in suggestions.</p>
		</li>
		<li>
			<h2>The baby pool</h2>
			<p>Each person gets ${MAX_GUESSES_PER_PERSON} guesses. The guess closest to the moment the answer becomes YES wins; ties go to whoever guessed first. The pool closes the instant ${DAD} becomes a dad. The prize is bragging rights: non-transferable, no cash alternative. No money changes hands, so this is not gambling, it is anticipation.</p>
		</li>
		<li>
			<h2>Name suggestions</h2>
			<p>All suggestions will be ignored. This is a binding commitment.</p>
		</li>
		<li>
			<h2>Catch the Stork</h2>
			<p>High scores are checked against how long you could possibly have been playing, and refused if they couldn't have been earned. Each connection may post ${DAILY_SCORE_CAP} scores a day. The stork's lawyers reserve the right to reject initials. The stork itself accepts no liability for dropped deliveries.</p>
		</li>
		<li>
			<h2>Pigeons, smoke signals and faxes</h2>
			<p>These notification methods are offered for completeness. No pigeon will be dispatched, no fire lit, no fax sent. We are confident this is in everyone's interest, especially the pigeon's.</p>
		</li>
		<li>
			<h2>The API, feeds and MCP server</h2>
			<p>Free, keyless and open to any origin. They may change, though the answer will only ever be no, not yet or yes. Please don't build a business on them; if you do, please tell us what it is, because we're curious.</p>
		</li>
		<li>
			<h2>Liability</h2>
			<p>To the extent the law allows, our total liability to you is limited to the value of the information provided, which is one bit. We are not responsible for decisions made on the strength of the answer, such as buying a card too early.</p>
		</li>
		<li>
			<h2>Privacy</h2>
			<p>Covered, in full and with retention periods, in the <a href="/privacy">privacy policy</a>.</p>
		</li>
		<li>
			<h2>Changes and law</h2>
			<p>These terms may change; every change is a commit in the <a href="${REPO_URL}">public repository</a>. They are governed by the law of England and Wales. Questions and complaints go to <a href="${ISSUES_URL}">a GitHub issue</a>, which is public, so please keep personal details out of it.</p>
		</li>
	</ol>
</div>`;
}
