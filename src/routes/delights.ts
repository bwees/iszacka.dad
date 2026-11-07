// Feature routes (delights). Mounted in src/index.ts.
//
// /achievements is an empty shell: the trophies live in each browser's localStorage, which the
// server never sees, so /delights.js fills the page in. No reads, no state, no Intl: the whole
// request is one cached render of a static fragment.

import { Hono } from 'hono';
import { html } from 'hono/html';
import { LinearRouter } from 'hono/router/linear-router';
import { type Html, fragmentCache, renderPage } from '../lib/layout';
import type { AppEnv } from '../types';

export const delightsRoutes = new Hono<AppEnv>({ router: new LinearRouter() });

export const ACHIEVEMENTS_PATH = '/achievements';

const shellCache = fragmentCache(1);

/** The page body: a heading and a container `[data-achievements]` for delights.js to fill. */
export function achievementsShell(): Html {
	return shellCache('shell', () => html`<div class="wrap section stack-lg">
	<header class="page-head">
		<p class="kicker">Trophy cabinet</p>
		<h1 class="h1-fit">Achievements</h1>
		<p class="lede">Rewards for checking a website about one word far more often than is healthy. Kept in this browser only: the site never sees them, and neither does anyone else.</p>
	</header>
	<div class="stack-lg" data-achievements>
		<p class="empty">Polishing the trophies…</p>
	</div>
	<noscript><div class="notice">Achievements are tracked by JavaScript in your browser, which is switched off. Visiting without JavaScript is an achievement in itself, but not one we can record.</div></noscript>
</div>`);
}

delightsRoutes.get(ACHIEVEMENTS_PATH, (c) =>
	renderPage(c, {
		title: 'Achievements',
		description: 'Achievements for the dedicated refresher: Night Owl, Concerned Relative, Vibe Merchant and more. Kept in your browser only.',
		path: ACHIEVEMENTS_PATH,
		body: achievementsShell(),
	}),
);
