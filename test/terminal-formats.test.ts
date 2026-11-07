import { describe, expect, it } from 'vitest';
import { buildStatusDocument } from '../src/lib/feeds-api';
import {
	FORMATS,
	type FormatId,
	STATUS_FORMAT_PATHS,
	formatInfo,
	formatNeedsChecks,
	formatsCatalogue,
	negotiateFormat,
	plainAnswer,
	renderFormat,
	rot13,
	toBase64,
	toBinary,
	toBraille,
	toHex,
	toMorse,
	toNato,
} from '../src/lib/formats';
import type { SiteState, Status } from '../src/types';

const SITE = 'https://iszacka.dad';
const TODAY = '2026-11-07';
const state = (status: Status, dueDate: string | null = '2026-11-20'): SiteState => ({ status, statusChangedAt: '2026-11-01T09:00:00.000Z', dueDate });
const doc = (status: Status, dueDate: string | null = '2026-11-20', checks = 1234) =>
	buildStatusDocument(state(status, dueDate), { checks, today: TODAY, siteUrl: SITE });
const render = (ext: FormatId, status: Status = 'no', dueDate: string | null = '2026-11-20') => renderFormat(ext, doc(status, dueDate), `${SITE}/api/status.${ext}`);

describe('the catalogue', () => {
	it('has at least the fifteen formats in the brief, each unique', () => {
		const exts = FORMATS.map((f) => f.ext);
		expect(new Set(exts).size).toBe(exts.length);
		for (const ext of ['json', 'txt', 'xml', 'yaml', 'toml', 'csv', 'md', 'html', 'morse', 'braille', 'binary', 'hex', 'emoji', 'nato', 'base64', 'rot13', 'ini']) {
			expect(exts).toContain(ext);
		}
		expect(exts.length).toBeGreaterThanOrEqual(15);
	});

	it('gives every format a content type with a charset, and a description', () => {
		for (const f of FORMATS) {
			expect(f.contentType, f.ext).toMatch(/charset=utf-8/);
			expect(f.description.length, f.ext).toBeGreaterThan(10);
			expect(formatInfo(f.ext)).toBe(f);
		}
		expect(formatInfo('docx')).toBeUndefined();
	});

	it('serves new paths for everything except json and txt, which have their own handlers', () => {
		expect(STATUS_FORMAT_PATHS).not.toContain('/api/status.json');
		expect(STATUS_FORMAT_PATHS).not.toContain('/api/status.txt');
		expect(STATUS_FORMAT_PATHS).toContain('/api/status.morse');
		expect(STATUS_FORMAT_PATHS).toHaveLength(FORMATS.length - 2);
	});

	it('lists every format with its URL for /api/formats', () => {
		const catalogue = formatsCatalogue(SITE);
		expect(catalogue.formats).toHaveLength(FORMATS.length);
		expect(catalogue.formats.find((f) => f.ext === 'yaml')).toMatchObject({ url: `${SITE}/api/status.yaml`, accept: 'application/yaml' });
		expect(catalogue.formats.find((f) => f.ext === 'morse')?.accept).toBeNull();
		expect(catalogue.negotiation).toContain('Accept');
	});

	it('only looks up the check total for formats that show it', () => {
		expect(formatNeedsChecks('json')).toBe(true);
		expect(formatNeedsChecks('csv')).toBe(true);
		expect(formatNeedsChecks('morse')).toBe(false);
		expect(formatNeedsChecks('emoji')).toBe(false);
		// Every format that doesn't ask for it really doesn't print it.
		for (const f of FORMATS) {
			if (formatNeedsChecks(f.ext)) continue;
			expect(render(f.ext).includes('1234') || render(f.ext).includes('1,234'), f.ext).toBe(false);
		}
	});
});

