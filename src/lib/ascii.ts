// OWNER: feeds agent (the live dashboard, /.plan and the grandad estimate: terminal agent).
// `curl iszacka.dad` → the answer in enormous, hand-assembled block letters, in colour,
// with a tidy box of supporting facts underneath. HTML is for browsers.

import type { SiteState, Status } from '../types';
import { DOMAIN, STATUS_COPY } from './site';
import { daysBetween, formatLondon, formatLondonDate, formatNumber, londonDate } from './time';

/**
 * True for command-line HTTP clients that want text, not HTML: curl, Wget (1 and 2),
 * HTTPie and xh. Browsers and everything else get the real page.
 */
export function isTerminalClient(userAgent: string | undefined): boolean {
	return /^(curl|wget2?|httpie|xh)\//i.test((userAgent ?? '').trim());
}

// ─── The font ────────────────────────────────────────────────────────────────
// Six rows per glyph, every row of a glyph the same width. Drawn by hand, one box-drawing
// character at a time, which is exactly as tedious as it sounds.

type Glyph = readonly [string, string, string, string, string, string];

export const GLYPHS: Readonly<Record<'N' | 'O' | 'T' | 'Y' | 'E' | 'S' | ' ', Glyph>> = {
	N: [
		'███╗   ██╗',
		'████╗  ██║',
		'██╔██╗ ██║',
		'██║╚██╗██║',
		'██║ ╚████║',
		'╚═╝  ╚═══╝',
	],
	O: [
		' ██████╗ ',
		'██╔═══██╗',
		'██║   ██║',
		'██║   ██║',
		'╚██████╔╝',
		' ╚═════╝ ',
	],
	T: [
		'████████╗',
		'╚══██╔══╝',
		'   ██║   ',
		'   ██║   ',
		'   ██║   ',
		'   ╚═╝   ',
	],
	Y: [
		'██╗   ██╗',
		'╚██╗ ██╔╝',
		' ╚████╔╝ ',
		'  ╚██╔╝  ',
		'   ██║   ',
		'   ╚═╝   ',
	],
	E: [
		'███████╗',
		'██╔════╝',
		'█████╗  ',
		'██╔══╝  ',
		'███████╗',
		'╚══════╝',
	],
	S: [
		'███████╗',
		'██╔════╝',
		'███████╗',
		'╚════██║',
		'███████║',
		'╚══════╝',
	],
	' ': ['   ', '   ', '   ', '   ', '   ', '   '],
};

export type GlyphChar = keyof typeof GLYPHS;

function isGlyphChar(ch: string): ch is GlyphChar {
	return Object.hasOwn(GLYPHS, ch);
}

/** Render a word (N, O, T, Y, E, S and spaces only) as six uncoloured rows of block letters. */
export function bigText(word: string): string[] {
	const rows = ['', '', '', '', '', ''];
	for (const ch of word.toUpperCase()) {
		if (!isGlyphChar(ch)) continue;
		const glyph = GLYPHS[ch];
		for (let r = 0; r < 6; r++) rows[r] += `${glyph[r]} `;
	}
	return rows.map((row) => row.replace(/\s+$/, ''));
}

// ─── Colour ──────────────────────────────────────────────────────────────────

export const ESC = '\u001b[';
export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const DIM = `${ESC}2m`;

/** A top-to-bottom 256-colour gradient per status: red, amber, green. */
export const GRADIENTS: Record<Status, readonly number[]> = {
	no: [203, 203, 197, 161, 160, 124],
	soon: [228, 221, 220, 214, 208, 172],
	yes: [156, 120, 84, 47, 41, 35],
};

export const ACCENT: Record<Status, number> = { no: 203, soon: 214, yes: 84 };

/** 256-colour foreground. */
export const fg = (n: number) => `${ESC}38;5;${n}m`;

/** Strip ANSI escape sequences (for measuring and for tests). */
export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, '');
}

// ─── The box ─────────────────────────────────────────────────────────────────

function pad(text: string, width: number): string {
	const visible = Array.from(stripAnsi(text)).length;
	return text + ' '.repeat(Math.max(0, width - visible));
}

