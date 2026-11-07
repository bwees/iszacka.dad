import { describe, expect, it } from 'vitest';
import {
	PUBLIC_PAGES,
	renderHumansTxt,
	renderLlmsTxt,
	renderRobotsTxt,
	renderSecurityTxt,
	renderSitemap,
	securityTxtExpiry,
} from '../src/lib/feeds-text';
import type { SiteState, Update } from '../src/types';

const SITE = 'https://iszacka.dad';
const NO: SiteState = { status: 'no', statusChangedAt: '2026-11-01T09:00:00.000Z', dueDate: '2026-11-20' };
const PRONOUNS = /\b(he|she|him|her|his|hers)\b/i;

describe('security.txt (RFC 9116)', () => {
	const now = new Date('2026-11-06T21:30:00Z');
	const txt = renderSecurityTxt({ siteUrl: SITE, now });

	it('has Contact, a future Expires about a year out, and Canonical', () => {
		expect(txt).toContain('Contact: https://github.com/zackpollard/iszacka.dad/security/advisories/new');
		// Mail to the domain only reaches the auto-responder, so it must not be the contact.
		expect(txt).not.toContain('mailto:');
		expect(txt).toContain('Canonical: https://iszacka.dad/.well-known/security.txt');
		const expires = /^Expires: (.+)$/m.exec(txt)?.[1];
		expect(expires).toBe('2027-11-06T00:00:00Z');
		const days = (Date.parse(expires ?? '') - now.getTime()) / 86_400_000;
		expect(days).toBeGreaterThan(360);
		expect(days).toBeLessThan(366);
	});

	it('is computed at request time', () => {
		expect(securityTxtExpiry(new Date('2030-01-15T10:00:00Z'))).toBe('2031-01-15T00:00:00Z');
	});

	it('sends vulnerabilities in the baby to Jess', () => {
		expect(txt).toMatch(/vulnerability in the baby\?[\s\S]*report it to Jess/);
		expect(txt).not.toMatch(PRONOUNS);
	});

	it('has only comments, blank lines and known fields', () => {
		for (const line of txt.trimEnd().split('\n')) {
			expect(line === '' || line.startsWith('#') || /^(Contact|Expires|Preferred-Languages|Canonical): \S/.test(line), line).toBe(true);
		}
	});
});

describe('robots.txt', () => {
	it('allows crawling and points at the sitemap in production', () => {
		const txt = renderRobotsTxt({ siteUrl: SITE, indexable: true });
		expect(txt).toContain('User-agent: *');
		expect(txt).toContain('Disallow: /admin');
		expect(txt).toContain('Sitemap: https://iszacka.dad/sitemap.xml');
	});

	it('blocks everything on previews', () => {
		const txt = renderRobotsTxt({ siteUrl: SITE, indexable: false });
		expect(txt).toContain('Disallow: /\n');
		expect(txt).not.toContain('Sitemap:');
	});
});

describe('sitemap.xml', () => {
	const updates: Update[] = [
		{ id: 7, kind: 'daily', title: 'x', body: '', status: 'no', audience: 'daily', createdAt: '2026-11-05T09:00:00.000Z', notifiedAt: null },
	];
	const xml = renderSitemap({ siteUrl: SITE, state: NO, updates });

	it('lists every public page and the update pages', () => {
		for (const page of PUBLIC_PAGES) expect(xml).toContain(`<loc>${SITE}${page.path}</loc>`);
		expect(xml).toContain(`<loc>${SITE}/updates/7</loc><lastmod>2026-11-05T09:00:00.000Z</lastmod>`);
		expect(xml).toContain(`<loc>${SITE}/</loc><lastmod>2026-11-01T09:00:00.000Z</lastmod>`);
		expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
	});

	it('covers the pages in the URL map', () => {
		const paths = PUBLIC_PAGES.map((p) => p.path);
		for (const path of ['/', '/updates', '/everything', '/pool', '/status', '/certificate', '/poster', '/ready', '/wall', '/names', '/ledger', '/stats', '/subscribe', '/api']) {
			expect(paths).toContain(path);
		}
	});
});

describe('llms.txt', () => {
	const txt = renderLlmsTxt({ siteUrl: SITE, state: NO, today: '2026-11-06' });

	it('follows the llmstxt.org shape: H1, blockquote, H2 link lists', () => {
		const lines = txt.split('\n');
		expect(lines[0]).toBe('# Is Zack a Dad?');
		expect(lines[2]?.startsWith('> ')).toBe(true);
		expect(txt).toContain('## API');
		expect(txt).toContain('## Optional');
		expect(txt).toMatch(/^- \[Status \(JSON\)\]\(https:\/\/iszacka\.dad\/api\/status\): /m);
	});

	it('states the live answer and the ground rules', () => {
		expect(txt).toContain('Status: `no`');
		expect(txt).toContain('14 days away');
		expect(txt).toMatch(/don't guess or invent/);
		expect(txt).not.toMatch(PRONOUNS);
	});
});

describe('humans.txt', () => {
	it('credits the team without pronouns', () => {
		const txt = renderHumansTxt({ state: NO, lastUpdated: '2026-11-05T09:00:00.000Z', checks: 12345 });
		expect(txt).toContain('/* TEAM */');
		expect(txt).toContain('/* SITE */');
		expect(txt).toContain('Last update: 2026-11-05');
		expect(txt).toContain('12,345 checks');
		expect(txt).not.toMatch(PRONOUNS);
	});
});
