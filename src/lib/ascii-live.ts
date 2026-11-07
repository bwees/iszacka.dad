// OWNER: terminal agent.
// `curl -N iszacka.dad/live`: a whole-screen dashboard, redrawn in place. Pure: the
// WaitingRoom renders one frame per tick or broadcast and writes the same bytes to every
// terminal; /live's HTML page renders the same lines as a static preview.
//
// A frame is a list of lines, each a list of (style, text) segments, so one layout serves
// ANSI (terminals) and HTML (the preview). Every line fits in WIDTH columns; nothing at module
// scope but constants.

import type { SiteState, Status } from '../types';
import { ACCENT, BOLD, DIM, ESC, GRADIENTS, RESET, bigText, fg } from './ascii';
import { londonMidnightUtc } from './feeds-api';
import { DOMAIN, STATUS_COPY } from './site';
import { daysBetween, formatLondon, formatNumber, formatWeekdayDayMonth, londonDate, londonOffsetMs } from './time';

export interface LatestUpdate {
	title: string;
	createdAt: string;
}

/** Everything a frame shows. */
export interface LiveModel {
	state: SiteState;
	/** Everyone connected: browsers, SSE streams and terminals. */
	viewers: number;
	/** Terminals among them. */
	terminals: number;
	vibes: number;
	checks: number;
	latest: LatestUpdate | null;
}

export interface FrameOptions {
	now: number;
	/** Redraw counter: moves the hazard tape along. */
	frame: number;
	/** Milliseconds since the flip to YES while the fireworks run; undefined otherwise. */
	fireworksAt?: number | undefined;
	/** Ring the terminal bell (the moment itself). */
	bell?: boolean;
	/** Rendering for the /live web page, not a terminal: no "like you". */
	preview?: boolean;
}

export type Style =
	| 'dim'
	| 'bold'
	| 'accent'
	| 'g0'
	| 'g1'
	| 'g2'
	| 'g3'
	| 'g4'
	| 'g5'
	| 'tape'
	| 'tapeGap'
	| 'tapeText'
	| 'fw0'
	| 'fw1'
	| 'fw2'
	| 'fw3'
	| 'fw4'
	| 'fw5'
	| 'fw6'
	| 'fw7';
export type Segment = readonly [Style | null, string];
export type Line = Segment[];

/** Columns every frame fits in (an 80-column terminal, with room to spare). */
export const WIDTH = 76;
const MARGIN = '  ';
/** Everything after the margin: the title, the stage and the box are all this wide. */
const BODY = WIDTH - MARGIN.length;
/** Inside the box's borders, and inside its two spaces of padding either side. */
const BOX_INNER = BODY - 2;
const CONTENT = BOX_INNER - 4;
const LABEL = 12;
const STAGE_ROWS = 8;
/** How long a terminal may stay connected. */
export const LIVE_MAX_MINUTES = 15;

/** Sent once per connection: hide the cursor, clear the screen, home. */
export const LIVE_PREAMBLE = `${ESC}?25l${ESC}2J${ESC}H`;
/** Shows the cursor again (the end of every goodbye). */
export const SHOW_CURSOR = `${ESC}?25h`;

// ─── Text measuring ──────────────────────────────────────────────────────────

/** Terminal columns a code point takes: 0 (combining), 1, or 2 (wide: emoji, CJK). */
export function charWidth(cp: number): number {
	if (cp < 0x300) return 1;
	if (
		(cp >= 0x300 && cp <= 0x36f) ||
		(cp >= 0x200b && cp <= 0x200f) ||
		(cp >= 0x20d0 && cp <= 0x20ff) ||
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		(cp >= 0x1f3fb && cp <= 0x1f3ff) ||
		(cp >= 0xe0000 && cp <= 0xe007f)
	) {
		return 0;
	}
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x231a && cp <= 0x231b) ||
		(cp >= 0x23e9 && cp <= 0x23f3) ||
		(cp >= 0x2614 && cp <= 0x2615) ||
		(cp >= 0x2648 && cp <= 0x2653) ||
		cp === 0x26a1 ||
		(cp >= 0x26bd && cp <= 0x26be) ||
		cp === 0x2705 ||
		(cp >= 0x270a && cp <= 0x270b) ||
		cp === 0x2728 ||
		cp === 0x274c ||
		(cp >= 0x2753 && cp <= 0x2757) ||
		(cp >= 0x2795 && cp <= 0x2797) ||
		(cp >= 0x2b1b && cp <= 0x2b1c) ||
		cp === 0x2b50 ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f000 && cp <= 0x1faff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