function box(lines: string[], colour: (s: string) => string): string[] {
	const inner = Math.max(...lines.map((l) => Array.from(stripAnsi(l)).length)) + 4;
	const edge = (s: string) => colour(s);
	return [
		edge(`╭${'─'.repeat(inner)}╮`),
		...lines.map((l) => `${edge('│')}  ${pad(l, inner - 4)}  ${edge('│')}`),
		edge(`╰${'─'.repeat(inner)}╯`),
	];
}

function plural(n: number, word: string): string {
	return `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** The due / overdue / arrival line. */
export function dueLine(state: SiteState, today: string): string {
	if (state.status === 'yes') {
		const days = daysBetween(londonDate(new Date(state.statusChangedAt)), today);
		const ago = days <= 0 ? 'today' : `${plural(days, 'day')} ago`;
		return `Dad since ${formatLondon(state.statusChangedAt)} (${ago}).`;
	}
	if (state.status === 'soon') {
		return `Labour started ${formatLondon(state.statusChangedAt)}. Any minute now.`;
	}
	if (!state.dueDate) return 'Due date: not announced. Patience is a virtue.';
	const days = daysBetween(today, state.dueDate);
	const when = formatLondonDate(state.dueDate);
	if (days > 0) return `Due ${when} (${plural(days, 'day')} to go).`;
	if (days === 0) return `Due today, ${when}. No pressure.`;
	return `Due ${when} (${plural(-days, 'day')} overdue; nobody tell the baby).`;
}

export interface AsciiExtra {
	/** Total checks so far. */
	checks?: number;
	/** Clock override (tests). */
	now?: Date;
	/** TXT record to advertise for `dig`, or null/undefined to leave the DNS hint out. */
	dnsName?: string | null;
	/** ANSI colour (default on: terminals that cannot cope are rare and should feel bad). */
	color?: boolean;
}

/** Colour helpers for one poster, honouring AsciiExtra.color. */
export function asciiPaint(status: Status, colour: boolean) {
	const paint = (code: string) => (s: string) => (colour ? `${code}${s}${RESET}` : s);
	return { accent: paint(fg(ACCENT[status])), bold: paint(BOLD), dim: paint(DIM) };
}

/**
 * The curl poster: a dim kicker, a word in giant gradient letters (coloured for `status`),
 * and a box of facts. Facts may carry ANSI codes (from asciiPaint).
 */
export function asciiPoster(opts: { kicker: string; word: string; status: Status; facts: string[]; color?: boolean }): string {
	const colour = opts.color ?? true;
	const { accent, dim } = asciiPaint(opts.status, colour);
	const gradient = GRADIENTS[opts.status];
	const letters = bigText(opts.word).map((row, i) => (colour ? `${BOLD}${fg(gradient[i] ?? ACCENT[opts.status])}${row}${RESET}` : row));
	return [
		'',
		dim(`  ${opts.kicker}`),
		'',
		...letters.map((row) => `  ${row}`),
		'',
		...box(opts.facts, accent).map((row) => `  ${row}`),
		'',
		'',
	].join('\n');
}

export function renderAscii(state: SiteState, extra: AsciiExtra = {}): string {
	const colour = extra.color ?? true;
	const status = state.status;
	const copy = STATUS_COPY[status];
	const today = londonDate(extra.now ?? new Date());
	const { bold, dim } = asciiPaint(status, colour);

	const checks = extra.checks ?? 0;
	const facts = [
		bold(copy.sentence),
		'',
		dueLine(state, today),
		`Asked ${plural(checks, 'time')} so far.${status === 'no' && checks > 0 ? ' Still no.' : ''}`,
		'',
		`${dim('Live:   ')}curl -N ${DOMAIN}/live`,
		`${dim('SSE:    ')}curl -N ${DOMAIN}/api/stream`,
		...(extra.dnsName ? [`${dim('DNS:    ')}dig TXT ${extra.dnsName} +short`] : []),
		`${dim('Short:  ')}curl ${DOMAIN}/api/status.txt`,
		`${dim('Docs:   ')}https://${DOMAIN}/api`,
	];

	return asciiPoster({ kicker: 'Is Zack a dad?', word: copy.word, status, facts, color: colour });
}
