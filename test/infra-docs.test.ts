// The docs the infra agent owns: links that resolve, the house style's hard rules, and the
// facts they state about the workflows and scripts.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './infra-helpers';

const DOCS = ['README.md', 'CLAUDE.md', 'docs/SETUP.md'] as const;
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** Relative link targets in a markdown file (anchors and query strings dropped). */
function relativeLinks(markdown: string): string[] {
	return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
		.map((m) => m[1] ?? '')
		.filter((href) => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#'))
		.map((href) => href.split('#')[0]?.split('?')[0] ?? '')
		.filter(Boolean);
}

describe.each(DOCS)('%s', (doc) => {
	const text = read(doc);

	it('only links to files that exist', () => {
		const broken = relativeLinks(text).filter((href) => !existsSync(join(ROOT, dirname(doc), href)));
		expect(broken).toEqual([]);
	});

	it('uses no gendered pronouns', () => {
		// Strip code first: the rule is about prose, not `--help` output.
		const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
		expect(prose.match(/\b(he|him|his|himself|she|her|hers|herself)\b/gi) ?? []).toEqual([]);
	});

	it('contains no real-looking email addresses', () => {
		const addresses = [...text.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)].map((m) => m[0]);
		for (const address of addresses) expect(address).toMatch(/@(iszacka\.dad|example\.(com|org|net))$/);
	});
});

describe('README', () => {
	const readme = read('README.md');

	it('points at the architecture contract and the setup guide', () => {
		expect(readme).toContain('(docs/ARCHITECTURE.md)');
		expect(readme).toContain('(docs/SETUP.md)');
	});

	it('mentions the headline features', () => {
		for (const feature of ['WebSocket', 'Dad Ledger', 'MCP', '425 Too Early', 'baby pool', 'Turnstile', 'DNS TXT', 'undo window']) {
			expect(readme.toLowerCase()).toContain(feature.toLowerCase());
		}
	});
});

describe('SETUP.md', () => {
	const setup = read('docs/SETUP.md');

	it('lists the token permissions the workflows and setup script need', () => {
		for (const permission of ['Workers Scripts', 'D1', 'Account Settings', 'Turnstile', 'Zone', 'Workers Routes', 'DNS', 'Zone Settings']) {
			expect(setup).toContain(`| ${permission} |`);
		}
	});

	it('describes the steps the setup script actually performs', () => {
		const script = read('scripts/setup-cloudflare.sh');
		expect(script).toContain('rs POST "/domains"');
		expect(script).toContain('/email/routing/dns');
		expect(script).toContain('rs POST "/webhooks"');
		expect(script).toContain('RESEND_WEBHOOK_SECRET');
		expect(script).toContain('/challenges/widgets');
		expect(script).toContain('/rotate_secret');
		expect(script).toContain('_dmarc.');
		expect(setup).toContain('v=DMARC1; p=quarantine; adkim=r; aspf=r');
		expect(script).toContain('v=DMARC1; p=quarantine; adkim=r; aspf=r');
		expect(setup).toContain('email.received');
		expect(setup).toContain('eu-west-1');
	});

	it("doesn't mention Cloudflare's own email products as if they were used", () => {
		for (const doc of ['README.md', 'CLAUDE.md', 'docs/SETUP.md', 'docs/ARCHITECTURE.md']) {
			const text = read(doc);
			expect(text, doc).not.toMatch(/send_email|Email Sending|catch-all/);
			// Email Routing only appears as the thing the setup script switches off.
			for (const line of text.split('\n').filter((l) => /Email Routing/.test(l))) expect(line, doc).toMatch(/turns it off|switch(es|ed)? (it )?off/i);
		}
	});
});
