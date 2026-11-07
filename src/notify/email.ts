// OWNER: email agent.
// Email templates (HTML + plain text) and delivery through the Resend API.
//
// Delivery helpers never throw: they return an EmailDelivery (a DeliveryResult with the
// Resend error name and whether the failure is worth retrying). Templates are pure and
// escape everything through hono/html.

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Audience, DeliveryResult, Frequency, SiteState, Status, SubscriberRow, Update } from '../types';
import { UNCONFIRMED_TTL_DAYS } from '../lib/retention';
import { DOMAIN, SITE_NAME, STATUS_COPY, siteUrl } from '../lib/site';
import { sha256Hex } from '../lib/security';
import { daysBetween, formatLondon, formatLondonDate, formatNumber, nowIso } from '../lib/time';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** A rendered email, ready for `sendEmail`. */
export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

/** The address we advertise for questions and pool guesses. */
export const ASK_ADDRESS = `ask@${DOMAIN}`;

/** How the two subscription frequencies are described everywhere (form, emails, manage page). */
export const FREQUENCY_COPY: Record<Frequency, { label: string; hint: string; summary: string }> = {
	big: {
		label: 'Only when it happens',
		hint: 'Real news only: labour starting, the big YES and any false alarms. Probably three emails, ever.',
		summary: 'big news only',
	},
	daily: {
		label: 'Every day, tell me no',
		hint: 'A dry "still no" every morning (09:00 UTC) until it is a yes, then a week of "dad day" posts, then silence. Plus all the big news.',
		summary: 'the daily "still no", plus the big news',
	},
};

export function isFrequency(value: unknown): value is Frequency {
	return value === 'big' || value === 'daily';
}

/** Columns of `subscribers`, in SubscriberRow order. */
export const SUBSCRIBER_COLUMNS = 'id, email, frequency, token, created_at, confirm_sent_at, confirmed_at, unsubscribed_at';

export function subscriberUrls(base: string, token: string) {
	const t = encodeURIComponent(token);
	return {
		confirm: `${base}/confirm/${t}`,
		manage: `${base}/unsubscribe/${t}`,
		unsubscribe: `${base}/unsubscribe/${t}`,
	};
}

// ─── Layout ──────────────────────────────────────────────────────────────────

const FONT = '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const ACCENT: Record<Status, string> = { no: '#475569', soon: '#b45309', yes: '#047857' };
const P = 'margin:0 0 16px;font-size:16px;line-height:1.6;color:#1f2937;';
const SMALL = 'margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280;';
const LINK = 'color:#1d4ed8;text-decoration:underline;';

/** Plain text → escaped paragraphs. Blank lines split paragraphs; single newlines become <br>. */
function paragraphs(text: string, style = P): Html {
	const paras = normaliseText(text)
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);
	return html`${paras.map(
		(p) => html`<p style="${style}">${p.split('\n').map((line, i) => (i === 0 ? line : html`<br>${line}`))}</p>`,
	)}`;
}

function normaliseText(text: string): string {
	return text.replace(/\r\n?/g, '\n').trim();
}

function link(href: string, label: string): Html {
	return html`<a href="${href}" style="${LINK}">${label}</a>`;
}

function button(href: string, label: string, accent: string): Html {
	return html`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;">
<tr><td style="border-radius:8px;background:${accent};">
<a href="${href}" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
</td></tr></table>`;
}

function factTable(rows: Array<[string, string]>): Html {
	return html`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;border-collapse:collapse;">
${rows.map(
	([label, value]) => html`<tr>
<th scope="row" align="left" style="padding:8px 12px 8px 0;border-bottom:1px solid #e5e7eb;font-size:14px;font-weight:600;color:#4b5563;vertical-align:top;white-space:nowrap;">${label}</th>
<td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827;">${value}</td>
</tr>`,
)}
</table>`;
}

function quote(text: string, accent: string): Html {
	return html`<blockquote style="margin:0 0 20px;padding:12px 16px;border-left:4px solid ${accent};background:#f9fafb;">${paragraphs(
		text,
		'margin:0;font-size:15px;line-height:1.6;color:#1f2937;',
	)}</blockquote>`;
}

function code(text: string): Html {
	return html`<pre style="margin:0 0 20px;padding:12px 16px;background:#f3f4f6;border-radius:8px;font-family:${MONO};font-size:14px;line-height:1.5;color:#111827;white-space:pre-wrap;">${text}</pre>`;
}

interface Frame {
	subject: string;
	status: Status;
	/** Inbox preview text (hidden in the body). */
	preheader: string;
	kicker: string;
	heading: string;
	hero?: Html;
	content: Html;
	cta?: { href: string; label: string };
	footer: Html;
}

async function renderFrame(f: Frame): Promise<string> {
	const accent = ACCENT[f.status];
	const doc = html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${f.subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ea;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;" aria-hidden="true">${f.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f1ea;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;border-top:6px solid ${accent};">
<tr><td style="padding:28px 28px 8px;font-family:${FONT};color:#1f2937;">
<p style="margin:0 0 8px;font-size:12px;line-height:1.4;letter-spacing:1px;text-transform:uppercase;font-weight:700;color:${accent};">${f.kicker}</p>
<h1 style="margin:0 0 20px;font-size:28px;line-height:1.2;font-weight:800;color:#111827;">${f.heading}</h1>
${f.hero ?? ''}
${f.content}
${f.cta ? button(f.cta.href, f.cta.label, accent) : ''}
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #e5e7eb;font-family:${FONT};">
${f.footer}
</td></tr>
</table>
<p style="margin:16px 0 0;font-family:${FONT};font-size:12px;color:#6b7280;">${SITE_NAME} · ${DOMAIN}</p>
</td></tr>
</table>
</body>
</html>`;
	return (await doc).toString();
}

function text(...blocks: Array<string | null | undefined | false>): string {
	return `${blocks
		.filter((b): b is string => typeof b === 'string' && b.trim() !== '')
		// Strip surrounding blank lines but keep leading spaces (the ASCII art needs them).
		.map((b) => b.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd())
		.join('\n\n')}\n`;
}

function textFacts(rows: Array<[string, string]>): string {
	return rows.map(([label, value]) => `${label}: ${value}`).join('\n');
}

// ─── Subscriber footer ───────────────────────────────────────────────────────

function subscriberFooter(base: string, token: string, frequency: Frequency, update?: Update): { html: Html; text: string } {
	const urls = subscriberUrls(base, token);
	const webUrl = update ? `${base}/updates/${update.id}` : base;
	const other: Frequency = frequency === 'daily' ? 'big' : 'daily';
	return {
		html: html`<p style="${SMALL}">You subscribed to ${link(base, DOMAIN)} for ${FREQUENCY_COPY[frequency].summary}.</p>
<p style="${SMALL}">${link(`${urls.manage}#frequency`, `Switch to "${FREQUENCY_COPY[other].label}"`)} · ${link(`${urls.unsubscribe}#unsubscribe`, 'Unsubscribe')}${update ? html` · ${link(webUrl, 'View on the web')}` : ''}</p>
<p style="${SMALL}">Sent by a Cloudflare Worker that has never once been a dad.</p>`,
		text: [
			'--',
			`You subscribed to ${DOMAIN} for ${FREQUENCY_COPY[frequency].summary}.`,
			`Switch to "${FREQUENCY_COPY[other].label}": ${urls.manage}#frequency`,
			`Unsubscribe: ${urls.unsubscribe}`,
			update ? `View on the web: ${webUrl}` : '',
		]
			.filter(Boolean)
			.join('\n'),
	};
}

