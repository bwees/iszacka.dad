// OWNER: feeds agent.
// /badge.svg: a shields.io-style "is zack a dad? | no" badge for READMEs, wikis and
// anywhere else people put badges they will never look at again.

import type { Status } from '../types';
import { escapeXml } from './feeds';

export type BadgeStyle = 'flat' | 'flat-square' | 'for-the-badge';

export const BADGE_STYLES: readonly BadgeStyle[] = ['flat', 'flat-square', 'for-the-badge'];

export const BADGE_DEFAULT_LABEL = 'is zack a dad?';

/** Labels longer than this are trimmed. Nobody needs a 300-character badge. */
export const BADGE_LABEL_MAX = 40;

/**
 * Message colours: red, amber and green, each dark enough for white text to pass
 * WCAG AA (≥ 4.5:1). Shields' own palette doesn't, but we have standards.
 */
export const BADGE_COLOURS: Record<Status, string> = {
	no: '#c62828',
	soon: '#b45309',
	yes: '#2e7d32',
};

export const BADGE_LABEL_COLOUR = '#555';

export function badgeMessage(status: Status): string {
	return status === 'yes' ? 'yes' : status === 'soon' ? 'not yet' : 'no';
}

export function isBadgeStyle(value: unknown): value is BadgeStyle {
	return typeof value === 'string' && (BADGE_STYLES as readonly string[]).includes(value);
}

/**
 * Clean a user-supplied label: strip control and bidi-override characters, collapse
 * whitespace, trim, and cap the length (by code point, so emoji survive intact).
 * `undefined` means "use the default"; an empty string means "no label at all".
 */
export function sanitiseBadgeLabel(raw: string | undefined): string {
	if (raw === undefined) return BADGE_DEFAULT_LABEL;
	const cleaned = raw
		.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return Array.from(cleaned).slice(0, BADGE_LABEL_MAX).join('').trim();
}

// Advance widths of Verdana at 11px (the shields.io font), measured per ASCII glyph.
// Close enough that text never overflows; `textLength` irons out the rest.
const VERDANA_11: Record<string, number> = {
	' ': 3.87, '!': 4.33, '"': 5.05, '#': 9.0, $: 7.0, '%': 11.84, '&': 7.99, "'": 2.95, '(': 4.99, ')': 4.99,
	'*': 7.0, '+': 9.0, ',': 4.0, '-': 4.99, '.': 4.0, '/': 4.99, ':': 4.99, ';': 4.99, '<': 9.0, '=': 9.0,
	'>': 9.0, '?': 5.97, '@': 11.0, '[': 4.99, '\\': 4.99, ']': 4.99, '^': 9.0, _: 7.0, '`': 7.0, '{': 6.98,
	'|': 4.99, '}': 6.98, '~': 9.0,
	A: 7.52, B: 7.54, C: 7.68, D: 8.48, E: 6.96, F: 6.32, G: 8.53, H: 8.27, I: 4.63, J: 5.0, K: 7.62, L: 6.12,
	M: 9.27, N: 8.23, O: 8.66, P: 6.63, Q: 8.66, R: 7.65, S: 7.52, T: 6.78, U: 8.05, V: 7.52, W: 10.88, X: 7.54,
	Y: 6.77, Z: 7.54,
	a: 6.61, b: 6.82, c: 5.73, d: 6.82, e: 6.55, f: 3.78, g: 6.82, h: 6.96, i: 3.02, j: 3.78, k: 6.51, l: 3.02,
	m: 10.69, n: 6.96, o: 6.68, p: 6.82, q: 6.82, r: 4.69, s: 5.73, t: 4.33, u: 6.96, v: 6.51, w: 8.98, x: 6.51,
	y: 6.51, z: 5.73,
};
const DIGIT_WIDTH = 7.0;
const FALLBACK_WIDTH = 7.0;
const WIDE_WIDTH = 11.0;

/** True for code points that render roughly 1em wide (CJK, emoji, etc.). */
function isWide(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
		(codePoint >= 0x20000 && codePoint <= 0x3fffd)
	);
}

