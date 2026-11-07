import { describe, expect, it } from 'vitest';
import { GLYPHS, bigText, dueLine, isTerminalClient, renderAscii, stripAnsi } from '../src/lib/ascii';
import { formatLondonDate } from '../src/lib/time';
import type { SiteState } from '../src/types';

const NOW = new Date('2026-11-06T12:00:00Z');
const NO: SiteState = { status: 'no', statusChangedAt: '2026-11-01T09:00:00.000Z', dueDate: '2026-11-20' };

describe('isTerminalClient', () => {
	it.each([
		'curl/8.11.1',
		'curl/7.68.0',
		'Wget/1.24.5',
		'Wget/1.21.3 (linux-gnu)',
		'Wget2/2.1.0',
		'HTTPie/3.2.4',
		'xh/0.23.0',
		'  curl/8.0.0',
	])('treats %s as a terminal', (ua) => {
		expect(isTerminalClient(ua)).toBe(true);
	});

	it.each([
		undefined,
		'',
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
		'Mozilla/5.0 (compatible; curl-ish bot)',
		'python-requests/2.32.0',
		'curlish/1.0',
	])('treats %s as not a terminal', (ua) => {
		expect(isTerminalClient(ua)).toBe(false);
	});
});

describe('the block font', () => {
	it('has six rows per glyph, each the same width', () => {
		for (const [ch, glyph] of Object.entries(GLYPHS)) {
			expect(glyph, ch).toHaveLength(6);
			const widths = new Set(glyph.map((row) => Array.from(row).length));
			expect(widths.size, `glyph ${JSON.stringify(ch)}`).toBe(1);
		}
	});

	it('renders NO, NOT YET and YES within 80 columns', () => {
		for (const word of ['NO', 'NOT YET', 'YES']) {
			const rows = bigText(word);
			expect(rows).toHaveLength(6);
			for (const row of rows) expect(Array.from(row).length).toBeLessThanOrEqual(76);
		}
	});

	it('ignores characters it has no glyph for', () => {
		expect(bigText('N?O')).toEqual(bigText('NO'));
	});
});

describe('dueLine', () => {
	it('counts down, hits the day and counts overdue', () => {
		const when = formatLondonDate('2026-11-20');
		expect(when).toMatch(/^Friday,? 20 November 2026$/);
		expect(dueLine(NO, '2026-11-06')).toBe(`Due ${when} (14 days to go).`);
		expect(dueLine(NO, '2026-11-19')).toBe(`Due ${when} (1 day to go).`);
		expect(dueLine(NO, '2026-11-20')).toBe(`Due today, ${when}. No pressure.`);
		expect(dueLine(NO, '2026-11-23')).toBe(`Due ${when} (3 days overdue; nobody tell the baby).`);
		expect(dueLine({ ...NO, dueDate: null }, '2026-11-06')).toBe('Due date: not announced. Patience is a virtue.');
	});

	it('describes labour and fatherhood', () => {
		expect(dueLine({ ...NO, status: 'soon', statusChangedAt: '2026-11-18T03:14:00.000Z' }, '2026-11-18')).toMatch(/^Labour started .*Any minute now\.$/);
		expect(dueLine({ ...NO, status: 'yes', statusChangedAt: '2026-11-18T03:14:00.000Z' }, '2026-11-20')).toMatch(/^Dad since .* \(2 days ago\)\.$/);
	});
});

describe('renderAscii', () => {
	it('draws the answer in coloured block letters', () => {
		const out = renderAscii(NO, { checks: 1234, now: NOW });
		expect(out).toContain('\u001b[');
		const plain = stripAnsi(out);
		for (const row of bigText('NO')) expect(plain).toContain(row);
		expect(out.endsWith('\n')).toBe(true);
	});

	it('includes the sentence, due info, checks and hints in a tidy box', () => {
		const plain = stripAnsi(renderAscii(NO, { checks: 1234, now: NOW, dnsName: 'answer.iszacka.dad' }));
		expect(plain).toContain('Zack is not a dad. Yet.');
		expect(plain).toContain('14 days to go');
		expect(plain).toContain('Asked 1,234 times so far. Still no.');
		expect(plain).toContain('curl -N iszacka.dad/api/stream');
		expect(plain).toContain('dig TXT answer.iszacka.dad');
		const boxRows = plain.split('\n').filter((l) => /^\s*[╭│╰]/.test(l));
		expect(boxRows.length).toBeGreaterThan(5);
		expect(new Set(boxRows.map((r) => Array.from(r).length)).size).toBe(1);
	});

	it('only advertises dig when the DNS record is maintained', () => {
		const plain = stripAnsi(renderAscii(NO, { checks: 1, now: NOW, dnsName: null }));
		expect(plain).not.toContain('dig TXT');
		const boxRows = plain.split('\n').filter((l) => /^\s*[╭│╰]/.test(l));
		expect(new Set(boxRows.map((r) => Array.from(r).length)).size).toBe(1);
	});

	it('uses NOT YET while labour is happening and YES afterwards', () => {
		const soon = stripAnsi(renderAscii({ ...NO, status: 'soon' }, { now: NOW }));
		for (const row of bigText('NOT YET')) expect(soon).toContain(row);
		const yes = stripAnsi(renderAscii({ ...NO, status: 'yes' }, { now: NOW }));
		for (const row of bigText('YES')) expect(yes).toContain(row);
		expect(yes).toContain('Zack is a dad! The baby is here.');
	});

	it('can render without colour', () => {
		const out = renderAscii(NO, { color: false, now: NOW });
		expect(out).not.toContain('\u001b');
		expect(out).toBe(stripAnsi(renderAscii(NO, { now: NOW })));
	});

	it('stays within 80 columns', () => {
		const overdue = { ...NO, dueDate: '2026-10-01' };
		for (const line of stripAnsi(renderAscii(overdue, { checks: 9_999_999, now: NOW })).split('\n')) {
			expect(Array.from(line).length).toBeLessThanOrEqual(80);
		}
	});
});