/** Headers for every email sent to a subscriber (RFC 2369 / RFC 8058 / RFC 3834). */
export function subscriberHeaders(base: string, token: string, status: Status, updateId?: number): Record<string, string> {
	const headers: Record<string, string> = {
		'Auto-Submitted': 'auto-generated',
		// Plain atoms only: an invalid value would make Resend reject the whole send.
		'List-Id': `Is Zack a Dad updates <updates.${DOMAIN}>`,
		'X-Is-Zack-A-Dad': STATUS_COPY[status].header,
	};
	const unsubscribe = subscriberUrls(base, token).unsubscribe;
	// Only send HTTPS List-Unsubscribe URIs; a provider would reject the whole send otherwise.
	if (unsubscribe.startsWith('https://')) {
		headers['List-Unsubscribe'] = `<${unsubscribe}>`;
		headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
	}
	if (updateId !== undefined) headers['X-Update-Id'] = String(updateId);
	return headers;
}

// ─── Templates: subscription ─────────────────────────────────────────────────

export interface SubscriptionEmailInput {
	base: string;
	token: string;
	frequency: Frequency;
	status: Status;
}

export async function renderConfirmationEmail(input: SubscriptionEmailInput): Promise<RenderedEmail> {
	const urls = subscriberUrls(input.base, input.token);
	const summary = FREQUENCY_COPY[input.frequency].summary;
	const subject = "Confirm: you'd like to know if Zack is a dad";
	const lines = [
		`Someone, hopefully you, asked ${DOMAIN} to email this address with ${summary}.`,
		`Click below to confirm. If it was not you, ignore this email: nothing else will be sent, and the address is deleted after ${UNCONFIRMED_TTL_DAYS} days.`,
	];
	return {
		subject,
		html: await renderFrame({
			subject,
			status: input.status,
			preheader: "One click and you're on the list. Ignore this and you're not.",
			kicker: 'Double opt-in, as is proper',
			heading: 'Please confirm your subscription',
			content: html`${lines.map((l) => paragraphs(l))}`,
			cta: { href: urls.confirm, label: 'Yes, keep me posted' },
			footer: html`<p style="${SMALL}">Button not working? Paste this into your browser: ${link(urls.confirm, urls.confirm)}</p>
<p style="${SMALL}">Changed your mind already? ${link(urls.manage, 'Manage or cancel')}.</p>`,
		}),
		text: text(
			lines.join('\n\n'),
			`Confirm: ${urls.confirm}`,
			`Changed your mind already? ${urls.manage}`,
			`-- \n${SITE_NAME} · ${DOMAIN}`,
		),
	};
}

export async function renderAlreadySubscribedEmail(input: SubscriptionEmailInput): Promise<RenderedEmail> {
	const urls = subscriberUrls(input.base, input.token);
	const subject = "You're already on the list";
	const lines = [
		`Someone, hopefully you, tried to subscribe this address to ${DOMAIN} again. It is already confirmed and getting ${FREQUENCY_COPY[input.frequency].summary}.`,
		'Nothing has changed. To switch how often you hear from us, or to leave, use the link below.',
	];
	return {
		subject,
		html: await renderFrame({
			subject,
			status: input.status,
			preheader: 'Good news: you were already subscribed. Bad news: there is no other news.',
			kicker: 'Already subscribed',
			heading: "You're already on the list",
			content: html`${lines.map((l) => paragraphs(l))}`,
			cta: { href: urls.manage, label: 'Manage my subscription' },
			footer: html`<p style="${SMALL}">If this was not you, you can safely ignore it.</p>`,
		}),
		text: text(lines.join('\n\n'), `Manage your subscription: ${urls.manage}`, `-- \n${SITE_NAME} · ${DOMAIN}`),
	};
}

// ─── Templates: updates (status changes, daily digest, system notices) ──────

export interface UpdateEmailInput {
	base: string;
	update: Update;
	token: string;
	frequency: Frequency;
}

/** The admin's note, if it says more than the default sentence for the status. */
function adminNote(update: Update): string | null {
	const body = normaliseText(update.body);
	return body && body !== STATUS_COPY[update.status].sentence ? body : null;
}

const YES_BANNER = String.raw`
 __   __  _____   ____    _
 \ \ / / | ____| / ___|  | |
  \ V /  |  _|   \___ \  | |
   | |   | |___   ___) | |_|
   |_|   |_____| |____/  (_)
`;

const CONFETTI = '🎉 🍼 👶 🎊 🥳 🎉 🍼 👶 🎊 🥳';

