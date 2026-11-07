// Keeps scripts/smoke.sh honest: every path in the docs/ARCHITECTURE.md URL map must be
// exercised by the smoke test, or listed in its `smoke:skip` block with a reason.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT, run, scratchDir } from './infra-helpers';

/** `/favicon-{no,soon,yes}.svg` → three paths. One level of braces is all the map uses. */
function expandBraces(path: string): string[] {
	const match = /\{([^{}]+)\}/.exec(path);
	if (!match) return [path];
	const [whole, options = ''] = match;
	return options.split(',').flatMap((option) => expandBraces(path.replace(whole, option.trim())));
}

/**
 * Every path in the "## URL map" table: backticked spans in the URLs column, query strings
 * dropped, `(+\`.json\`)` style suffixes appended to the path before them, braces expanded.
 */
function urlMapPaths(markdown: string): string[] {
	const section = markdown.split(/^## URL map[ \t]*$/m)[1]?.split(/^## /m)[0] ?? '';
	const paths = new Set<string>();
	for (const line of section.split('\n')) {
		if (!line.startsWith('|') || /^\|\s*(Owner\b|-)/.test(line)) continue;
		const urls = line.split('|')[2] ?? '';
		let previous = '';
		for (const [, span = ''] of urls.matchAll(/`([^`]+)`/g)) {
			const token = span.split('?')[0] ?? '';
			if (token.startsWith('/')) {
				previous = token;
				for (const path of expandBraces(token)) paths.add(path);
			} else if (token.startsWith('.') && previous) {
				for (const path of expandBraces(previous + token)) paths.add(path);
			}
		}
	}
	return [...paths];
}

/** A regex that finds a concrete use of `path` in the script: `:param` segments match any value. */
function pathPattern(path: string): RegExp {
	const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/\\s"\'?]+');
	return new RegExp(`${escaped}(?![A-Za-z0-9_/-])`);
}

/** Paths in the script's `# smoke:skip <path> <reason>` comment lines. */
function skippedPaths(script: string): string[] {
	return [...script.matchAll(/^#\s+smoke:skip\s+(\S+)\s+\S/gm)].map((m) => m[1] ?? '');
}

const architecture = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
const smoke = readFileSync(join(ROOT, 'scripts/smoke.sh'), 'utf8');

describe('URL map parsing', () => {
	it('expands braces', () => {
		expect(expandBraces('/favicon-{no,soon,yes}.svg')).toEqual(['/favicon-no.svg', '/favicon-soon.svg', '/favicon-yes.svg']);
		expect(expandBraces('/plain')).toEqual(['/plain']);
	});

	it('reads suffixes, queries and braces out of a table row', () => {
		const md = [
			'## URL map',
			'',
			'| Owner | URLs |',
			'|---|---|',
			'| feeds | `/feed.xml` (+`/rss.xml`), `/api/status` (+`.json`), `/og/card?status=`, static `/og/{no,yes}.png` |',
			'',
			'## Next section',
			'| x | `/not-in-the-map` |',
		].join('\n');
		expect(urlMapPaths(md).sort()).toEqual(
			['/api/status', '/api/status.json', '/feed.xml', '/og/card', '/og/no.png', '/og/yes.png', '/rss.xml'].sort(),
		);
	});

	it('matches parameters but not prefixes', () => {
		expect(pathPattern('/updates/:id').test('request GET /updates/999999999')).toBe(true);
		expect(pathPattern('/webhooks/:token/delete').test('POST "/webhooks/$BOGUS/delete"')).toBe(true);
		expect(pathPattern('/webhooks/:token/delete').test('POST "/webhooks/$BOGUS/test"')).toBe(false);
		expect(pathPattern('/api').test('json_endpoint /api/history')).toBe(false);
		expect(pathPattern('/api').test('html_page /api\n')).toBe(true);
	});

	it('finds the whole real map', () => {
		const paths = urlMapPaths(architecture);
		expect(paths.length).toBeGreaterThan(80);
		for (const known of ['/', '/api/dad', '/mcp', '/ws', '/admin/status', '/favicon-soon.svg', '/api/status.json', '/rss.xml']) {
			expect(paths).toContain(known);
		}
	});
});

describe('scripts/smoke.sh', () => {
	const skipped = skippedPaths(smoke);
	const paths = urlMapPaths(architecture);
	const scratch = scratchDir('smoke');
	afterAll(scratch.cleanup);
	const smokeRun = (...args: string[]) =>
		run('bash', [join(ROOT, 'scripts/smoke.sh'), ...args], { env: { TMPDIR: scratch.dir }, timeoutMs: 20_000 });

	it('covers every path in the ARCHITECTURE.md URL map (or says why not)', () => {
		const missing = paths.filter((path) => !skipped.includes(path) && !pathPattern(path).test(smoke));
		expect(missing, `add these to scripts/smoke.sh, or to its smoke:skip list with a reason`).toEqual([]);
	});

	it('only skips paths that are in the map, and only a few', () => {
		expect(skipped.filter((path) => !paths.includes(path))).toEqual([]);
		expect(skipped.length).toBeLessThanOrEqual(5);
	});

	it('is valid bash', async () => {
		const result = await run('bash', ['-n', join(ROOT, 'scripts/smoke.sh')]);
		expect(result.code, result.stderr).toBe(0);
	});

	it('explains itself and rejects nonsense arguments', async () => {
		const help = await smokeRun('--help');
		expect(help.code).toBe(0);
		expect(help.stdout).toContain('--mutate');
		expect(help.stdout).not.toContain('set -euo pipefail');
		expect((await smokeRun()).code).toBe(2);
		expect((await smokeRun('ftp://example.com')).code).toBe(2);
		expect((await smokeRun('https://example.com/with/path')).code).toBe(2);
		expect((await smokeRun('http://localhost:1', '--frobnicate')).code).toBe(2);
	});

	it('fails fast when nothing is listening', async () => {
		const result = await smokeRun('http://127.0.0.1:9');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Can't reach");
	});
});
