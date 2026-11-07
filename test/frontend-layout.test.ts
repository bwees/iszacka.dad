import { Hono } from 'hono';
import { html } from 'hono/html';
import { describe, expect, it } from 'vitest';
import { FOOTER_SECTIONS, type PageOptions, buildId, ogImageUrl, renderPage, themeColour } from '../src/lib/layout';
import type { AppEnv, SiteState } from '../src/types';

const STATE: SiteState = { status: 'no', statusChangedAt: '2026-11-06T21:30:00.000Z', dueDate: '2026-11-20' };

async function render(path: string, opts: Omit<PageOptions, 'body'> & { body?: PageOptions['body'] }, env: Partial<Env> = {}, state: SiteState | null = STATE) {
	const app = new Hono<AppEnv>();
	app.use('*', async (c, next) => {
		if (state) c.set('state', state);
		await next();
	});
	app.get('*', (c) => renderPage(c, { body: html`<p>body</p>`, ...opts }));
	const res = await app.request(path, {}, { SITE_URL: 'https://iszacka.dad', ...env } as Env);
	return { res, text: await res.text() };
}

describe('renderPage', () => {
	it('renders the shell with head tags, skip link, live region, nav and footer', async () => {
		const { res, text } = await render('/pool', { title: 'Pool', description: 'Guess <when>' });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(text).toContain('<title>Pool · Is Zack a Dad?</title>');
		expect(text).toContain('content="Guess &lt;when&gt;"');
		expect(text).toContain('<link rel="canonical" href="https://iszacka.dad/pool">');
		const ogUrl = `https://iszacka.dad/og.png?v=no-${Date.parse(STATE.statusChangedAt)}`;
		expect(text).toContain(`<meta property="og:image" content="${ogUrl}">`);
		expect(text).toContain(`<meta name="twitter:image" content="${ogUrl}">`);
		expect(text).toContain('href="/favicon-no.svg"');
		expect(text).toContain('href="/manifest.webmanifest"');
		expect(text).toContain('<script type="module" src="/app.js"></script>');
		expect(text).toContain('class="skip-link" href="#main"');
		expect(text).toContain('aria-live="polite"');
		expect(text).toContain('<a href="/pool" aria-current="page">Pool</a>');
		expect(text).toContain('data-status="no"');
		expect(text).not.toContain('challenges.cloudflare.com');
		expect(text).not.toContain('name="robots"');
	});

	it('keeps the homepage title as given', async () => {
		const { text } = await render('/', { title: 'Is Zack a Dad? No.' });
		expect(text).toContain('<title>Is Zack a Dad? No.</title>');
		expect(text).toContain('data-page="home"');
	});

	it('links every public page from the footer', async () => {
		const { text } = await render('/', { title: 'x' });
		const required = [
			'/ready', '/wall', '/names', '/ledger', '/api', '/feed.xml', '/atom.xml', '/feed.json', '/calendar.ics',
			'/certificate', '/poster', '/stats', '/llms.txt', '/humans.txt', '/.well-known/security.txt', '/updates',
			'/pool', '/status', '/everything',
		];
		for (const href of required) expect(text, href).toContain(`href="${href}"`);
		const footerHrefs = FOOTER_SECTIONS.flatMap((s) => s.links.map((l) => l.href));
		for (const href of required.filter((h) => h !== '/everything')) expect(footerHrefs).toContain(href);
	});

	it('shows the build id when version metadata exists, and copes without it', async () => {
		expect((await render('/', { title: 'x' }, { CF_VERSION: { id: 'abcdef1234567890', tag: '', timestamp: '' } })).text).toContain('>abcdef12</code>');
		expect((await render('/', { title: 'x' }, { CF_VERSION: { id: 'abcdef12', tag: 'v1.2.3', timestamp: '2026-11-06' } })).text).toContain('>v1.2.3</code>');
		expect((await render('/', { title: 'x' })).text).toContain('>local</code>');
	});

	it('supports bare, noindex, status, scripts, turnstile and body class', async () => {
		const { res, text } = await render('/embed', {
			title: 'Embed',
			bare: true,
			noindex: true,
			status: 404,
			scripts: ['/push.js', 'https://evil.example/x.js', '//evil.example/y.js'],
			turnstile: true,
			bodyClass: 'printable',
		});
		expect(res.status).toBe(404);
		expect(text).not.toContain('class="site-header"');
		expect(text).not.toContain('class="site-footer"');
		expect(text).toContain('<meta name="robots" content="noindex, nofollow">');
		expect(text).toContain('<script type="module" src="/push.js"></script>');
		expect(text).not.toContain('evil.example');
		expect(text).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
		expect(text).toMatch(/<body class="printable is-bare"/);
	});

	it('renders even when the request state was never loaded (error pages)', async () => {
		const { res, text } = await render('/boom', { title: 'Error', status: 500 }, {}, null);
		expect(res.status).toBe(500);
		expect(text).toContain('data-status="no"');
	});

	it('embeds the per-status copy for app.js as safe JSON', async () => {
		const { text } = await render('/', { title: 'x' });
		const json = text.match(/<script type="application\/json" id="site-copy">(.*?)<\/script>/s)?.[1];
		expect(json).toBeTruthy();
		const data = JSON.parse(json as string);
		expect(data.copy.yes.word).toBe('YES');
		expect(data.copy.soon.header).toBe('not yet (it is happening)');
	});
});

describe('buildId', () => {
	it('returns null when the binding is missing or malformed', () => {
		expect(buildId(undefined)).toBeNull();
		expect(buildId({})).toBeNull();
		expect(buildId({ CF_VERSION: 'nope' as unknown as WorkerVersionMetadata })).toBeNull();
	});
});

describe('ogImageUrl', () => {
	it('versions the image by status and change time so social caches pick up the flip', () => {
		const no = ogImageUrl('https://iszacka.dad', STATE);
		expect(no).toMatch(/^https:\/\/iszacka\.dad\/og\.png\?v=no-\d+$/);
		const yes = ogImageUrl('https://iszacka.dad', { status: 'yes', statusChangedAt: '2026-11-20T03:14:00.000Z' });
		expect(yes).toBe(`https://iszacka.dad/og.png?v=yes-${Date.parse('2026-11-20T03:14:00.000Z')}`);
		expect(yes).not.toBe(no);
		// Same status, new change time (e.g. no → soon → no) still busts the cache.
		expect(ogImageUrl('https://iszacka.dad', { ...STATE, statusChangedAt: '2026-11-07T00:00:00.000Z' })).not.toBe(no);
	});

	it('copes with an unparseable change time', () => {
		expect(ogImageUrl('https://iszacka.dad', { status: 'soon', statusChangedAt: 'nope' })).toBe('https://iszacka.dad/og.png?v=soon-0');
	});

	it('changes the rendered og:image when the status flips', async () => {
		const { text } = await render('/', { title: 'x' }, {}, { status: 'yes', statusChangedAt: '2026-11-20T03:14:00.000Z', dueDate: null });
		const expected = `https://iszacka.dad/og.png?v=yes-${Date.parse('2026-11-20T03:14:00.000Z')}`;
		expect(text).toContain(`<meta property="og:image" content="${expected}">`);
		expect(text).toContain(`<meta name="twitter:image" content="${expected}">`);
	});
});

describe('themeColour', () => {
	it('matches the hero colours in styles.css', () => {
		expect(themeColour('soon', 'light')).toBe('#ffb000');
		expect(themeColour('yes', 'dark')).toBe('#0e6b3a');
		expect(themeColour('no', 'light')).toBe('#f1ece1');
	});
});