export async function renderUpdateEmail(input: UpdateEmailInput): Promise<RenderedEmail> {
	const { base, update } = input;
	const footer = subscriberFooter(base, input.token, input.frequency, update);
	const accent = ACCENT[update.status];

	if (update.kind === 'daily') {
		const subject = update.title;
		const firstLine = normaliseText(update.body).split('\n')[0] ?? '';
		const cta = update.status === 'yes' ? 'Visit the site' : 'Check anyway';
		return {
			subject,
			html: await renderFrame({
				subject,
				status: update.status,
				preheader: firstLine,
				kicker: update.status === 'yes' ? 'The daily yes' : 'The daily no',
				heading: update.title,
				content: paragraphs(update.body),
				cta: { href: `${base}/`, label: cta },
				footer: footer.html,
			}),
			text: text(update.title, update.body, `${cta}: ${base}/`, footer.text),
		};
	}

	if (update.kind === 'status' && update.status === 'yes') {
		const subject = 'YES. Zack is a dad. 🍼🎉';
		const note = adminNote(update);
		const lines = [
			'After months of answering "no" with industrial-grade reliability, iszacka.dad can finally, officially and cryptographically confirm it: Zack is a dad. The baby is here.',
			'This email was fanned out by a durable workflow with exponential backoff, after a 60-second undo window, while the news was written to a hash-chained, Ed25519-signed ledger, published to DNS and pushed down WebSockets to every open browser, in steps of under ten milliseconds of CPU each. For one baby. Worth it.',
		];
		const after =
			"What now? Nothing is required of you. Please don't ring: Jess and Zack are busy and will surface in due course. Congratulations are very welcome on the wall.";
		const links: Array<[string, string]> = [
			[`${base}/wall`, 'Sign the congratulations wall'],
			[`${base}/certificate`, 'Download the official dad certificate'],
			[`${base}/ledger`, 'Inspect the Dad Ledger'],
			[`${base}/pool`, 'Find out who won the baby pool'],
		];
		const dailyNote =
			input.frequency === 'daily'
				? 'Daily subscribers: the "still no" era is over. You will get a week of "dad day" updates, then a farewell, then silence.'
				: null;
		return {
			subject,
			html: await renderFrame({
				subject,
				status: 'yes',
				preheader: 'This is not a drill. Repeat: this is not a drill.',
				kicker: 'Breaking news · Priority: maximum · Not a drill',
				heading: 'YES. Zack is a dad.',
				hero: html`<p style="margin:0 0 4px;font-size:26px;line-height:1.3;text-align:center;" aria-hidden="true">${CONFETTI}</p>
<p style="margin:0;font-family:${FONT};font-size:104px;line-height:1;font-weight:900;text-align:center;letter-spacing:-3px;color:${accent};">YES</p>
<p style="margin:4px 0 24px;font-size:26px;line-height:1.3;text-align:center;" aria-hidden="true">${CONFETTI}</p>`,
				content: html`${lines.map((l) => paragraphs(l))}
${note ? html`<p style="${P}"><strong>From the control room:</strong></p>${quote(note, accent)}` : ''}
${paragraphs(after)}
<ul style="margin:0 0 20px;padding-left:20px;font-size:16px;line-height:1.8;">${links.map(([href, label]) => html`<li>${link(href, label)}</li>`)}</ul>
${dailyNote ? paragraphs(dailyNote, SMALL) : ''}`,
				cta: { href: `${base}/wall`, label: 'Leave a congratulations note' },
				footer: footer.html,
			}),
			text: text(
				YES_BANNER,
				'ZACK IS A DAD.',
				CONFETTI,
				lines.join('\n\n'),
				note ? `From the control room:\n${note}` : null,
				after,
				links.map(([href, label]) => `* ${label}: ${href}`).join('\n'),
				dailyNote,
				footer.text,
			),
		};
	}

	if (update.kind === 'status' && update.status === 'soon') {
		const subject = "It's happening. (Zack is not a dad yet.)";
		const note = adminNote(update);
		const lines = [
			'Labour has started. Zack is not a dad yet, but the situation is developing in the right direction.',
			'We will email again when the answer is yes, and not a moment before. In the meantime, please resist the urge to text Jess or Zack. They are, understandably, busy.',
			'You can watch the answer change live, along with everyone else who is pretending not to.',
		];
		return {
			subject,
			html: await renderFrame({
				subject,
				status: 'soon',
				preheader: 'Labour has started. This is not yet a yes.',
				kicker: "Status change: it's happening",
				heading: "It's happening.",
				content: html`${lines.map((l) => paragraphs(l))}${note ? html`<p style="${P}"><strong>From the control room:</strong></p>${quote(note, accent)}` : ''}`,
				cta: { href: `${base}/`, label: 'Watch it live' },
				footer: footer.html,
			}),
			text: text("IT'S HAPPENING.", lines.join('\n\n'), note ? `From the control room:\n${note}` : null, `Watch it live: ${base}/`, footer.text),
		};
	}

	if (update.kind === 'status' && update.status === 'no') {
		const subject = 'Update: Zack is not a dad.';
		const note = adminNote(update);
		const lines = [
			'Zack is not a dad. The previous excitement has been formally withdrawn, and everyone may return to refreshing at a normal pace.',
			"Nothing else to report. We'll email again when there is.",
		];
		return {
			subject,
			html: await renderFrame({
				subject,
				status: 'no',
				preheader: 'Stand down. As you were.',
				kicker: 'Status change: stand down',
				heading: 'Stand down.',
				content: html`${lines.map((l) => paragraphs(l))}${note ? html`<p style="${P}"><strong>From the control room:</strong></p>${quote(note, accent)}` : ''}`,
				cta: { href: `${base}/`, label: 'See for yourself' },
				footer: footer.html,
			}),
			text: text('STAND DOWN.', lines.join('\n\n'), note ? `From the control room:\n${note}` : null, `See for yourself: ${base}/`, footer.text),
		};
	}

	// 'system' updates (and anything else): the update speaks for itself.
	const subject = update.title;
	return {
		subject,
		html: await renderFrame({
			subject,
			status: update.status,
			preheader: normaliseText(update.body).split('\n')[0] ?? update.title,
			kicker: `An update from ${DOMAIN}`,
			heading: update.title,
			content: paragraphs(update.body),
			cta: { href: `${base}/updates/${update.id}`, label: 'Read it on the site' },
			footer: footer.html,
		}),
		text: text(update.title, update.body, `Read it on the site: ${base}/updates/${update.id}`, footer.text),
	};
}

/**
 * Stands in for the subscriber token while an update email is rendered once per frequency.
 * Letters and digits only, so URL-encoding and HTML-escaping leave it exactly as it is.
 */
const TOKEN_SLOT = 'izadTokenSlot7f3a9c2e';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);

/**
 * Renders an update email for many subscribers: the template is rendered once per frequency,
 * then each subscriber's token is put into the links (encoded exactly as subscriberUrls and the
 * template's escaping would have). The result is identical to renderUpdateEmail per subscriber.
 */
export function updateEmailRenderer(base: string, update: Update): (sub: Pick<SubscriberRow, 'token' | 'frequency'>) => Promise<RenderedEmail> {
	// If the slot could collide with real content, fall back to rendering each email in full.
	if ([base, update.title, update.body].some((v) => v.includes(TOKEN_SLOT))) {
		return (sub) => renderUpdateEmail({ base, update, token: sub.token, frequency: sub.frequency });
	}
	const templates = new Map<Frequency, Promise<RenderedEmail>>();
	return async (sub) => {
		let template = templates.get(sub.frequency);
		if (!template) {
			template = renderUpdateEmail({ base, update, token: TOKEN_SLOT, frequency: sub.frequency });
			templates.set(sub.frequency, template);
		}
		const { subject, html: body, text: plain } = await template;
		const encoded = encodeURIComponent(sub.token);
		return { subject, html: body.replaceAll(TOKEN_SLOT, escapeHtml(encoded)), text: plain.replaceAll(TOKEN_SLOT, encoded) };
	};
}

