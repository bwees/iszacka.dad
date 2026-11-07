// OWNER: terminal agent.
// The answer in every format anyone could reasonably want, and several nobody asked for:
// GET /api/status.<ext>, Accept negotiation on /api/status, and the /api/formats catalogue.
// Pure: no I/O, nothing built at module scope beyond constant tables.

import { html } from 'hono/html';
import type { Status } from '../types';
import type { StatusDocument } from './feeds-api';
import { statusText } from './feeds-api';
import { DOMAIN, SITE_NAME, STATUS_COPY } from './site';
import { formatLondon, formatLondonDate, formatNumber } from './time';

export type FormatId =
	| 'json'
	| 'txt'
	| 'xml'
	| 'yaml'
	| 'toml'
	| 'csv'
	| 'md'
	| 'html'
	| 'ini'
	| 'sql'
	| 'tap'
	| 'morse'
	| 'braille'
	| 'binary'
	| 'hex'
	| 'emoji'
	| 'nato'
	| 'base64'
	| 'rot13';

export interface FormatInfo {
	/** The file extension: /api/status.<ext>. */
	ext: FormatId;
	name: string;
	/** Content-Type the format is served with. */
	contentType: string;
	/** Media types in an Accept header that select this format on /api/status (lower case). */
	accepts: readonly string[];
	description: string;
}

const TEXT = 'text/plain; charset=utf-8';