export function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0);
	return width;
}

/** Cut `text` to at most `max` columns, ending in "..." if anything was cut. */
export function truncateTo(text: string, max: number): string {
	if (displayWidth(text) <= max) return text;
	let out = '';
	let width = 0;
	for (const ch of text) {
		const w = charWidth(ch.codePointAt(0) ?? 0);
		if (width + w > max - 3) break;
		out += ch;
		width += w;
	}
	return `${out.trimEnd()}...`;
}

/**
 * Text from outside (update titles) made safe for a terminal: no control characters (so no
 * escape sequences), no bidi overrides, whitespace collapsed.
 */
export function cleanText(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// ─── Numbers and clocks ──────────────────────────────────────────────────────

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** "13d 04:12:35" (or "13d 04:12" without seconds). Never negative. */
export function dayClock(ms: number, seconds: boolean): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(total / 86_400);
	const h = Math.floor((total % 86_400) / 3_600);
	const m = Math.floor((total % 3_600) / 60);
	return `${days}d ${pad2(h)}:${pad2(m)}${seconds ? `:${pad2(total % 60)}` : ''}`;
}

/** "2:14:05": hours, unbounded. */
function hourClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 3_600)}:${pad2(Math.floor((total % 3_600) / 60))}:${pad2(total % 60)}`;
}

const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;

const DAY_TIME: Intl.DateTimeFormatOptions = { weekday: undefined, year: undefined };
const TIME_ONLY: Intl.DateTimeFormatOptions = { weekday: undefined, day: undefined, month: undefined, year: undefined };
const TIME_SECONDS: Intl.DateTimeFormatOptions = { ...TIME_ONLY, second: '2-digit' };

/** The countdown row: label and value. */
export function countdown(state: SiteState, now: number): [string, string] {
	const changed = Date.parse(state.statusChangedAt);
	if (state.status === 'yes') {
		return ['Dad for', `${dayClock(now - changed, false)}  (since ${formatLondon(state.statusChangedAt, DAY_TIME)})`];
	}
	if (state.status === 'soon') {
		return ['In labour', `${hourClock(now - changed)} and counting (since ${formatLondon(state.statusChangedAt, TIME_ONLY)})`];
	}
	if (!state.dueDate) return ['Due', 'not announced. Patience is a virtue.'];
	const target = londonMidnightUtc(state.dueDate);
	if (now < target) return ['Due in', `${dayClock(target - now, true)}  (${formatWeekdayDayMonth(state.dueDate)})`];
	const overdue = daysBetween(state.dueDate, londonDate(new Date(now)));
	if (overdue <= 0) return ['Due', 'today. No pressure.'];
	return ['Overdue', `${plural(overdue, 'day')} overdue. Nobody tell the baby.`];
}

function watching(model: LiveModel, preview: boolean): string {
	const { viewers, terminals } = model;
	if (preview || terminals === 0) return people(viewers);
	if (viewers <= 1) return 'just you, in a terminal';
	const others = terminals === 1 ? "you're the only one in a terminal" : `${formatNumber(terminals)} in terminals, like you`;
	return `${formatNumber(viewers)} (${others})`;
}

function londonClock(now: number): string {
	const iso = new Date(now).toISOString();
	const zone = londonOffsetMs(now) ? 'BST' : 'GMT';
	return `${formatLondon(iso, TIME_SECONDS)} ${zone}, ${formatWeekdayDayMonth(londonDate(new Date(now)))}`;
}

function latestLine(latest: LatestUpdate | null, max: number): string {
	if (!latest) return 'Nothing yet. Which is, in itself, news.';
	const when = ` (${formatLondon(latest.createdAt, DAY_TIME)})`;
	const title = cleanText(latest.title) || 'Untitled';
	return `${truncateTo(title, max - displayWidth(when))}${when}`;
}

// ─── The stage: the answer, plus tape or fireworks ───────────────────────────

type Cell = [Style | null, string];

function blankStage(): Cell[][] {
	return Array.from({ length: STAGE_ROWS }, () => Array.from({ length: BODY }, (): Cell => [null, ' ']));
}

function put(stage: Cell[][], row: number, col: number, style: Style, ch: string): void {
	const line = stage[row];
	if (!line || col < 0 || col >= BODY) return;
	line[col] = [style, ch];
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Two strips of hazard tape (NOT YET), scrolling in opposite directions with each frame. */
function drawTape(stage: Cell[][], frame: number): void {
	const strips: Array<[number, number, string]> = [
		[0, frame, ' CAUTION: DAD UNDER CONSTRUCTION '],
		[STAGE_ROWS - 1, -frame, ' NOT YET. BUT VERY NEARLY. '],
	];
	for (const [row, phase, text] of strips) {
		for (let col = 0; col < BODY; col++) put(stage, row, col, mod(col + phase, 6) < 3 ? 'tape' : 'tapeGap', '/');
		const start = Math.floor((BODY - text.length) / 2);
		for (let i = 0; i < text.length; i++) put(stage, row, start + i, 'tapeText', text[i] as string);
	}
}

/** Small, fast, seedable PRNG (mulberry32): the same fireworks for every terminal. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const FIREWORK_STYLES: readonly Style[] = ['fw0', 'fw1', 'fw2', 'fw3', 'fw4', 'fw5', 'fw6', 'fw7'];
/** cos/sin of every 30 degrees. */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
	[1, 0],
	[0.866, 0.5],
	[0.5, 0.866],
	[0, 1],
	[-0.5, 0.866],
	[-0.866, 0.5],
	[-1, 0],
	[-0.866, -0.5],
	[-0.5, -0.866],
	[0, -1],
	[0.5, -0.866],
	[0.866, -0.5],
];
const ROCKETS = 16;
const ROCKET_EVERY_MS = 600;
const RISE_MS = 450;
const BURST_MS = 1_500;

/** The fireworks `t` ms after the flip: rockets rise from the bottom, burst, drift and fade. */
function drawFireworks(stage: Cell[][], t: number): void {
	for (let i = 0; i < ROCKETS; i++) {
		const rand = prng(i * 7_919 + 17);
		const launch = i * ROCKET_EVERY_MS + Math.floor(rand() * 200);
		const x = 2 + Math.floor(rand() * (BODY - 4));
		const peak = 1 + Math.floor(rand() * 3);
		const style = FIREWORK_STYLES[Math.floor(rand() * FIREWORK_STYLES.length)] ?? 'fw0';
		const age = t - launch;
		if (age < 0) continue;
		if (age < RISE_MS) {
			const y = Math.round(STAGE_ROWS - 1 - (STAGE_ROWS - 1 - peak) * (age / RISE_MS));
			put(stage, y, x, 'bold', '|');
			put(stage, y + 1, x, 'dim', '.');
			continue;
		}
		const p = (age - RISE_MS) / BURST_MS;
		if (p >= 1) continue;
		const radius = 1 + p * 4.5;
		const ch = p < 0.2 ? '@' : p < 0.45 ? '*' : p < 0.7 ? '+' : '.';
		const fall = p * p * 2.5;
		for (const [dx, dy] of DIRECTIONS) {
			put(stage, peak + Math.round(dy * radius * 0.9 + fall), x + Math.round(dx * radius * 2), style, ch);
		}
		// An inner ring, every other direction, so the bursts look full rather than hollow.
		for (let d = 1; d < DIRECTIONS.length; d += 2) {
			const [dx, dy] = DIRECTIONS[d] as readonly [number, number];
			put(stage, peak + Math.round(dy * radius * 0.45 + fall), x + Math.round(dx * radius), style, p < 0.5 ? '+' : '.');
		}
		if (p < 0.15) put(stage, peak, x, style, '*');
	}
}

/** The static celebration after the fireworks: confetti that has settled. */
function drawConfetti(stage: Cell[][]): void {
	const rand = prng(2026);
	const chars = ['*', '+', '.', 'o', '*', '.'];
	for (let i = 0; i < 26; i++) {
		const row = Math.floor(rand() * STAGE_ROWS);
		const col = Math.floor(rand() * BODY);
		put(stage, row, col, FIREWORK_STYLES[i % FIREWORK_STYLES.length] ?? 'fw0', chars[i % chars.length] ?? '*');
	}
}

/** The answer in block letters, centred, drawn over whatever is behind it. */
function drawLetters(stage: Cell[][], status: Status): void {
	const rows = bigText(STATUS_COPY[status].word);
	const width = Math.max(...rows.map((r) => Array.from(r).length));
	const left = Math.floor((BODY - width) / 2);
	rows.forEach((row, r) => {
		const style = `g${r}` as Style;
		Array.from(row).forEach((ch, c) => {
			if (ch !== ' ') put(stage, r + 1, left + c, style, ch);
		});
	});
}

function stageLines(status: Status, opts: FrameOptions): Line[] {
	const stage = blankStage();
	if (status === 'soon') drawTape(stage, opts.frame);
	if (status === 'yes') {
		if (opts.fireworksAt !== undefined) drawFireworks(stage, opts.fireworksAt);
		else drawConfetti(stage);
	}
	drawLetters(stage, status);
	return stage.map((cells) => {
		const line = cellsToLine(cells);
		return line.length ? [[null, MARGIN], ...line] : [];
	});
}

/** Merge runs of same-styled cells into segments; trailing plain spaces are dropped. */
function cellsToLine(cells: Cell[]): Line {
	let end = cells.length;
	while (end > 0 && cells[end - 1]?.[0] === null && cells[end - 1]?.[1] === ' ') end--;
	const line: Line = [];
	let style: Style | null = null;
	let text = '';
	for (let i = 0; i < end; i++) {
		const [s, ch] = cells[i] as Cell;
		if (s !== style && text) {
			line.push([style, text]);
			text = '';
		}
		style = s;
		text += ch;
	}
	if (text) line.push([style, text]);
	return line;
}

// ─── The box ─────────────────────────────────────────────────────────────────

function boxRow(content: Segment[]): Line {
	const width = content.reduce((w, [, text]) => w + displayWidth(text), 0);
	return [[null, MARGIN], ['accent', '│'], [null, '  '], ...content, [null, ' '.repeat(Math.max(0, CONTENT - width) + 2)], ['accent', '│']];
}

const people = (n: number) => (n === 1 ? '1 person' : `${formatNumber(n)} people`);

function field(label: string, value: string, valueStyle: Style | null = null): Line {
	const max = CONTENT - LABEL;
	return boxRow([['dim', label.padEnd(LABEL)], [valueStyle, truncateTo(value, max)]]);
}

// ─── Frames ──────────────────────────────────────────────────────────────────

const GOODBYE: Record<Status, string> = {
	no: "That's your 15 minutes. Still no.",
	soon: "That's your 15 minutes. Still not yet, but it's happening.",
	yes: "That's your 15 minutes. Still yes. Zack is still a dad.",
};

/** Every line of a frame, styled but not yet painted. */
export function liveFrameLines(model: LiveModel, opts: FrameOptions & { final?: boolean }): Line[] {
	const { state } = model;
	const copy = STATUS_COPY[state.status];
	const [label, value] = countdown(state, opts.now);
	const title = 'Is Zack a dad?';
	const badge = '[ LIVE ]';
	const lines: Line[] = [
		[[null, MARGIN], ['dim', title], [null, ' '.repeat(BODY - title.length - badge.length)], ['accent', badge]],
		...stageLines(state.status, opts),
		[[null, MARGIN], ['accent', `╭${'─'.repeat(BOX_INNER)}╮`]],
		boxRow([['bold', truncateTo(copy.sentence, CONTENT)]]),
		boxRow([]),
		field(label, value, 'bold'),
		field('Watching', watching(model, opts.preview === true)),
		field('Vibes', `${formatNumber(model.vibes)} sent`),
		field('Asked', `${plural(model.checks, 'time')}${state.status === 'no' ? '. Still no.' : ''}`),
		field('Latest', latestLine(model.latest, CONTENT - LABEL)),
		field('London', londonClock(opts.now)),
		[[null, MARGIN], ['accent', `╰${'─'.repeat(BOX_INNER)}╯`]],
		[],
	];
	if (opts.final) {
		lines.push([['bold', `${MARGIN}${GOODBYE[state.status]}`]], [[null, `${MARGIN}Run it again: `], ['accent', `curl -N ${DOMAIN}/live`]]);
	} else if (opts.preview) {
		lines.push([['dim', `${MARGIN}Updates the moment anything changes; the clock ticks every 5 seconds.`]]);
	} else {
		lines.push([['dim', `${MARGIN}Ctrl-C to leave. Lost your cursor afterwards? Type: tput cnorm`]]);
	}
	return lines;
}

const FIREWORK_COLOURS = [196, 208, 226, 46, 51, 39, 201, 213] as const;

function ansi(style: Style, status: Status): string {
	switch (style) {
		case 'dim':
			return DIM;
		case 'bold':
			return BOLD;
		case 'accent':
			return `${BOLD}${fg(ACCENT[status])}`;
		case 'tape':
			return `${ESC}38;5;16;48;5;220m`;
		case 'tapeGap':
			return `${ESC}38;5;220;48;5;16m`;
		case 'tapeText':
			return `${ESC}1;38;5;16;48;5;220m`;
		default: {
			const n = Number(style.slice(style.startsWith('fw') ? 2 : 1));
			if (style.startsWith('fw')) return `${BOLD}${fg(FIREWORK_COLOURS[n] ?? 226)}`;
			return `${BOLD}${fg(GRADIENTS[status][n] ?? ACCENT[status])}`;
		}
	}
}

function paint(lines: Line[], status: Status): string[] {
	return lines.map((line) => line.map(([style, text]) => (style ? `${ansi(style, status)}${text}${RESET}` : text)).join(''));
}

/** The terminal's window title (OSC 0). */
function windowTitle(status: Status): string {
	return `\u001b]0;Is Zack a dad? ${STATUS_COPY[status].short}\u0007`;
}

/**
 * One whole-screen frame: home the cursor, draw every line (clearing what was there), then
 * clear anything below. Drawn over the last frame in place, so nothing flickers.
 */
export function renderLiveFrame(model: LiveModel, opts: FrameOptions): string {
	const status = model.state.status;
	const body = paint(liveFrameLines(model, opts), status)
		.map((line) => `${line}${ESC}K`)
		.join('\n');
	return `${opts.bell ? '\u0007' : ''}${windowTitle(status)}${ESC}H${body}\n${ESC}J`;
}

/** The last frame of a connection: the dashboard, the goodbye, and the cursor back. */
export function renderFinalFrame(model: LiveModel, opts: FrameOptions): string {
	const status = model.state.status;
	const body = paint(liveFrameLines(model, { ...opts, fireworksAt: undefined, final: true }), status)
		.map((line) => `${line}${ESC}K`)
		.join('\n');
	return `${windowTitle(status)}${ESC}H${body}\n${ESC}J${SHOW_CURSOR}\n`;
}

/** When the room can't say what the answer is, it still says goodbye properly. */
export const LIVE_FALLBACK_GOODBYE = `\n${MARGIN}Time's up. Run it again: curl -N ${DOMAIN}/live\n${SHOW_CURSOR}`;
