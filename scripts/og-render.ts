// Renders the social preview cards in public/og/{no,soon,yes}.png. These are the
// only OG images the site has: /og.png serves the one for the status straight from
// static assets (routes/ledger.ts), with no rendering at request time, because a
// Workers Free invocation gets 10 ms of CPU and a headless browser needs far more.
//
//   node scripts/og-render.ts [outDir] [--screenshot]
//
// Writes one self-contained HTML card per status (renderOgCardHtml in
// src/lib/og-card.ts, the same markup as the /og/card preview route) into outDir
// (default node_modules/.cache/og-render). With --screenshot it then captures each
// at 1200×630 into public/og/ using the agent-browser CLI; without it, open the HTML
// files in any browser at that size and screenshot them yourself.
//
// Re-run it with --screenshot and commit the PNGs whenever the card design or copy
// changes (lib/og-card.ts, STATUS_COPY in lib/site.ts). The next deploy ships them.
// The cards are generic on purpose (no due date, no check count) because one image
// is served for as long as a status lasts.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The Worker source uses extensionless imports ('./site'), which bundlers resolve
// but Node does not. Teach Node to try '.ts' for relative specifiers.
registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (err) {
			if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
			throw err;
		}
	},
});

type Status = 'no' | 'soon' | 'yes';
const STATUSES: Status[] = ['no', 'soon', 'yes'];

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const screenshot = args.includes('--screenshot');
const outDir = resolve(args.find((a) => !a.startsWith('--')) ?? join(repo, 'node_modules', '.cache', 'og-render'));
const pngDir = join(repo, 'public', 'og');

const { renderOgCardHtml } = (await import(pathToFileURL(join(repo, 'src', 'lib', 'og-card.ts')).href)) as typeof import('../src/lib/og-card.ts');

mkdirSync(outDir, { recursive: true });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const files: Array<{ status: Status; html: string }> = [];
for (const status of STATUSES) {
	// statusChangedAt '' = unknown, so the card stays timeless.
	const html = renderOgCardHtml({ state: { status, statusChangedAt: '', dueDate: null }, checks: 0, today });
	const file = join(outDir, `${status}.html`);
	writeFileSync(file, html);
	files.push({ status, html: file });
	console.log(`wrote ${file}`);
}

if (screenshot) {
	mkdirSync(pngDir, { recursive: true });
	const session = ['--session', 'og-render'];
	const run = (...cmd: string[]) => execFileSync('agent-browser', [...session, ...cmd], { stdio: ['ignore', 'pipe', 'inherit'] });
	try {
		run('--allow-file-access', 'open', 'about:blank');
		run('set', 'viewport', '1200', '630');
		for (const f of files) {
			run('open', pathToFileURL(f.html).href);
			run('wait', '400');
			const png = join(pngDir, `${f.status}.png`);
			run('screenshot', png);
			console.log(`wrote ${png}`);
		}
	} finally {
		try {
			run('close');
		} catch {
			// already closed
		}
	}
}
