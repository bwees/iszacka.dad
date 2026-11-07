// OWNER: frontend agent.
// The 1200×630 social preview card as a fully self-contained HTML document
// (inline CSS, no external requests) so Browser Rendering can screenshot it via
// page.setContent(), and scripts can render the static fallbacks in public/og/.

import type { SiteState, Status } from '../types';
import { DOMAIN, PARENTS, STATUS_COPY } from './site';
import { daysBetween, formatLondon, isYmd } from './time';

export interface OgCardInput {
	state: SiteState;
	checks: number;
	/** 'YYYY-MM-DD' Europe/London. */
	today: string;
}

// Tiny subsets of the site fonts, inlined so the card needs no network at all.
// Anybody (wdth 150, wght 900): A-Z, 0-9 and a little punctuation, 4 KB.
// Martian Mono (wdth 100, wght 500): Latin letters, digits and punctuation, 5 KB.
// Both SIL Open Font License 1.1 (see /fonts/OFL-*.txt). Regenerate with the
// Google Fonts css2 API `text=` parameter if the copy below ever needs new glyphs.
const DISPLAY_FONT_WOFF2 = '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';
const MONO_FONT_WOFF2 = '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';

interface Palette {
	bg: string;
	ink: string;
	muted: string;
	accent: string;
	rule: string;
}

const PALETTES: Record<Status, Palette> = {
	no: { bg: '#f1ece1', ink: '#17140f', muted: '#5b5445', accent: '#d93a24', rule: 'rgba(23,20,15,.18)' },
	soon: { bg: '#ffb000', ink: '#17140f', muted: '#4a3a10', accent: '#17140f', rule: 'rgba(23,20,15,.25)' },
	yes: { bg: '#14864a', ink: '#f6f1e6', muted: '#c9ecd6', accent: '#ffe08a', rule: 'rgba(246,241,230,.28)' },
};

/** Font size of the giant word, tuned so each answer fills the card without clipping. */
const WORD_SIZE: Record<Status, number> = { no: 330, soon: 196, yes: 266 };

export interface OgSubline {
	/** Upper-case telemetry line, e.g. "3 DAYS OVERDUE". */
	headline: string;
	/** One dry sentence. */
	detail: string;
}

function validDate(iso: string): Date | null {
	if (!iso) return null;
	const d = new Date(iso);
	// The epoch is the "unknown" sentinel used by fallback states.
	return Number.isNaN(d.getTime()) || d.getTime() <= 0 ? null : d;
}

function formatCount(n: number): string {
	return Math.max(0, Math.floor(n)).toLocaleString('en-GB');
}

