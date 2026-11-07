// The corporate pages (src/lib/corporate.ts): the press kit must quote the real palette, and the
// privacy policy must keep up with the schema and the purge jobs.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ISSUES_URL, PRESS_ASSETS, PRESS_FONTS, PRESS_PALETTE, PRIVACY_TABLES, boilerplate, pressBody, privacyBody, termsBody } from '../src/lib/corporate';
import { UNCONFIRMED_TTL_DAYS, UNSUBSCRIBED_TTL_DAYS } from '../src/lib/retention';
import { DAILY_SCORE_CAP } from '../src/lib/stork';

const ROOT = join(__dirname, '..');
const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');

/** The custom properties declared in the first block matching `opener` (e.g. `:root {`). */
function declarations(block: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const [, name = '', value = ''] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(name, value.trim());
	return out;
}

function rootBlock(): string {
	const start = css.indexOf(':root {');
	return css.slice(start, css.indexOf('\n}', start));
}

function darkBlock(): string {
	const start = css.indexOf('@media (prefers-color-scheme: dark)');
	return css.slice(start, css.indexOf('\n}', start));
}

const text = async (h: unknown) => String(await h);

describe('/press', () => {
	it('quotes the palette exactly as public/styles.css declares it', () => {
		const light = declarations(rootBlock());
		const dark = declarations(darkBlock());
		for (const s of PRESS_PALETTE) {
			expect(light.get(s.token), `${s.token} (light)`).toBe(s.light);
			expect(dark.get(s.token), `${s.token} (dark)`).toBe(s.dark);
		}
	});

	it('names the fonts the stylesheet actually uses, with licences that exist', () => {
		const light = declarations(rootBlock());
		for (const f of PRESS_FONTS) {
			expect(light.get(f.token), f.token).toContain(f.name);
			expect(existsSync(join(ROOT, 'public', f.licence)), f.licence).toBe(true);
		}
	});

	it('only offers downloads that exist', () => {
		for (const item of PRESS_ASSETS.flatMap((g) => g.items)) {
			if (item.href === '/badge.svg') continue; // rendered by the Worker
			expect(existsSync(join(ROOT, 'public', item.href)), item.href).toBe(true);
		}
	});

	it('lays down the law on the NO, and has a boilerplate that is true today', async () => {
		const page = await text(pressBody('no'));
		expect(page).toContain('The NO must never be displayed smaller than 400px.');
		expect(page).toContain('/og/no.png');
		expect(page).toContain('/favicon-yes.svg');
		expect(boilerplate('no')).toMatch(/The current answer is NO\.$/);
		expect(boilerplate('yes')).toMatch(/The current answer is YES\.$/);
	});

	it('renders the same markup per status, without double-escaping', async () => {
		expect(String(pressBody('soon'))).toBe(String(pressBody('soon')));
		expect(String(pressBody('soon'))).not.toBe(String(pressBody('no')));
		expect(await text(pressBody('soon'))).not.toContain('&lt;span');
	});
});

describe('/privacy', () => {
	const tables = readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.flatMap((f) => [...readFileSync(join(ROOT, 'migrations', f), 'utf8').matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_0-9]+)/gi)].map((m) => m[1] ?? ''));

	it('accounts for every table in migrations/', () => {
		expect(tables.length).toBeGreaterThan(15);
		const missing = tables.filter((t) => !(t in PRIVACY_TABLES));
		expect(missing, 'add these tables to PRIVACY_TABLES and describe them on /privacy').toEqual([]);
		expect(Object.keys(PRIVACY_TABLES).filter((t) => !tables.includes(t)), 'tables that no longer exist').toEqual([]);
	});

	it('has a row on the page for every table that holds visitor data', async () => {
		const page = await text(privacyBody());
		for (const row of new Set(Object.values(PRIVACY_TABLES).filter((r) => r !== 'site'))) {
			expect(page, row).toContain(`<th scope="row">${row}`);
		}
	});

	it('states the retention periods the purge jobs use', async () => {
		const page = await text(privacyBody());
		expect(UNCONFIRMED_TTL_DAYS).toBe(7);
		expect(UNSUBSCRIBED_TTL_DAYS).toBe(30);
		expect(page).toContain(`deleted after ${UNCONFIRMED_TTL_DAYS} days`);
		expect(page).toContain(`${UNSUBSCRIBED_TTL_DAYS} days after you leave`);
		expect(page).toContain(`${DAILY_SCORE_CAP} scores a day`);
	});

	it('names the processors, the cookies and the way out', async () => {
		const page = await text(privacyBody());
		for (const needle of ['Cloudflare', 'Resend', 'No analytics provider', 'session cookie', 'iszackadad:', 'unsubscribe link', ISSUES_URL, 'sender address hashed']) {
			expect(page, needle).toContain(needle);
		}
		expect(page).toContain('https://github.com/zackpollard/iszacka.dad');
	});

	it('only mentions localStorage keys the scripts really use', () => {
		const scripts = readdirSync(join(ROOT, 'public'))
			.filter((f) => f.endsWith('.js'))
			.map((f) => readFileSync(join(ROOT, 'public', f), 'utf8'))
			.join('\n');
		for (const key of ['stork-best', 'stork-initials', 'stork-sound', "'checks'", "'celebrated'"]) expect(scripts, key).toContain(key);
	});
});

describe('/terms', () => {
	it('quotes the email cap it is given, and the stork rules', async () => {
		const page = await text(termsBody(90));
		expect(page).toContain('at most 90 emails go out a day');
		expect(page).toContain(`${DAILY_SCORE_CAP} scores a day`);
		expect(page).toContain('No pigeon will be dispatched');
		expect(page).toContain('England and Wales');
	});
});