// ─── Templates: inbound auto-replies ─────────────────────────────────────────

/** "Re: <their subject>" without stacking Re:s or carrying header-breaking characters. */
export function replySubject(original: string | null | undefined, fallback: string): string {
	const cleaned = cleanHeaderValue(original ?? '', 150);
	if (!cleaned) return fallback;
	return /^re:/i.test(cleaned) ? cleaned : `Re: ${cleaned}`;
}

export interface AutoReplyStats {
	checks: number | null;
	viewers: number | null;
	subscribers: number | null;
	guesses: number | null;
}

export interface AutoReplyInput {
	base: string;
	state: SiteState;
	stats: AutoReplyStats;
	/** 'YYYY-MM-DD' (Europe/London). */
	today: string;
	originalSubject?: string | null;
	/** DNS TXT record that carries the answer, if configured. */
	dnsName?: string | null;
}

/** Thousands separators without ICU's per-isolate start-up cost (see lib/time.ts). */
const fmt = (n: number) => formatNumber(n);

function dueFact(dueDate: string, today: string): string {
	const d = daysBetween(today, dueDate);
	const when = d > 1 ? `${d} days to go` : d === 1 ? 'tomorrow' : d === 0 ? 'today' : d === -1 ? '1 day overdue' : `${-d} days overdue`;
	return `${formatLondonDate(dueDate)} (${when})`;
}

export async function renderAutoReply(input: AutoReplyInput): Promise<RenderedEmail> {
	const { base, state, stats } = input;
	const copy = STATUS_COPY[state.status];
	const accent = ACCENT[state.status];
	const subject = replySubject(input.originalSubject, `${SITE_NAME} ${copy.short}`);

	const facts: Array<[string, string]> = [
		['The answer', copy.sentence],
		['Since', `${formatLondon(state.statusChangedAt)} (UK time)`],
	];
	if (state.dueDate && state.status !== 'yes') facts.push(['Due date', dueFact(state.dueDate, input.today)]);
	if (stats.checks !== null) facts.push(['Times checked', fmt(stats.checks)]);
	if (stats.viewers !== null) facts.push(['Watching right now', fmt(stats.viewers)]);
	if (stats.subscribers !== null) facts.push(['Email subscribers', fmt(stats.subscribers)]);
	if (stats.guesses !== null && state.status !== 'yes') facts.push(['Baby pool guesses', fmt(stats.guesses)]);

	const ways: Array<[string, string]> = [
		['On the web', `${base}/`],
		['In a terminal', `curl ${DOMAIN}`],
	];
	if (input.dnsName) ways.push(['Over DNS', `dig +short TXT ${input.dnsName}`]);
	ways.push(['By RSS', `${base}/feed.xml`], ['Get notified', `${base}/everything`]);

	const intro =
		'Thanks for your email. This inbox is staffed entirely by a Cloudflare Worker, which has read your message with great interest and understood none of it. Here is the answer you were almost certainly after.';
	const pool =
		state.status === 'yes'
			? null
			: `Fancy a flutter? Email ${ASK_ADDRESS} with "guess" in the subject and a body like "14 Nov 15:30" (add "Name: Alex" if you like) to enter the baby pool.`;
	const small =
		"This is an automatic reply (RFC 3834, naturally). We only reply a few times a minute per sender, and never to robots, mailing lists or ourselves. Nobody reads this inbox: if you need Jess or Zack, you already know how to reach them.";

	return {
		subject,
		html: await renderFrame({
			subject,
			status: state.status,
			preheader: copy.sentence,
			kicker: 'Automated reply',
			heading: copy.headline,
			hero: html`<p style="margin:0 0 20px;font-family:${FONT};font-size:72px;line-height:1;font-weight:900;letter-spacing:-2px;color:${accent};">${copy.word}</p>`,
			content: html`${paragraphs(intro)}
${factTable(facts)}
<p style="${P}"><strong>Other ways to ask</strong></p>
${factTable(ways)}
${pool ? paragraphs(pool) : ''}`,
			cta: { href: `${base}/`, label: 'See it live' },
			footer: paragraphs(small, SMALL),
		}),
		text: text(
			`${copy.word}.`,
			intro,
			textFacts(facts),
			`Other ways to ask:\n${textFacts(ways)}`,
			pool,
			`-- \n${small}`,
		),
	};
}

export interface GuessConfirmationInput {
	base: string;
	name: string;
	/** True when there was no "Name:" line, so the entry is listed as ANONYMOUS_NAME. */
	anonymous?: boolean;
	/** ISO UTC. */
	guessAt: string;
	id: number;
	originalSubject?: string | null;
}

/** Why an emailed guess is anonymous, and how to change that next time. */
export const ANONYMOUS_GUESS_NOTE =
	'No "Name:" line, so the leaderboard lists you as "Anonymous emailer". We never use the name on your email address: it goes on a public page. Want credit? Guess again with a line like "Name: Alex".';

export async function renderGuessConfirmation(input: GuessConfirmationInput): Promise<RenderedEmail> {
	const when = formatLondon(input.guessAt);
	const subject = replySubject(input.originalSubject, `Your guess is in: ${when}`);
	const facts: Array<[string, string]> = [
		['Name', input.name],
		['Guess', `${when} (UK time)`],
		['Entry', `#${input.id}`],
	];
	const luck = 'Good luck. Nothing is at stake except bragging rights, which are, of course, everything.';
	const anonymous = input.anonymous ? ANONYMOUS_GUESS_NOTE : null;
	return {
		subject,
		html: await renderFrame({
			subject,
			status: 'no',
			preheader: `Entry #${input.id}: ${when}. Good luck.`,
			kicker: 'Baby pool · Entry received',
			heading: 'Your guess is in.',
			content: html`${factTable(facts)}${anonymous ? paragraphs(anonymous) : ''}${paragraphs(luck)}`,
			cta: { href: `${input.base}/pool`, label: 'See the pool' },
			footer: paragraphs('This is an automatic reply. Entered by email, verified by nobody.', SMALL),
		}),
		text: text('Your guess is in.', textFacts(facts), anonymous, luck, `See the pool: ${input.base}/pool`),
	};
}

export interface GuessErrorInput {
	base: string;
	error: string;
	originalSubject?: string | null;
}