/** The telemetry line and dry subline for a state. Exported for tests. */
export function ogSubline(input: OgCardInput): OgSubline {
	const { state, today } = input;
	const checks = Number.isFinite(input.checks) ? Math.max(0, Math.floor(input.checks)) : 0;
	const checked = checks === 1 ? 'Checked once' : `Checked ${formatCount(checks)} times`;
	const changed = validDate(state.statusChangedAt);

	if (state.status === 'yes') {
		return {
			headline: changed
				? `DAD SINCE ${formatLondon(changed.toISOString(), { hour: undefined, minute: undefined }).replace(/,/g, '').toUpperCase()}`
				: 'DAD STATUS: CONFIRMED',
			detail: checks > 0 ? `${checked}. It was worth the wait.` : `Congratulations, ${PARENTS}.`,
		};
	}

	if (state.status === 'soon') {
		const since = changed
			? ` · SINCE ${formatLondon(changed.toISOString(), { weekday: undefined, day: undefined, month: undefined, year: undefined })} UK TIME`
			: '';
		return {
			headline: `LABOUR IN PROGRESS${since}`,
			detail: checks > 0 ? `${checked}. It is finally happening.` : 'Stand by. It is finally happening.',
		};
	}

	let headline = 'AWAITING FURTHER DEVELOPMENTS';
	if (state.dueDate && isYmd(state.dueDate) && isYmd(today)) {
		const days = daysBetween(today, state.dueDate);
		if (days > 1) headline = `DUE IN ${days} DAYS`;
		else if (days === 1) headline = 'DUE TOMORROW';
		else if (days === 0) headline = 'DUE TODAY';
		else if (days === -1) headline = '1 DAY OVERDUE';
		else headline = `${-days} DAYS OVERDUE`;
	}
	return {
		headline,
		detail: checks > 0 ? `${checked}. The answer has been no every time.` : 'You will be among the first to know.',
	};
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** A little illustration per status: an egg, an egg in the process of hatching, a baby. */
export function stateIllustration(status: Status, palette: Pick<Palette, 'ink'> = { ink: '#17140f' }): string {
	const ink = palette.ink === '#f6f1e6' ? '#17140f' : palette.ink;
	const stroke = `stroke="${ink}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"`;
	const shell = '#fbf6ea';
	if (status === 'no') {
		return `<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<path d="M50 6C27 6 10 44 10 72a40 40 0 0 0 80 0C90 44 73 6 50 6Z" fill="${shell}" ${stroke}/>
<circle cx="38" cy="58" r="3" fill="#d8ccb2"/><circle cx="62" cy="76" r="4" fill="#d8ccb2"/><circle cx="50" cy="96" r="2.5" fill="#d8ccb2"/><circle cx="66" cy="44" r="2" fill="#d8ccb2"/>
<path d="M28 52c2-10 7-20 13-26" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".9"/>
</svg>`;
	}
	if (status === 'soon') {
		return `<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<g transform="rotate(-18 40 30)"><path d="M22 40C24 22 36 8 50 8s26 14 28 32l-9-6-8 8-9-8-9 8-8-8Z" fill="${shell}" ${stroke}/></g>
<circle cx="50" cy="62" r="22" fill="#ffd23f" ${stroke}/>
<circle cx="43" cy="58" r="3" fill="${ink}"/><circle cx="57" cy="58" r="3" fill="${ink}"/>
<path d="M46 66l4 5 4-5Z" fill="#f08a24" ${stroke} stroke-width="2.5"/>
<path d="M10 70l10 8 10-9 10 9 10-9 10 9 10-9 10 9 10-8c2 32-16 46-40 46S8 102 10 70Z" fill="${shell}" ${stroke}/>
</svg>`;
	}
	return `<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<circle cx="50" cy="64" r="40" fill="#ffd9b3" ${stroke}/>
<path d="M50 24c-6-10 4-18 12-12" fill="none" ${stroke}/>
<path d="M30 60q6-6 12 0M58 60q6-6 12 0" fill="none" ${stroke}/>
<circle cx="31" cy="74" r="6" fill="#ff9e8a" opacity=".7"/><circle cx="69" cy="74" r="6" fill="#ff9e8a" opacity=".7"/>
<path d="M40 80q10 10 20 0" fill="none" ${stroke}/>
</svg>`;
}

export function renderOgCardHtml(input: OgCardInput): string {
	const status = input.state.status;
	const copy = STATUS_COPY[status];
	const p = PALETTES[status];
	const sub = ogSubline(input);
	const ticks = Array.from({ length: 48 }, (_, i) => `<i style="height:${i % 6 === 0 ? 18 : 9}px"></i>`).join('');

	return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1200, height=630">
<title>${esc(`Is Zack a dad? ${copy.short}`)}</title>
<style>
@font-face{font-family:"OG Display";src:url(data:font/woff2;base64,${DISPLAY_FONT_WOFF2}) format("woff2");font-weight:900;font-stretch:150%}
@font-face{font-family:"OG Mono";src:url(data:font/woff2;base64,${MONO_FONT_WOFF2}) format("woff2");font-weight:500}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1200px;height:630px;overflow:hidden}
body{background:${p.bg};color:${p.ink};font-family:"OG Mono",ui-monospace,"DejaVu Sans Mono",monospace;position:relative;-webkit-font-smoothing:antialiased}
.frame{position:absolute;inset:28px;border:2px solid ${p.ink};display:flex;flex-direction:column;padding:34px 44px 30px}
.top{display:flex;justify-content:space-between;align-items:center;font-size:22px;letter-spacing:.08em;text-transform:uppercase}
.dot{display:inline-block;width:14px;height:14px;border-radius:50%;background:${p.accent};margin-right:12px;vertical-align:-1px;box-shadow:0 0 0 4px ${p.rule}}
.main{flex:1;display:flex;align-items:center;justify-content:space-between;gap:28px;min-height:0}
.word{font-family:"OG Display","Arial Black","Helvetica Neue",sans-serif;font-weight:900;font-stretch:150%;font-size:${WORD_SIZE[status]}px;line-height:.8;letter-spacing:-.01em;white-space:nowrap;padding-top:.04em}
.art{flex:none;width:150px;height:180px}
.art svg{width:100%;height:100%;display:block}
.ticks{display:flex;align-items:flex-end;gap:0;justify-content:space-between;height:18px;border-bottom:2px solid ${p.ink};margin-bottom:18px}
.ticks i{display:block;width:2px;background:${p.ink}}
.bottom{display:flex;justify-content:space-between;align-items:flex-end;gap:32px}
.headline{font-size:30px;letter-spacing:.04em;text-transform:uppercase;line-height:1.1}
.detail{font-size:22px;color:${p.muted};margin-top:10px;line-height:1.3}
.domain{font-size:22px;letter-spacing:.06em;white-space:nowrap;border:2px solid ${p.ink};padding:8px 14px}
.corner{position:absolute;width:14px;height:14px;border-color:${p.ink};border-style:solid}
.c1{left:14px;top:14px;border-width:2px 0 0 2px}.c2{right:14px;top:14px;border-width:2px 2px 0 0}
.c3{left:14px;bottom:14px;border-width:0 0 2px 2px}.c4{right:14px;bottom:14px;border-width:0 2px 2px 0}
</style>
</head>
<body>
<span class="corner c1"></span><span class="corner c2"></span><span class="corner c3"></span><span class="corner c4"></span>
<div class="frame">
<div class="top"><span><span class="dot"></span>Is Zack a dad?</span><span>Live answer</span></div>
<div class="main"><div class="word">${copy.word.split(' ').map(esc).join('<br>')}</div><div class="art">${stateIllustration(status, p)}</div></div>
<div class="ticks">${ticks}</div>
<div class="bottom">
<div><p class="headline">${esc(sub.headline)}</p><p class="detail">${esc(sub.detail)}</p></div>
<span class="domain">${esc(DOMAIN)}</span>
</div>
</div>
</body>
</html>`;
}