describe('Accept negotiation', () => {
	it.each([
		[undefined, 'json'],
		['', 'json'],
		['*/*', 'json'],
		['application/json', 'json'],
		['application/xml', 'xml'],
		['text/xml', 'xml'],
		['application/yaml', 'yaml'],
		['text/x-yaml', 'yaml'],
		['application/toml', 'toml'],
		['text/csv', 'csv'],
		['text/markdown', 'md'],
		['application/sql', 'sql'],
		['text/plain', 'txt'],
		['text/html', 'html'],
		['text/*', 'txt'],
		['TEXT/CSV', 'csv'],
		['image/png', 'json'],
		['application/pdf, image/*', 'json'],
	] as const)('Accept %j gets %s', (accept, want) => {
		expect(negotiateFormat(accept)).toBe(want);
	});

	it('keeps giving browsers JSON (they ask for xhtml+xml)', () => {
		expect(negotiateFormat('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe('json');
	});

	it('honours q-values, ties going to the first listed', () => {
		expect(negotiateFormat('application/xml;q=0.5, application/yaml;q=0.9')).toBe('yaml');
		expect(negotiateFormat('text/csv, application/yaml')).toBe('csv');
		expect(negotiateFormat('application/toml;q=0.1, */*;q=0.2')).toBe('json');
		expect(negotiateFormat('text/csv; charset=utf-8; q=1, text/plain;q=0.2')).toBe('csv');
	});

	it('never picks a type refused with q=0', () => {
		expect(negotiateFormat('application/xml;q=0')).toBe('json');
		expect(negotiateFormat('text/plain;q=0, text/*')).toBe('json');
		expect(negotiateFormat('application/json;q=0, */*')).toBe('json'); // there's nothing else to fall back to
	});

	it('ignores junk and stops reading absurdly long headers', () => {
		expect(negotiateFormat(',,;;q=,text/csv;q=abc')).toBe('csv');
		const huge = `${Array.from({ length: 100 }, (_, i) => `x/y${i}`).join(', ')}, text/csv`;
		expect(negotiateFormat(huge)).toBe('json');
	});
});

describe('the encodings', () => {
	it('spells the answer in Morse, words split by a slash', () => {
		expect(toMorse('no')).toBe('-. ---');
		expect(toMorse('not yet')).toBe('-. --- - / -.-- . -');
		expect(toMorse('yes')).toBe('-.-- . ...');
		expect(render('morse')).toBe('-. ---\n');
	});

	it('writes uncontracted braille, with a blank cell between words', () => {
		expect(toBraille('no')).toBe('⠝⠕');
		expect(toBraille('not yet')).toBe('⠝⠕⠞⠀⠽⠑⠞');
	});

	it('uses the ICAO spellings', () => {
		expect(toNato('no')).toBe('NOVEMBER OSCAR');
		expect(toNato('yes')).toBe('YANKEE ECHO SIERRA');
		expect(toNato('not yet')).toBe('NOVEMBER OSCAR TANGO / YANKEE ECHO TANGO');
	});

	it('does bits, hex and Base64 of the ASCII', () => {
		expect(toBinary('no')).toBe('01101110 01101111');
		expect(toHex('yes')).toBe('79 65 73');
		expect(toBase64('no')).toBe('bm8=');
		expect(atob(toBase64('not yet'))).toBe('not yet');
	});

	it('rotates thirteen, which undoes itself', () => {
		expect(rot13('no')).toBe('ab');
		expect(rot13('Not Yet')).toBe('Abg Lrg');
		expect(rot13(rot13('yes, really'))).toBe('yes, really');
	});

	it('hatches the emoji with the status', () => {
		expect(render('emoji', 'no')).toBe('🥚\n');
		expect(render('emoji', 'soon')).toBe('🐣\n');
		expect(render('emoji', 'yes')).toBe('👶\n');
	});

	it('encodes no, not yet and yes', () => {
		expect(plainAnswer('no')).toBe('no');
		expect(plainAnswer('soon')).toBe('not yet');
		expect(plainAnswer('yes')).toBe('yes');
		expect(render('txt', 'soon')).toBe('not yet\n');
		expect(render('rot13', 'yes')).toBe('lrf\n');
	});
});

describe('the structured formats', () => {
	it('renders JSON exactly like the status document', () => {
		expect(JSON.parse(render('json'))).toEqual(doc('no'));
	});

	it('renders XML with every field and escapes what needs it', () => {
		const xml = render('xml', 'no', null);
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(xml).toContain(`<status href="${SITE}/api/status.xml">`);
		expect(xml).toContain('<isZackADad>false</isZackADad>');
		expect(xml).toContain('<dueDate/>');
		expect(xml).toContain('<checks>1234</checks>');
		expect(xml).not.toMatch(/&(?!(lt|gt|amp|quot|apos);)/);
	});

	it('quotes every YAML string, so a bare no is never read as false', () => {
		const yaml = render('yaml');
		expect(yaml).toContain('status: "no"');
		expect(yaml).toContain('isZackADad: false');
		expect(yaml).toContain('dueDate: "2026-11-20"');
		expect(render('yaml', 'no', null)).toContain('dueDate: null');
	});

	it('writes TOML with real dates and comments out the nulls', () => {
		const toml = render('toml');
		expect(toml).toContain('status = "no"');
		expect(toml).toContain('dueDate = 2026-11-20');
		expect(toml).toContain('statusChangedAt = 2026-11-01T09:00:00.000Z');
		const none = render('toml', 'no', null);
		expect(none).toMatch(/^# dueDate: /m);
		expect(none).not.toMatch(/^dueDate =/m);
	});

	it('writes one CSV header row and one data row, CRLF, quoting where needed', () => {
		const csv = render('csv', 'soon');
		const rows = csv.split('\r\n');
		expect(rows).toHaveLength(3);
		expect(rows[2]).toBe('');
		expect(rows[0]).toBe('is_zack_a_dad,status,answer,sentence,status_changed_at,due_date,days_until_due,checks');
		expect(rows[1]?.startsWith('false,soon,NOT YET,')).toBe(true);
		// The NOT YET sentence has a comma in it, so it's quoted.
		expect(rows[1]).toMatch(/,"[^"]*,[^"]*",/);
	});

	it('writes INI with a [status] section', () => {
		const ini = render('ini', 'yes');
		expect(ini).toContain('[status]');
		expect(ini).toContain('is_zack_a_dad = true');
		expect(ini).toContain('status = yes');
	});

	it('writes SQL that escapes its quotes', () => {
		const sql = render('sql', 'soon');
		expect(sql).toContain('FALSE AS is_zack_a_dad');
		expect(sql).toContain("'soon' AS status");
		expect(sql).toMatch(/'[^']*''[^']*' AS sentence|'[^']*' AS sentence/);
		expect(sql.trimEnd().endsWith(';')).toBe(true);
		expect(render('sql', 'no', null)).toContain('NULL AS due_date');
	});

	it('writes TAP: failing (TODO) until YES', () => {
		expect(render('tap', 'no')).toContain('not ok 1 - Zack is a dad # TODO due');
		expect(render('tap', 'no', null)).toContain('# TODO due date not announced');
		expect(render('tap', 'soon')).toContain('# TODO labour in progress');
		expect(render('tap', 'yes')).toContain('\nok 1 - Zack is a dad');
		expect(render('tap').startsWith('TAP version 14\n1..1\n')).toBe(true);
	});

	it('writes Markdown with a heading and a table', () => {
		const md = render('md');
		expect(md.startsWith('# Is Zack a dad?\n')).toBe(true);
		expect(md).toContain('| Status | `no` |');
		expect(md).toContain('13 days to go');
		expect(md).toContain('| Times asked | 1,234 |');
		expect(render('md', 'no', '2026-11-01')).toContain('6 days overdue');
		expect(render('md', 'no', null)).toContain('| Due date | not announced |');
	});

	it('writes a standalone HTML document, with no scripts', () => {
		const page = render('html', 'yes');
		expect(page.startsWith('<!doctype html>')).toBe(true);
		expect(page).toContain('data-status="yes"');
		expect(page).toContain(`<link rel="canonical" href="${SITE}/api/status.html">`);
		expect(page).not.toMatch(/<script/i);
	});

	it('renders every format for every status without throwing, ending in a newline', () => {
		for (const status of ['no', 'soon', 'yes'] as const) {
			for (const f of FORMATS) {
				for (const due of ['2026-11-20', null]) {
					const body = render(f.ext, status, due);
					expect(body.length, `${f.ext}/${status}`).toBeGreaterThan(0);
					expect(body.endsWith('\n'), `${f.ext}/${status}`).toBe(true);
				}
			}
		}
	});
});