export const GUESS_FORMAT_EXAMPLE = `To: ${ASK_ADDRESS}\nSubject: guess\n\n14 Nov 15:30\nName: Alex`;

export async function renderGuessError(input: GuessErrorInput): Promise<RenderedEmail> {
	const subject = replySubject(input.originalSubject, "Your guess didn't go in");
	const help =
		'Times are UK time. The Name line is optional; without it you are listed as "Anonymous emailer" (we never publish the name on your email). One guess per email, please.';
	return {
		subject,
		html: await renderFrame({
			subject,
			status: 'no',
			preheader: 'The baby pool robot could not accept that guess. Here is the format it understands.',
			kicker: 'Baby pool · Entry not accepted',
			heading: "That guess didn't go in.",
			content: html`${paragraphs('The baby pool robot read your email carefully and could not accept it:')}
${quote(input.error, ACCENT.soon)}
${paragraphs('It understands emails like this:')}
${code(GUESS_FORMAT_EXAMPLE)}
${paragraphs(help)}`,
			cta: { href: `${input.base}/pool`, label: 'Or guess on the website' },
			footer: paragraphs('This is an automatic reply. The robot is doing its best.', SMALL),
		}),
		text: text(
			"That guess didn't go in.",
			`The baby pool robot could not accept it:\n${input.error}`,
			`It understands emails like this:\n\n${GUESS_FORMAT_EXAMPLE}`,
			help,
			`Or guess on the website: ${input.base}/pool`,
		),
	};
}

export async function renderTestEmail(base: string, state: SiteState): Promise<RenderedEmail> {
	const copy = STATUS_COPY[state.status];
	const subject = `Test email from ${DOMAIN}`;
	const lines = [
		'If you can read this, email works: the Resend API, the sender domain and your inbox are all on speaking terms.',
		`For the record: ${copy.sentence}`,
	];
	return {
		subject,
		html: await renderFrame({
			subject,
			status: state.status,
			preheader: 'Email works. Zack-related news remains as before.',
			kicker: 'Test transmission',
			heading: 'Testing, testing.',
			content: html`${lines.map((l) => paragraphs(l))}`,
			cta: { href: `${base}/admin`, label: 'Back to the control room' },
			footer: paragraphs(`Sent from /admin at ${formatLondon(nowIso())} (UK time).`, SMALL),
		}),
		text: text('Testing, testing.', lines.join('\n\n')),
	};
}

// ─── Delivery (Resend) ───────────────────────────────────────────────────────

export interface EmailDelivery extends DeliveryResult {
	/** Resend error name (validation_error, rate_limit_exceeded, …) or an internal code. */
	code?: string;
	/** True if the failure is worth retrying later (rate limits, outages, unknown errors). */
	transient?: boolean;
	messageId?: string;
}

export type EmailErrorKind = 'suppressed' | 'permanent' | 'transient';

export interface ClassifiedEmailError {
	code: string;
	kind: EmailErrorKind;
	/** Retry once, right now, after a short backoff. */
	retryNow: boolean;
	message: string;
}

export const RESEND_API_BASE = 'https://api.resend.com';
/** Resend rejects API requests without a User-Agent (403, error 1010), and Workers don't add one. */
export const RESEND_USER_AGENT = `iszacka.dad (+https://${DOMAIN})`;
/** Self-imposed daily cap when EMAIL_DAILY_LIMIT isn't set (Resend free plan: 100/day). */
export const DEFAULT_EMAIL_DAILY_LIMIT = 90;
/**
 * Emails kept in reserve for real news (status announcements to everyone). Only those may spend
 * the last few: the daily post, auto-replies and sign-up emails stop at this floor. It can't stop
 * inbound mail using the quota up (Resend counts every received email), only our own replies.
 */
export const DAILY_EMAIL_RESERVE = 10;

/** Codes meaning "out of quota for today" rather than anything wrong with the recipient. */
export function isQuotaCode(code: string | undefined): boolean {
	return code === 'daily_quota_exceeded' || code === 'quota_reserve';
}

/** An error from the Resend API: the HTTP status plus Resend's error `name`. */
export class ResendApiError extends Error {
	override name = 'ResendApiError';
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/**
 * Map a Resend failure to what we should do about it:
 * - suppressed: the address is on a suppression list. Stop emailing it.
 * - permanent: auth and validation problems (401/403/other 4xx). Retrying won't help.
 * - transient: rate limits (429), conflicts (409, except a reused idempotency key), outages
 *   (5xx), network errors and anything unknown. Worth another go.
 */
export function classifyEmailError(err: unknown): ClassifiedEmailError {
	const message = err instanceof Error ? err.message : String(err);
	const status = err instanceof ResendApiError ? err.status : undefined;
	const raw =
		err instanceof ResendApiError ? err.code : typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
	const code =
		(typeof raw === 'string' && /^[a-z0-9_]+$/.test(raw) ? raw : undefined) ??
		(/\b[a-z]+(?:_[a-z0-9]+)+\b/.exec(message)?.[0] ?? 'unknown_error');
	if (code === 'recipient_suppressed' || code === 'email_suppressed') return { code, kind: 'suppressed', retryNow: false, message };
	if (status !== undefined) {
		// The same Idempotency-Key with a different payload: retrying with that key is useless.
		if (status === 409 && code === 'invalid_idempotent_request') return { code, kind: 'permanent', retryNow: false, message };
		if (status === 429 || status === 409 || status >= 500) return { code, kind: 'transient', retryNow: true, message };
		if (status >= 400 && status < 500) return { code, kind: 'permanent', retryNow: false, message };
	}
	return { code, kind: 'transient', retryNow: true, message };
}

/** Strip control characters (CR/LF included), collapse whitespace, cap the length. */
export function cleanHeaderValue(value: string, max = 2000): string {
	return value
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max)
		.trim();
}

export interface OutgoingEmail {
	to: string;
	subject: string;
	html: string;
	text: string;
	headers?: Record<string, string>;
	from?: { email: string; name: string };
	replyTo?: string;
	/**
	 * Identifies one logical send (hashed into Resend's Idempotency-Key, which Resend keeps for
	 * 24 hours). Give the same value only to a retry of the same email. Without one, every call
	 * gets a fresh random key (the in-process retry still reuses it).
	 */
	idempotencyKey?: string;
}

