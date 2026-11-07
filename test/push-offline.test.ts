import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const offline = readFileSync(join(ROOT, 'public/offline.html'), 'utf8');
const sw = readFileSync(join(ROOT, 'public/sw.js'), 'utf8');

describe('offline fallback', () => {
	it('never guesses the answer (an old NO after a YES is the worst outcome)', () => {
		for (const text of [offline, sw]) {
			expect(text).not.toMatch(/still not a dad/i);
		}
		expect(offline).not.toContain('data-status="no"');
		expect(offline).not.toContain('favicon-no.svg');
	});

	it("uses the site shell's header and footer structure, with no scripts", () => {
		expect(offline).toContain('<header class="site-header"><div class="wrap header-inner">');
		expect(offline).toContain('<footer class="site-footer"><div class="wrap">');
		expect(offline).not.toMatch(/<script/i);
	});

	it('notification clicks never navigate other tabs', () => {
		expect(sw).not.toContain('client.navigate(');
		expect(sw).toContain('.pathname === target.pathname');
	});

	it("asks /api/status as a poll, so pushes aren't counted as checks", () => {
		expect(sw).toContain("'/api/status?poll=1'");
	});
});