/** Zero-width code points: combining marks, joiners and variation selectors. */
function isZeroWidth(codePoint: number): boolean {
	return (
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		codePoint === 0x200d ||
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
		(codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
	);
}

/**
 * Estimated rendered width in px of `text` in Verdana. `size` scales from the 11px
 * table, `bold` adds Verdana Bold's extra heft, and `letterSpacing` is per glyph.
 */
export function estimateTextWidth(text: string, opts: { size?: number; bold?: boolean; letterSpacing?: number } = {}): number {
	const scale = (opts.size ?? 11) / 11;
	const boldFactor = opts.bold ? 1.1 : 1;
	let width = 0;
	let glyphs = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if (isZeroWidth(cp)) continue;
		glyphs++;
		if (ch >= '0' && ch <= '9') width += DIGIT_WIDTH;
		else width += VERDANA_11[ch] ?? (isWide(cp) ? WIDE_WIDTH : FALLBACK_WIDTH);
	}
	const spacing = (opts.letterSpacing ?? 0) * Math.max(0, glyphs - 1);
	return width * scale * boldFactor + spacing;
}

export interface BadgeOptions {
	label: string;
	message: string;
	colour: string;
	style: BadgeStyle;
}

const FONT = 'Verdana,Geneva,DejaVu Sans,sans-serif';

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Render the badge SVG. Every piece of text is XML-escaped. */
export function renderBadge(opts: BadgeOptions): string {
	const x = escapeXml;
	const big = opts.style === 'for-the-badge';
	const label = big ? opts.label.toUpperCase() : opts.label;
	const message = big ? opts.message.toUpperCase() : opts.message;
	const height = big ? 28 : 20;
	const padding = big ? 12 : 5;
	const fontSize = big ? 10 : 11;
	const letterSpacing = big ? 1.25 : 0;

	const labelText = label ? Math.ceil(estimateTextWidth(label, { size: fontSize, letterSpacing })) : 0;
	const messageText = Math.ceil(estimateTextWidth(message, { size: fontSize, bold: big, letterSpacing }));
	const labelWidth = label ? labelText + padding * 2 : 0;
	const messageWidth = messageText + padding * 2;
	const width = labelWidth + messageWidth;

	const accessibleName = label ? `${opts.label}: ${opts.message}` : opts.message;
	const baseline = big ? 18 : 14;
	const spacingAttr = big ? ` letter-spacing="${letterSpacing}"` : '';
	const textAttrs = (w: number) => `textLength="${w}" lengthAdjust="spacingAndGlyphs"`;

	const labelX = round1(labelWidth / 2);
	const messageX = round1(labelWidth + messageWidth / 2);

	const shadow = opts.style === 'flat';
	const texts: string[] = [];
	if (label) {
		if (shadow) texts.push(`<text aria-hidden="true" x="${labelX}" y="${baseline + 1}" fill="#010101" fill-opacity=".3" ${textAttrs(labelText)}>${x(label)}</text>`);
		texts.push(`<text x="${labelX}" y="${baseline}" ${textAttrs(labelText)}>${x(label)}</text>`);
	}
	if (shadow) texts.push(`<text aria-hidden="true" x="${messageX}" y="${baseline + 1}" fill="#010101" fill-opacity=".3" ${textAttrs(messageText)}>${x(message)}</text>`);
	texts.push(`<text x="${messageX}" y="${baseline}"${big ? ' font-weight="bold"' : ''} ${textAttrs(messageText)}>${x(message)}</text>`);

	const rects = [
		label ? `<rect width="${labelWidth}" height="${height}" fill="${BADGE_LABEL_COLOUR}"/>` : '',
		`<rect x="${labelWidth}" width="${messageWidth}" height="${height}" fill="${x(opts.colour)}"/>`,
		opts.style === 'flat' ? `<rect width="${width}" height="${height}" fill="url(#s)"/>` : '',
	].join('');

	const defs =
		opts.style === 'flat'
			? `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${width}" height="${height}" rx="3" fill="#fff"/></clipPath>`
			: '';

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${x(accessibleName)}">`,
		`<title>${x(accessibleName)}</title>`,
		defs,
		`<g${opts.style === 'flat' ? ' clip-path="url(#r)"' : ' shape-rendering="crispEdges"'}>${rects}</g>`,
		`<g fill="#fff" text-anchor="middle" font-family="${FONT}" text-rendering="geometricPrecision" font-size="${fontSize}"${spacingAttr}>${texts.join('')}</g>`,
		'</svg>',
		'',
	].join('');
}