/** Every format, in the order /api/formats lists them. json and txt predate the rest. */
export const FORMATS: readonly FormatInfo[] = [
	{ ext: 'json', name: 'JSON', contentType: 'application/json; charset=utf-8', accepts: ['application/json', 'text/json'], description: 'The full status document. The sensible one.' },
	{ ext: 'txt', name: 'Plain text', contentType: TEXT, accepts: ['text/plain'], description: 'One line: no, not yet or yes.' },
	{ ext: 'xml', name: 'XML', contentType: 'application/xml; charset=utf-8', accepts: ['application/xml', 'text/xml'], description: 'For enterprise integrations and the nostalgic.' },
	{ ext: 'yaml', name: 'YAML', contentType: 'application/yaml; charset=utf-8', accepts: ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml'], description: 'Strings quoted, because YAML 1.1 reads an unquoted no as false. Which, to be fair, it is.' },
	{ ext: 'toml', name: 'TOML', contentType: 'application/toml; charset=utf-8', accepts: ['application/toml'], description: "Tom's Obvious, Minimal Language. TOML has no null, which feels apt." },
	{ ext: 'csv', name: 'CSV', contentType: 'text/csv; charset=utf-8; header=present', accepts: ['text/csv'], description: 'A header row and one row of answer, RFC 4180 style. Opens in a spreadsheet, for the board pack.' },
	{ ext: 'md', name: 'Markdown', contentType: 'text/markdown; charset=utf-8; variant=GFM', accepts: ['text/markdown', 'text/x-markdown'], description: 'A heading, a sentence and a table. Paste it into a pull request.' },
	{ ext: 'html', name: 'HTML', contentType: 'text/html; charset=utf-8', accepts: ['text/html'], description: 'A complete, standalone HTML document, as if the homepage were not enough.' },
	{ ext: 'ini', name: 'INI', contentType: TEXT, accepts: [], description: 'One [status] section. Windows 3.1 would have loved it.' },
	{ ext: 'sql', name: 'SQL', contentType: 'application/sql; charset=utf-8', accepts: ['application/sql'], description: 'A SELECT that returns the answer. Bring your own database.' },
	{ ext: 'tap', name: 'TAP', contentType: TEXT, accepts: [], description: 'Test Anything Protocol: one test, failing (TODO) until the baby arrives.' },
	{ ext: 'morse', name: 'Morse code', contentType: TEXT, accepts: [], description: 'Dots and dashes; words split by a slash. -. --- means no.' },
	{ ext: 'braille', name: 'Braille', contentType: TEXT, accepts: [], description: 'Unicode braille patterns (uncontracted).' },
	{ ext: 'binary', name: 'Binary', contentType: TEXT, accepts: [], description: 'The answer as ASCII, eight bits per character.' },
	{ ext: 'hex', name: 'Hexadecimal', contentType: TEXT, accepts: [], description: 'The answer as ASCII, in hex.' },
	{ ext: 'emoji', name: 'Emoji', contentType: TEXT, accepts: [], description: 'One character: 🥚, 🐣 or 👶.' },
	{ ext: 'nato', name: 'NATO phonetic alphabet', contentType: TEXT, accepts: [], description: 'NOVEMBER OSCAR, for reading out over a crackly radio.' },
	{ ext: 'base64', name: 'Base64', contentType: TEXT, accepts: [], description: 'The answer, Base64-encoded, for transport through systems that fear the letter n.' },
	{ ext: 'rot13', name: 'ROT13', contentType: TEXT, accepts: [], description: 'Military-grade encryption, circa 50 BC. Spoilers protected.' },
];

const BY_EXT: ReadonlyMap<string, FormatInfo> = new Map(FORMATS.map((f) => [f.ext, f]));

export function formatInfo(ext: string): FormatInfo | undefined {
	return BY_EXT.get(ext);
}

const WITH_CHECKS: ReadonlySet<FormatId> = new Set<FormatId>(['json', 'xml', 'yaml', 'toml', 'csv', 'md', 'html', 'ini', 'sql']);

/** Whether a format shows the check total (the rest only encode the answer, so skip the lookup). */
export function formatNeedsChecks(ext: FormatId): boolean {
	return WITH_CHECKS.has(ext);
}

/** The /api/status.<ext> paths that are new (json and txt have their own handlers in api.ts). */
export const STATUS_FORMAT_PATHS: readonly string[] = FORMATS.filter((f) => f.ext !== 'json' && f.ext !== 'txt').map((f) => `/api/status.${f.ext}`);

// ─── Accept negotiation ──────────────────────────────────────────────────────

/**
 * Which format an Accept header asks /api/status for. Browsers navigating to the URL (their
 * Accept lists application/xhtml+xml) keep getting JSON, as they always have; so does anything
 * that sends no Accept, a wildcard, or only types we can't do. q-values are honoured, q=0
 * included; ties go to whichever came first.
 */
export function negotiateFormat(accept: string | undefined | null): FormatId {
	if (!accept) return 'json';
	const entries: Array<{ type: string; q: number; order: number }> = [];
	const parts = accept.split(',');
	// A header with hundreds of entries is not a real client: only the first 32 count.
	for (let i = 0; i < parts.length && i < 32; i++) {
		const [rawType = '', ...params] = (parts[i] ?? '').split(';');
		const type = rawType.trim().toLowerCase();
		if (!type) continue;
		let q = 1;
		for (const param of params) {
			const [key, value] = param.split('=');
			if (key?.trim().toLowerCase() === 'q') {
				const n = Number(value?.trim());
				q = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
			}
		}
		entries.push({ type, q, order: i });
	}
	if (entries.some((e) => e.type === 'application/xhtml+xml')) return 'json';
	const refused = new Set(entries.filter((e) => e.q === 0).map((e) => e.type));
	const usable = (id: FormatId) => !(formatInfo(id)?.accepts ?? []).some((t) => refused.has(t));
	entries.sort((a, b) => b.q - a.q || a.order - b.order);
	for (const { type, q } of entries) {
		if (q === 0) continue;
		if (type === '*/*' || type === 'application/*') {
			if (usable('json')) return 'json';
			continue;
		}
		if (type === 'text/*') {
			if (usable('txt')) return 'txt';
			continue;
		}
		const match = FORMATS.find((f) => f.accepts.includes(type));
		if (match) return match.ext;
	}
	return 'json';
}

// ─── Encodings of the one-line answer ────────────────────────────────────────

const MORSE: Readonly<Record<string, string>> = {
	a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--',
	n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..',
};

// Unicode braille, grade 1 (uncontracted): dots 1-6 map to bits 0-5 above U+2800.
const BRAILLE: Readonly<Record<string, string>> = {
	a: '⠁', b: '⠃', c: '⠉', d: '⠙', e: '⠑', f: '⠋', g: '⠛', h: '⠓', i: '⠊', j: '⠚', k: '⠅', l: '⠇', m: '⠍',
	n: '⠝', o: '⠕', p: '⠏', q: '⠟', r: '⠗', s: '⠎', t: '⠞', u: '⠥', v: '⠧', w: '⠺', x: '⠭', y: '⠽', z: '⠵',
};

// ICAO/NATO spellings: Alfa and Juliett, really.
const NATO: Readonly<Record<string, string>> = {
	a: 'ALFA', b: 'BRAVO', c: 'CHARLIE', d: 'DELTA', e: 'ECHO', f: 'FOXTROT', g: 'GOLF', h: 'HOTEL', i: 'INDIA', j: 'JULIETT',
	k: 'KILO', l: 'LIMA', m: 'MIKE', n: 'NOVEMBER', o: 'OSCAR', p: 'PAPA', q: 'QUEBEC', r: 'ROMEO', s: 'SIERRA', t: 'TANGO',
	u: 'UNIFORM', v: 'VICTOR', w: 'WHISKEY', x: 'X-RAY', y: 'YANKEE', z: 'ZULU',
};

/** Spell `text` word by word with a per-letter table; letters without an entry are dropped. */
function spell(text: string, table: Readonly<Record<string, string>>, letterSep: string, wordSep: string): string {
	return text
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.map((word) =>
			Array.from(word)
				.map((ch) => table[ch])
				.filter((s): s is string => s !== undefined)
				.join(letterSep),
		)
		.join(wordSep);
}

export function toMorse(text: string): string {
	return spell(text, MORSE, ' ', ' / ');
}

export function toBraille(text: string): string {
	return spell(text, BRAILLE, '', '⠀'); // U+2800, the blank braille cell
}

export function toNato(text: string): string {
	return spell(text, NATO, ' ', ' / ');
}

/** ASCII only (the answers are), so one byte per character. */
function bytesOf(text: string): number[] {
	return Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
}

export function toBinary(text: string): string {
	return bytesOf(text)
		.map((b) => b.toString(2).padStart(8, '0'))
		.join(' ');
}

export function toHex(text: string): string {
	return bytesOf(text)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join(' ');
}

export function toBase64(text: string): string {
	return btoa(String.fromCharCode(...bytesOf(text)));
}

export function rot13(text: string): string {
	return text.replace(/[a-z]/gi, (ch) => {
		const base = ch <= 'Z' ? 65 : 97;
		return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
	});
}

// ─── Structured formats ──────────────────────────────────────────────────────

/** The fields every structured format carries (the JSON document minus its links). */
function fields(doc: StatusDocument): Array<[string, string | number | boolean | null]> {
	return [
		['isZackADad', doc.isZackADad],
		['status', doc.status],
		['answer', doc.answer],
		['sentence', doc.sentence],
		['statusChangedAt', doc.statusChangedAt],
		['dueDate', doc.dueDate],
		['daysUntilDue', doc.daysUntilDue],
		['checks', doc.checks],
	];
}

const snake = (key: string) => key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

function escapeXml(text: string): string {
	return text.replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch] as string);
}