export interface SendOptions {
	/** Base backoff before the single in-process retry (default 750ms, jittered). */
	retryDelayMs?: number;
	/** Injectable for tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable for tests (defaults to the global fetch). */
	fetch?: typeof fetch;
	/**
	 * Refuse to send (code `quota_reserve`) once only this many emails are left today. 0 (the
	 * default) lets a send use the quota right down to the cap; see DAILY_EMAIL_RESERVE.
	 */
	reserve?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─── Daily quota (best-effort; counting must never break a send) ─────────────

/** UTC day key for the email_sends table. */
export function utcDay(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

export function emailDailyLimit(env: Pick<Env, 'EMAIL_DAILY_LIMIT'>): number {
	const n = Number.parseInt(String(env.EMAIL_DAILY_LIMIT ?? ''), 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_EMAIL_DAILY_LIMIT;
}

/** Successful sends so far today (UTC). Fails open: a broken table reads as zero. */
export async function emailSendsToday(env: Pick<Env, 'DB'>, now: Date = new Date()): Promise<number> {
	try {
		if (!env.DB) return 0;
		const row = await env.DB.prepare('SELECT n FROM email_sends WHERE day = ?').bind(utcDay(now)).first<{ n: number }>();
		return row?.n ?? 0;
	} catch {
		return 0;
	}
}

export async function emailQuotaRemaining(env: Pick<Env, 'DB' | 'EMAIL_DAILY_LIMIT'>, now: Date = new Date()): Promise<number> {
	return emailDailyLimit(env) - (await emailSendsToday(env, now));
}

/**
 * Count emails against today's quota: every successful send, and (Resend counts these too)
 * every received email. `count` lets a batch record all its sends in one write. Never throws.
 */
export async function recordEmailSend(env: Pick<Env, 'DB'>, now: Date = new Date(), count = 1): Promise<void> {
	const n = Math.trunc(count);
	if (!(n > 0)) return;
	try {
		if (!env.DB) return;
		await env.DB.prepare('INSERT INTO email_sends (day, n) VALUES (?1, ?2) ON CONFLICT(day) DO UPDATE SET n = n + ?2')
			.bind(utcDay(now), n)
			.run();
	} catch (err) {
		console.error('email: could not count the send:', errorMessage(err));
	}
}

/** What an `Env` needs to send email. */
export type SendEmailEnv = Pick<
	Env,
	'RESEND_API_KEY' | 'EMAIL_FROM' | 'EMAIL_FROM_NAME' | 'EMAIL_DAILY_LIMIT' | 'DB' | 'RESEND_API_BASE'
>;

/** `"Name" <email>` (name optional), safe for a From header. */
function formatFrom(from: { email: string; name?: string }): string {
	const name = cleanHeaderValue(from.name ?? '', 200).replace(/["<>]/g, ' ').replace(/\s+/g, ' ').trim();
	return name ? `"${name}" <${from.email}>` : from.email;
}

/** One email in the shape Resend's /emails and /emails/batch take. */
function resendEmailBody(env: SendEmailEnv, msg: OutgoingEmail) {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(msg.headers ?? {})) {
		const clean = cleanHeaderValue(value);
		if (clean) headers[name] = clean;
	}
	return {
		from: formatFrom(msg.from ?? { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME }),
		to: msg.to,
		subject: cleanHeaderValue(msg.subject, 300) || SITE_NAME,
		html: msg.html,
		text: msg.text,
		...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
		...(Object.keys(headers).length ? { headers } : {}),
	};
}

function resendBase(env: SendEmailEnv): string {
	return (env.RESEND_API_BASE || RESEND_API_BASE).replace(/\/+$/, '');
}

/** Resend's Idempotency-Key: the caller's per-send key, hashed, or a random one. */
async function idempotencyKey(msg: OutgoingEmail): Promise<string> {
	return msg.idempotencyKey ? sha256Hex(`${msg.to}\n${msg.idempotencyKey}`) : crypto.randomUUID();
}

/** Turn an error response into a ResendApiError, parsing Resend's {name, message} body. */
async function resendError(res: Response): Promise<ResendApiError> {
	let name = 'unknown_error';
	let message = res.statusText || `HTTP ${res.status}`;
	try {
		const body = (await res.json()) as { name?: unknown; message?: unknown };
		if (typeof body?.name === 'string' && body.name) name = body.name;
		if (typeof body?.message === 'string' && body.message) message = body.message;
	} catch {
		// Not JSON; keep the status line.
	}
	return new ResendApiError(res.status, name, message);
}

/**
 * Send one email via the Resend API. Never throws. Transient failures (rate limit, outage,
 * conflict) are retried once in-process with jittered backoff; anything still failing is
 * reported, with `transient` telling the caller whether a later retry is worthwhile.
 * Respects the EMAIL_DAILY_LIMIT self-quota; every success is counted in `email_sends`.
 */
export async function sendEmail(env: SendEmailEnv, msg: OutgoingEmail, opts: SendOptions = {}): Promise<EmailDelivery> {
	if (!env.RESEND_API_KEY) {
		return { ok: false, transient: false, code: 'no_api_key', detail: "no_api_key: RESEND_API_KEY isn't set on the Worker" };
	}
	const remaining = await emailQuotaRemaining(env);
	if (remaining <= 0) {
		return {
			ok: false,
			transient: true,
			code: 'daily_quota_exceeded',
			detail: `daily_quota_exceeded: EMAIL_DAILY_LIMIT (${emailDailyLimit(env)}) reached for today; the quota resets at midnight UTC`,
		};
	}
	const reserve = Math.max(0, opts.reserve ?? 0);
	if (reserve > 0 && remaining <= reserve) {
		return {
			ok: false,
			transient: true,
			code: 'quota_reserve',
			detail: `quota_reserve: only ${remaining} emails left today, and the last ${reserve} are kept for real news`,
		};
	}

	const base = resendBase(env);
	const request: RequestInit = {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
			'User-Agent': RESEND_USER_AGENT,
			'Idempotency-Key': await idempotencyKey(msg),
		},
		body: JSON.stringify(resendEmailBody(env, msg)),
	};
	const call = opts.fetch ?? fetch;
	const sleep = opts.sleep ?? defaultSleep;
	const baseDelay = opts.retryDelayMs ?? 750;

	for (let attempt = 1; ; attempt++) {
		let failure: unknown = null;
		try {
			const res = await call(`${base}/emails`, request);
			if (res.ok) {
				const data = (await res.json().catch(() => null)) as { id?: unknown } | null;
				const messageId = typeof data?.id === 'string' ? data.id : undefined;
				await recordEmailSend(env);
				return { ok: true, messageId, detail: messageId ? `sent ${messageId}` : 'sent' };
			}
			failure = await resendError(res);
		} catch (err) {
			failure = err; // network-level failure: transient
		}
		const e = classifyEmailError(failure);
		if (e.retryNow && attempt === 1) {
			await sleep(Math.round(baseDelay * (1 + Math.random() * 0.5)));
			continue;
		}
		const detail = `${e.code}: ${cleanHeaderValue(e.message, 300)}`;
		if (e.kind !== 'transient') console.warn(`email send failed permanently: ${e.code}`);
		return { ok: false, gone: e.kind === 'suppressed' ? true : undefined, transient: e.kind === 'transient', code: e.code, detail };
	}
}

/** Resend's batch endpoint takes at most this many emails per request. */
export const RESEND_BATCH_LIMIT = 100;

export interface BatchSendOptions extends SendOptions {
	/**
	 * Identifies the logical batch (for example the update). Combined with each email's own
	 * idempotencyKey (or address) into the request's Idempotency-Key, so a retry of exactly the
	 * same emails is deduplicated by Resend and a different set gets a fresh key.
	 */
	idempotencyKey?: string;
}

function quotaRefusal(remaining: number, reserve: number, limit: number): EmailDelivery {
	return remaining > 0 && reserve > 0
		? {
				ok: false,
				transient: true,
				code: 'quota_reserve',
				detail: `quota_reserve: only ${remaining} emails left today, and the last ${reserve} are kept for real news`,
			}
		: {
				ok: false,
				transient: true,
				code: 'daily_quota_exceeded',
				detail: `daily_quota_exceeded: EMAIL_DAILY_LIMIT (${limit}) reached for today; the quota resets at midnight UTC`,
			};
}

/** A per-email error from a permissive batch: { index, message }, with the error name in the message if at all. */
function batchItemFailure(message: string): EmailDelivery {
	const e = classifyEmailError(new ResendApiError(422, /\b[a-z]+(?:_[a-z0-9]+)+\b/.exec(message)?.[0] ?? 'validation_error', message));
	return {
		ok: false,
		gone: e.kind === 'suppressed' ? true : undefined,
		transient: e.kind === 'transient',
		code: e.code,
		detail: `${e.code}: ${cleanHeaderValue(e.message, 300)}`,
	};
}

/**
 * Send many emails with one request to Resend's batch endpoint (POST /emails/batch). Never
 * throws; returns one EmailDelivery per message, in order.
 *
 * Reads today's quota once and sends only what it allows (the rest come back with a quota
 * code, unsent), and counts every success in `email_sends` with one write. Uses permissive
 * validation, so one bad address fails alone instead of sinking the batch. A failure of the
 * whole request (rate limit, outage) is retried once in-process with the same Idempotency-Key.
 */
export async function sendEmailBatch(env: SendEmailEnv, msgs: readonly OutgoingEmail[], opts: BatchSendOptions = {}): Promise<EmailDelivery[]> {
	if (msgs.length === 0) return [];
	if (!env.RESEND_API_KEY) {
		return msgs.map(() => ({ ok: false, transient: false, code: 'no_api_key', detail: "no_api_key: RESEND_API_KEY isn't set on the Worker" }));
	}
	if (msgs.length > RESEND_BATCH_LIMIT) {
		const out: EmailDelivery[] = [];
		for (let i = 0; i < msgs.length; i += RESEND_BATCH_LIMIT) out.push(...(await sendEmailBatch(env, msgs.slice(i, i + RESEND_BATCH_LIMIT), opts)));
		return out;
	}

	const remaining = await emailQuotaRemaining(env);
	const reserve = Math.max(0, opts.reserve ?? 0);
	const allowed = Math.min(msgs.length, Math.max(0, remaining - reserve));
	const results: EmailDelivery[] = msgs.map(() => quotaRefusal(remaining, reserve, emailDailyLimit(env)));
	if (allowed === 0) return results;
	const batch = msgs.slice(0, allowed);

	const key = await sha256Hex(
		`batch\n${opts.idempotencyKey ?? crypto.randomUUID()}\n${batch.map((m) => m.idempotencyKey ?? m.to).join('\n')}`,
	);
	const request: RequestInit = {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
			'User-Agent': RESEND_USER_AGENT,
			'Idempotency-Key': key,
			'x-batch-validation': 'permissive',
		},
		body: JSON.stringify(batch.map((m) => resendEmailBody(env, m))),
	};
	const call = opts.fetch ?? fetch;
	const sleep = opts.sleep ?? defaultSleep;
	const baseDelay = opts.retryDelayMs ?? 750;

	for (let attempt = 1; ; attempt++) {
		let failure: unknown = null;
		try {
			const res = await call(`${resendBase(env)}/emails/batch`, request);
			if (res.ok) {
				const data = (await res.json().catch(() => null)) as { data?: unknown; errors?: unknown } | null;
				const failed = new Map<number, string>();
				for (const e of Array.isArray(data?.errors) ? data.errors : []) {
					const { index, message } = (e ?? {}) as { index?: unknown; message?: unknown };
					if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < batch.length) {
						failed.set(index, typeof message === 'string' && message ? message : 'rejected by Resend');
					}
				}
				// `data` lists the created emails in request order, skipping the rejected ones.
				const ids = (Array.isArray(data?.data) ? data.data : []).map((d) => {
					const id = (d as { id?: unknown } | null)?.id;
					return typeof id === 'string' ? id : undefined;
				});
				const pairIds = ids.length === batch.length - failed.size;
				let n = 0;
				for (let i = 0; i < batch.length; i++) {
					const message = failed.get(i);
					if (message !== undefined) {
						results[i] = batchItemFailure(message);
						continue;
					}
					const messageId = pairIds ? ids[n] : undefined;
					n++;
					results[i] = { ok: true, messageId, detail: messageId ? `sent ${messageId}` : 'sent' };
				}
				await recordEmailSend(env, new Date(), batch.length - failed.size);
				return results;
			}
			failure = await resendError(res);
		} catch (err) {
			failure = err; // network-level failure: transient
		}
		const e = classifyEmailError(failure);
		if (e.retryNow && attempt === 1 && !isQuotaCode(e.code)) {
			await sleep(Math.round(baseDelay * (1 + Math.random() * 0.5)));
			continue;
		}
		const detail = `${e.code}: ${cleanHeaderValue(e.message, 300)}`;
		if (e.kind !== 'transient') console.warn(`email batch failed permanently: ${e.code}`);
		const outcome: EmailDelivery = { ok: false, gone: e.kind === 'suppressed' ? true : undefined, transient: e.kind === 'transient', code: e.code, detail };
		for (let i = 0; i < batch.length; i++) results[i] = { ...outcome };
		return results;
	}
}

/**
 * Email one update to a batch of subscribers with a single Resend request (see sendEmailBatch).
 * Templates are rendered once per frequency. Suppressed addresses are unsubscribed. Never
 * throws; one result per subscriber, in order.
 */
export async function deliverEmailBatch(env: Env, subs: readonly SubscriberRow[], update: Update, opts: SendOptions = {}): Promise<EmailDelivery[]> {
	try {
		const base = siteUrl(env);
		const render = updateEmailRenderer(base, update);
		const msgs: OutgoingEmail[] = [];
		for (const sub of subs) {
			msgs.push({
				to: sub.email,
				...(await render(sub)),
				headers: subscriberHeaders(base, sub.token, update.status, update.id),
				// Stable across workflow step retries and re-runs: one update, one subscriber.
				idempotencyKey: `update:${update.id}:${sub.id}`,
			});
		}
		const results = await sendEmailBatch(env, msgs, { ...opts, idempotencyKey: `update:${update.id}` });
		const gone = subs.filter((_, i) => results[i]?.gone);
		if (gone.length) {
			await disableSubscribers(
				env,
				gone.map((s) => s.id),
			);
		}
		return results.map((r) => (r.gone ? { ...r, detail: `${r.detail ?? ''} (subscriber disabled)`.trim() } : r));
	} catch (err) {
		return subs.map(() => ({ ok: false, transient: true, code: 'unknown_error', detail: `unknown_error: ${errorMessage(err)}` }));
	}
}

/** Stop emailing several subscribers (suppressed addresses), in one D1 round trip. Never throws. */
async function disableSubscribers(env: Env, ids: readonly number[]): Promise<void> {
	try {
		const at = nowIso();
		await env.DB.batch(ids.map((id) => env.DB.prepare('UPDATE subscribers SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE id = ?').bind(at, id)));
	} catch (err) {
		console.error('could not disable subscribers:', errorMessage(err));
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Stop emailing a subscriber (bounced / complained). Never throws. */
export async function disableSubscriber(env: Env, id: number): Promise<void> {
	try {
		await env.DB.prepare('UPDATE subscribers SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE id = ?')
			.bind(nowIso(), id)
			.run();
	} catch (err) {
		console.error('could not disable subscriber:', errorMessage(err));
	}
}

/** Stop emailing whoever owns an address (bounced / complained). Never throws. */
export async function disableSubscriberByEmail(env: Env, email: string): Promise<boolean> {
	try {
		const row = await env.DB.prepare('SELECT id FROM subscribers WHERE LOWER(email) = LOWER(?)').bind(email.trim()).first<{ id: number }>();
		if (!row) return false;
		await disableSubscriber(env, row.id);
		return true;
	} catch (err) {
		console.error('could not disable subscriber by address:', errorMessage(err));
		return false;
	}
}

/** Confirmed, still-subscribed recipients for an audience, id > afterId, ascending. */
export async function listEmailTargets(env: Env, audience: Audience, afterId: number, limit: number): Promise<SubscriberRow[]> {
	if (audience === 'none') return [];
	const frequency = audience === 'daily' ? " AND frequency = 'daily'" : '';
	const { results } = await env.DB.prepare(
		`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers
		 WHERE id > ? AND confirmed_at IS NOT NULL AND unsubscribed_at IS NULL${frequency}
		 ORDER BY id ASC LIMIT ?`,
	)
		.bind(afterId, Math.min(Math.max(Math.trunc(limit), 1), 100))
		.all<SubscriberRow>();
	return results;
}

/** Email one update to one subscriber. Never throws. Suppressed addresses are unsubscribed. */
export async function deliverEmail(env: Env, sub: SubscriberRow, update: Update, opts: SendOptions = {}): Promise<EmailDelivery> {
	try {
		const base = siteUrl(env);
		const email = await renderUpdateEmail({ base, update, token: sub.token, frequency: sub.frequency });
		const result = await sendEmail(
			env,
			{
				to: sub.email,
				...email,
				headers: subscriberHeaders(base, sub.token, update.status, update.id),
				// Stable across workflow step retries and re-runs: one update, one subscriber.
				idempotencyKey: `update:${update.id}:${sub.id}`,
			},
			opts,
		);
		if (result.gone) {
			await disableSubscriber(env, sub.id);
			return { ...result, detail: `${result.detail ?? ''} (subscriber disabled)`.trim() };
		}
		return result;
	} catch (err) {
		return { ok: false, transient: true, code: 'unknown_error', detail: `unknown_error: ${errorMessage(err)}` };
	}
}

/** What the sign-up emails need from a subscriber row. */
export type SubscriptionEmailTarget = Pick<SubscriberRow, 'id' | 'email' | 'token' | 'frequency' | 'confirm_sent_at'>;

async function sendSubscriptionEmail(
	env: Env,
	sub: SubscriptionEmailTarget,
	status: Status,
	render: (input: SubscriptionEmailInput) => Promise<RenderedEmail>,
	kind: 'confirm' | 'already',
): Promise<EmailDelivery> {
	try {
		const email = await render({ base: siteUrl(env), token: sub.token, frequency: sub.frequency, status });
		return await sendEmail(
			env,
			{
				to: sub.email,
				...email,
				headers: { 'Auto-Submitted': 'auto-generated' },
				// confirm_sent_at is the claim timestamp: it changes with every new 10-minute claim
				// (and on resubscribe), so each claimed send gets its own key.
				idempotencyKey: `sub:${kind}:${sub.id}:${sub.confirm_sent_at ?? ''}`,
			},
			// Sign-up emails never spend the quota kept for real news.
			{ reserve: DAILY_EMAIL_RESERVE },
		);
	} catch (err) {
		return { ok: false, transient: true, code: 'unknown_error', detail: `unknown_error: ${errorMessage(err)}` };
	}
}

/** The double opt-in email. Never throws. */
export function sendConfirmation(env: Env, sub: SubscriptionEmailTarget, status: Status = 'no') {
	return sendSubscriptionEmail(env, sub, status, renderConfirmationEmail, 'confirm');
}

/** "You're already subscribed, here's your manage link." Never throws. */
export function sendAlreadySubscribed(env: Env, sub: SubscriptionEmailTarget, status: Status = 'no') {
	return sendSubscriptionEmail(env, sub, status, renderAlreadySubscribedEmail, 'already');
}

/** A test email for /admin/test-email. Never throws. Every press is a new send (random key). */
export async function sendTestEmail(env: Env, to: string, state: SiteState): Promise<EmailDelivery> {
	try {
		const email = await renderTestEmail(siteUrl(env), state);
		return await sendEmail(env, { to, ...email, headers: { 'Auto-Submitted': 'auto-generated' } });
	} catch (err) {
		return { ok: false, transient: true, code: 'unknown_error', detail: `unknown_error: ${errorMessage(err)}` };
	}
}