function renderXml(doc: StatusDocument, self: string): string {
	const rows = fields(doc).map(([key, value]) => (value === null ? `  <${key}/>` : `  <${key}>${escapeXml(String(value))}</${key}>`));
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!-- Is Zack a dad? Asked and answered in XML, as nature intended. -->',
		`<status href="${escapeXml(self)}">`,
		...rows,
		'</status>',
		'',
	].join('\n');
}

function renderYaml(doc: StatusDocument): string {
	// JSON strings are valid YAML double-quoted scalars; null, numbers and booleans read the same.
	const rows = fields(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
	return ['# Is Zack a dad? (YAML edition)', '# Every string is quoted: YAML 1.1 would read a bare no as false, which is right but rude.', '---', ...rows, ''].join('\n');
}

const TOML_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const TOML_DATE = /^\d{4}-\d{2}-\d{2}$/;

function renderToml(doc: StatusDocument): string {
	const rows: string[] = [];
	for (const [key, value] of fields(doc)) {
		if (value === null) {
			rows.push(`# ${key}: not known yet (TOML has no null, which feels apt)`);
		} else if (typeof value === 'string' && (TOML_DATE_TIME.test(value) || TOML_DATE.test(value))) {
			rows.push(`${key} = ${value}`); // TOML dates and date-times go unquoted
		} else {
			// JSON strings are valid TOML basic strings.
			rows.push(`${key} = ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
		}
	}
	return ["# Is Zack a dad? Tom's Obvious, Minimal Language has thoughts.", '', ...rows, ''].join('\n');
}

function csvField(value: string | number | boolean | null): string {
	if (value === null) return '';
	const text = String(value);
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function renderCsv(doc: StatusDocument): string {
	const rows = fields(doc);
	return `${rows.map(([key]) => snake(key)).join(',')}\r\n${rows.map(([, value]) => csvField(value)).join(',')}\r\n`;
}

function renderIni(doc: StatusDocument): string {
	const rows = fields(doc).map(([key, value]) => `${snake(key)} = ${value === null ? '' : String(value)}`);
	return ['; Is Zack a dad? Configuration file for the question.', '; Editing this file will not change the answer.', '', '[status]', ...rows, ''].join('\n');
}

const sqlString = (text: string) => `'${text.replace(/'/g, "''")}'`;

function sqlValue(value: string | number | boolean | null): string {
	if (value === null) return 'NULL';
	if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
	if (typeof value === 'number') return String(value);
	return sqlString(value);
}

function renderSql(doc: StatusDocument): string {
	const columns = fields(doc).map(([key, value]) => `  ${sqlValue(value)} AS ${snake(key)}`);
	return ['-- Is Zack a dad? Run against any database; they all agree.', 'SELECT', columns.join(',\n'), ';', ''].join('\n');
}

function renderTap(doc: StatusDocument): string {
	let line: string;
	if (doc.status === 'yes') line = 'ok 1 - Zack is a dad';
	else if (doc.status === 'soon') line = 'not ok 1 - Zack is a dad # TODO labour in progress, any minute now';
	else if (doc.dueDate) line = `not ok 1 - Zack is a dad # TODO due ${formatLondonDate(doc.dueDate)}`;
	else line = 'not ok 1 - Zack is a dad # TODO due date not announced';
	return ['TAP version 14', '1..1', line, ''].join('\n');
}

function dueSummary(doc: StatusDocument): string {
	if (!doc.dueDate) return 'not announced';
	const when = formatLondonDate(doc.dueDate);
	const days = doc.daysUntilDue ?? 0;
	if (doc.status === 'yes') return `${when} (academic now)`;
	if (days > 0) return `${when} (${formatNumber(days)} day${days === 1 ? '' : 's'} to go)`;
	if (days === 0) return `${when} (today)`;
	return `${when} (${formatNumber(-days)} day${days === -1 ? '' : 's'} overdue)`;
}

function renderMarkdown(doc: StatusDocument, self: string): string {
	const copy = STATUS_COPY[doc.status];
	return [
		'# Is Zack a dad?',
		'',
		`**${copy.short}** ${copy.emoji}`,
		'',
		copy.sentence,
		'',
		'| Field | Value |',
		'| --- | --- |',
		`| Status | \`${doc.status}\` |`,
		`| Since | ${formatLondon(doc.statusChangedAt)} |`,
		`| Due date | ${dueSummary(doc)} |`,
		`| Times asked | ${formatNumber(doc.checks)} |`,
		'',
		`Source: <${self}>`,
		'',
	].join('\n');
}

function renderHtml(doc: StatusDocument, self: string): string {
	const copy = STATUS_COPY[doc.status];
	return html`<!doctype html>
<html lang="en-GB" data-status="${doc.status}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${copy.short} · ${SITE_NAME}</title>
<link rel="canonical" href="${self}">
</head>
<body>
<main>
<h1>Is Zack a dad?</h1>
<p><strong>${copy.short}</strong> ${copy.emoji}</p>
<p>${copy.sentence}</p>
<dl>
<dt>Status</dt><dd><code>${doc.status}</code></dd>
<dt>Since</dt><dd><time datetime="${doc.statusChangedAt}">${formatLondon(doc.statusChangedAt)}</time></dd>
<dt>Due date</dt><dd>${dueSummary(doc)}</dd>
<dt>Times asked</dt><dd>${formatNumber(doc.checks)}</dd>
</dl>
<p><a href="https://${DOMAIN}/">${DOMAIN}</a> · <a href="https://${DOMAIN}/api/formats">other formats</a></p>
</main>
</body>
</html>
`.toString();
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** The one-line answer the encodings encode: no, not yet or yes. */
export function plainAnswer(status: Status): string {
	return statusText(status);
}

/**
 * The status document in a format, as the exact body to send. `self` is the canonical URL of
 * the document (for formats that link to themselves).
 */
export function renderFormat(ext: FormatId, doc: StatusDocument, self: string): string {
	const answer = plainAnswer(doc.status);
	switch (ext) {
		case 'json':
			return `${JSON.stringify(doc, null, 2)}\n`;
		case 'txt':
			return `${answer}\n`;
		case 'xml':
			return renderXml(doc, self);
		case 'yaml':
			return renderYaml(doc);
		case 'toml':
			return renderToml(doc);
		case 'csv':
			return renderCsv(doc);
		case 'md':
			return renderMarkdown(doc, self);
		case 'html':
			return renderHtml(doc, self);
		case 'ini':
			return renderIni(doc);
		case 'sql':
			return renderSql(doc);
		case 'tap':
			return renderTap(doc);
		case 'morse':
			return `${toMorse(answer)}\n`;
		case 'braille':
			return `${toBraille(answer)}\n`;
		case 'binary':
			return `${toBinary(answer)}\n`;
		case 'hex':
			return `${toHex(answer)}\n`;
		case 'emoji':
			return `${STATUS_COPY[doc.status].emoji}\n`;
		case 'nato':
			return `${toNato(answer)}\n`;
		case 'base64':
			return `${toBase64(answer)}\n`;
		case 'rot13':
			return `${rot13(answer)}\n`;
	}
}

/** The /api/formats document. */
export function formatsCatalogue(siteUrl: string): {
	formats: Array<{ ext: FormatId; name: string; contentType: string; url: string; accept: string | null; description: string }>;
	negotiation: string;
} {
	return {
		formats: FORMATS.map((f) => ({
			ext: f.ext,
			name: f.name,
			contentType: f.contentType,
			url: `${siteUrl}/api/status.${f.ext}`,
			accept: f.accepts[0] ?? null,
			description: f.description,
		})),
		negotiation:
			'Or ask /api/status with an Accept header (q-values honoured): application/xml, application/yaml, application/toml, text/csv, text/markdown, application/sql, text/plain or text/html. Browsers, wildcards and anything unrecognised get JSON.',
	};
}
