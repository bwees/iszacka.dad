import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildWebhookRequest,
	checkPublicHttpsUrl,
	deliverWebhook,
	deliverWebhookBatch,
	detectWebhookKind,
	discordPayload,
	genericPayload,
	listWebhookTargets,
	maskWebhookUrl,
	MAX_WEBHOOK_FAILURES,
	ownHosts,
	parseFrequency,
	parseKindChoice,
	readBodySnippet,
	sendWebhook,
	signWebhookBody,
	slackEscape,
	slackPayload,
	STATUS_COLOUR,
	systemUpdate,
	validateWebhookUrl,
} from '../src/notify/webhooks';
import type { WebhookRow } from '../src/types';
import { fakeEnv, scriptedFetch, STATE_NO, STATE_YES, UPDATE_YES } from './push-helpers';

const BASE = 'https://iszacka.dad';
const HOOK: WebhookRow = {
	id: 3,
	url: 'https://example.com/hooks/stork',
	kind: 'generic',
	frequency: 'big',
	token: 'tok_abcdefghijklmnopqrstuvwxyz012345',
	failures: 2,
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('detectWebhookKind', () => {
	it.each([
		['https://discord.com/api/webhooks/123/abc', 'discord'],
		['https://discordapp.com/api/webhooks/123/abc', 'discord'],
		['https://canary.discord.com/api/webhooks/123/abc', 'discord'],
		['https://ptb.discord.com/api/v10/webhooks/123/abc', 'discord'],
		['https://hooks.slack.com/services/T000/B000/XXXX', 'slack'],
		['https://discord.com/channels/123', 'generic'],
		['https://notdiscord.com/api/webhooks/1/2', 'generic'],
		['https://example.com/hook', 'generic'],
		['not a url', 'generic'],
	] as const)('%s → %s', (url, kind) => {
		expect(detectWebhookKind(url)).toBe(kind);
	});
});

describe('webhook URL rules', () => {
	it('accepts public https URLs', () => {
		const check = validateWebhookUrl('  https://discord.com/api/webhooks/1/abc  ');
		expect(check.ok).toBe(true);
		if (check.ok) expect(check.url.href).toBe('https://discord.com/api/webhooks/1/abc');
		expect(validateWebhookUrl('https://hooks.example.co.uk:8443/x?y=1').ok).toBe(true);
	});

	it.each([
		['', 'Please paste a URL'],
		['http://example.com/hook', 'HTTPS only'],
		['ftp://example.com/hook', 'HTTPS only'],
		['example.com/hook', "doesn't look like a URL"],
		['https://127.0.0.1/hook', 'IP addresses'],
		['https://2130706433/hook', 'IP addresses'],
		['https://0x7f.1/hook', 'IP addresses'],
		['https://[::1]/hook', 'IP addresses'],
		['https://[2606:4700::1111]/hook', 'IP addresses'],
		['https://localhost/hook', 'Local and internal'],
		['https://LOCALHOST./hook', 'Local and internal'],
		['https://api.localhost/hook', 'Local and internal'],
		['https://printer.local/hook', 'Local and internal'],
		['https://grafana.corp.internal/hook', 'Local and internal'],
		['https://router.home.arpa/hook', 'Local and internal'],
		['https://intranet/hook', 'real, public domain'],
		['https://user:pass@example.com/hook', 'usernames or passwords'],
		['https://iszacka.dad/webhooks', 'points back at this site'],
		['https://www.iszacka.dad/x', 'points back at this site'],
	])('rejects %s', (url, message) => {
		const check = validateWebhookUrl(url);
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.error).toContain(message);
	});

	it('rejects non-strings and URLs over 2048 characters', () => {
		expect(validateWebhookUrl(undefined).ok).toBe(false);
		expect(validateWebhookUrl(42).ok).toBe(false);
		const long = `https://example.com/${'a'.repeat(2048 - 20)}`;
		expect(long.length).toBe(2048);
		expect(validateWebhookUrl(long).ok).toBe(true);
		const check = validateWebhookUrl(`${long}b`);
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.error).toContain('2048');
	});

	it('knows its own hosts', () => {
		const hosts = ownHosts({ SITE_URL: 'https://preview.example.workers.dev' }, 'https://iszacka-dad-pr7.example.workers.dev/webhooks');
		expect(hosts).toEqual(expect.arrayContaining(['iszacka.dad', 'preview.example.workers.dev', 'iszacka-dad-pr7.example.workers.dev']));
		expect(ownHosts({ SITE_URL: '' }, 'http://localhost:8787/webhooks')).toEqual(['iszacka.dad']);
		expect(checkPublicHttpsUrl('https://x.preview.example.workers.dev/', { maxLength: 100, ownHosts: hosts }).ok).toBe(false);
	});

	it('parses form choices', () => {
		expect(parseKindChoice(undefined)).toBe('auto');
		expect(parseKindChoice('auto')).toBe('auto');
		expect(parseKindChoice('slack')).toBe('slack');
		expect(parseKindChoice('teams')).toBeNull();
		expect(parseFrequency('')).toBe('big');
		expect(parseFrequency('daily')).toBe('daily');
		expect(parseFrequency('hourly')).toBeNull();
	});

	it('masks the secret part of a URL', () => {
		const masked = maskWebhookUrl('https://discord.com/api/webhooks/123456/SuperSecretTokenValue');
		expect(masked.startsWith('https://discord.com/api/webhooks/123456/Supe')).toBe(true);
		expect(masked).not.toContain('SecretTokenValue');
		expect(maskWebhookUrl('https://example.com/hook?token=secret')).not.toContain('secret');
	});
});

describe('payloads', () => {
	it('builds a Discord message with an embed', () => {
		const payload = discordPayload(UPDATE_YES, BASE);
		expect(payload.username).toBe('iszacka.dad');
		expect(payload.content).toBe('👶 Zack is a dad!');
		expect(payload.allowed_mentions).toEqual({ parse: [] });
		expect(payload.embeds).toHaveLength(1);
		expect(payload.embeds[0]).toEqual({
			title: 'Zack is a dad!',
			description: 'Zack is a dad! The baby is here.',
			url: 'https://iszacka.dad/updates/7',
			color: STATUS_COLOUR.yes,
			timestamp: '2026-11-19T03:14:15.926Z',
			footer: { text: 'Is Zack a dad? YES · iszacka.dad' },
		});
	});

	it('truncates to Discord limits and labels tests', () => {
		const long = { ...UPDATE_YES, title: 'x'.repeat(400), body: 'y'.repeat(5000) };
		const payload = discordPayload(long, BASE, 'test');
		const embed = payload.embeds[0];
		expect(embed?.title.length).toBeLessThanOrEqual(256);
		expect(embed?.title.startsWith('[Test] ')).toBe(true);
		expect(embed?.description.length).toBeLessThanOrEqual(4096);
		expect(embed?.description.endsWith('…')).toBe(true);
	});

	it('builds a Slack message with escaped mrkdwn', () => {
		const update = { ...UPDATE_YES, body: 'Tea & <biscuits> for everyone' };
		const payload = slackPayload(update, BASE);
		expect(payload.text).toBe('👶 Zack is a dad!');
		expect(payload.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: '👶 Zack is a dad!', emoji: true } });
		expect(payload.blocks[1]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: 'Tea &amp; &lt;biscuits&gt; for everyone' } });
		expect(JSON.stringify(payload.blocks[2])).toContain('<https://iszacka.dad/updates/7|iszacka.dad>');
		expect(slackEscape('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
	});

	it('builds the generic JSON envelope', () => {
		const payload = genericPayload(UPDATE_YES, STATE_YES, BASE, 'update', '2026-11-19T03:15:00.000Z');
		expect(payload).toEqual({
			event: 'update',
			update: UPDATE_YES,
			state: STATE_YES,
			url: 'https://iszacka.dad/updates/7',
			sentAt: '2026-11-19T03:15:00.000Z',
		});
	});

	it('links one-off messages to the homepage', () => {
		const hello = systemUpdate(STATE_NO, 'Hello', 'Hi', '2026-11-06T21:00:00.000Z');
		expect(hello).toMatchObject({ id: 0, kind: 'system', status: 'no', audience: 'none' });
		expect(genericPayload(hello, STATE_NO, BASE, 'hello').url).toBe('https://iszacka.dad/');
	});
});

describe('signatures', () => {
	it('is sha256=<hex HMAC of the raw body keyed with the token>', async () => {
		expect(await signWebhookBody('key', 'The quick brown fox jumps over the lazy dog')).toBe(
			'sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
		);
		const body = JSON.stringify({ hello: 'wörld 👶' });
		expect(await signWebhookBody(HOOK.token, body)).toBe(`sha256=${createHmac('sha256', HOOK.token).update(body).digest('hex')}`);
	});

	it('signs generic requests (and only generic ones)', async () => {
		const generic = await buildWebhookRequest(HOOK, UPDATE_YES, STATE_YES, BASE, 'update', '2026-11-19T03:15:00.000Z');
		expect(generic.headers['Content-Type']).toBe('application/json');
		expect(generic.headers['X-Iszackadad-Event']).toBe('update');
		expect(generic.headers['X-Iszackadad-Signature']).toBe(
			`sha256=${createHmac('sha256', HOOK.token).update(generic.body).digest('hex')}`,
		);
		expect(JSON.parse(generic.body).event).toBe('update');

		const discord = await buildWebhookRequest({ ...HOOK, kind: 'discord' }, UPDATE_YES, STATE_YES, BASE);
		expect(discord.headers['X-Iszackadad-Signature']).toBeUndefined();
		expect(JSON.parse(discord.body).username).toBe('iszacka.dad');
	});
});

describe('listWebhookTargets', () => {
	it("returns no-one for audience 'none' without asking the database", async () => {
		const { env, queries } = fakeEnv();
		expect(await listWebhookTargets(env, 'none', 0, 25)).toEqual([]);
		expect(queries).toHaveLength(0);
	});

	it("filters to daily hooks for audience 'daily', and pages by id", async () => {
		const { env, queries } = fakeEnv({}, () => [HOOK]);
		expect(await listWebhookTargets(env, 'daily', 10, 25)).toEqual([HOOK]);
		expect(queries[0]?.sql).toContain("frequency = 'daily'");
		expect(queries[0]?.sql).toContain('disabled_at IS NULL');
		expect(queries[0]?.binds).toEqual([10, 25]);

		await listWebhookTargets(env, 'all', 0, 9999);
		expect(queries[1]?.sql).not.toContain("frequency = 'daily'");
		expect(queries[1]?.binds).toEqual([0, 500]);
	});
});

describe('deliverWebhook', () => {
	it('posts, and resets the failure count on success', async () => {
		const { env, queries } = fakeEnv();
		const fetch = scriptedFetch([new Response(null, { status: 204 })]);
		vi.stubGlobal('fetch', fetch.fn);
		const result = await deliverWebhook(env, HOOK, UPDATE_YES, STATE_YES);
		expect(result).toEqual({ ok: true, detail: 'HTTP 204' });
		expect(fetch.calls[0]?.url).toBe(HOOK.url);
		expect(fetch.calls[0]?.init.method).toBe('POST');
		expect(fetch.calls[0]?.init.redirect).toBe('manual');
		expect(fetch.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
		const headers = fetch.calls[0]?.init.headers as Record<string, string>;
		const body = fetch.calls[0]?.init.body as string;
		expect(headers['X-Iszackadad-Signature']).toBe(`sha256=${createHmac('sha256', HOOK.token).update(body).digest('hex')}`);
		expect(queries[0]?.sql).toContain('failures = 0');
		expect(queries[0]?.binds).toEqual([204, expect.any(String), HOOK.id]);
	});

	it('disables the hook on 404 and 410', async () => {
		for (const status of [404, 410]) {
			const { env, queries } = fakeEnv();
			vi.stubGlobal('fetch', scriptedFetch([new Response('Unknown Webhook', { status })]).fn);
			const result = await deliverWebhook(env, HOOK, UPDATE_YES, STATE_YES);
			expect(result.ok).toBe(false);
			expect(result.gone).toBe(true);
			expect(result.detail).toContain(`HTTP ${status}`);
			expect(queries[0]?.sql).toContain('disabled_at = COALESCE(disabled_at, ?)');
		}
	});

	it('counts failures and reports when the limit disables it', async () => {
		const { env, queries } = fakeEnv({}, (q) => (q.sql.includes('RETURNING failures') ? { failures: 3, disabled_at: null } : null));
		vi.stubGlobal('fetch', scriptedFetch([new Response('nope', { status: 500 })]).fn);
		const result = await deliverWebhook(env, HOOK, UPDATE_YES, STATE_YES);
		expect(result).toEqual({ ok: false, detail: `HTTP 500: nope (failure 3 of ${MAX_WEBHOOK_FAILURES})` });
		expect(queries[0]?.binds).toEqual([500, expect.any(String), MAX_WEBHOOK_FAILURES, expect.any(String), HOOK.id]);

		const last = fakeEnv({}, () => ({ failures: MAX_WEBHOOK_FAILURES, disabled_at: '2026-11-06T21:00:00.000Z' }));
		vi.stubGlobal('fetch', scriptedFetch([new Response(null, { status: 503 })]).fn);
		const disabled = await sendWebhook(last.env, HOOK, UPDATE_YES, STATE_YES);
		expect(disabled.disabled).toBe(true);
		expect(disabled.detail).toContain('disabled after 10 in a row');
	});

	it('treats redirects as failures and never throws on network errors', async () => {
		const { env } = fakeEnv({}, () => ({ failures: 1, disabled_at: null }));
		vi.stubGlobal('fetch', scriptedFetch([new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example' } })]).fn);
		const redirected = await deliverWebhook(env, HOOK, UPDATE_YES, STATE_YES);
		expect(redirected.ok).toBe(false);
		expect(redirected.detail).toContain("don't follow redirects");

		vi.stubGlobal('fetch', scriptedFetch([new TypeError('connection reset')]).fn);
		const failed = await sendWebhook(env, HOOK, UPDATE_YES, STATE_YES);
		expect(failed).toMatchObject({ ok: false, status: 0 });
		expect(failed.detail).toContain('connection reset');

		const timeout = new Error('timed out');
		timeout.name = 'TimeoutError';
		vi.stubGlobal('fetch', scriptedFetch([timeout]).fn);
		expect((await sendWebhook(env, HOOK, UPDATE_YES, STATE_YES)).detail).toContain('no response within 10s');
	});

	it('survives a database that is having a bad day', async () => {
		const broken = { DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 down'); } }) }) }, SITE_URL: BASE } as unknown as Env;
		vi.stubGlobal('fetch', scriptedFetch([new Response(null, { status: 200 })]).fn);
		const result = await deliverWebhook(broken, HOOK, UPDATE_YES, STATE_YES);
		expect(result.ok).toBe(true);
	});

	it('skips the bookkeeping for goodbyes', async () => {
		const { env, queries } = fakeEnv();
		vi.stubGlobal('fetch', scriptedFetch([new Response(null, { status: 204 })]).fn);
		const result = await sendWebhook(env, HOOK, systemUpdate(STATE_NO, 'Bye', 'Bye'), STATE_NO, { event: 'goodbye', account: false });
		expect(result.ok).toBe(true);
		expect(queries).toHaveLength(0);
	});
});

describe('deliverWebhookBatch', () => {
	const hooks: WebhookRow[] = [
		{ ...HOOK, id: 1, kind: 'discord', url: 'https://discord.com/api/webhooks/1/aaa' },
		{ ...HOOK, id: 2, kind: 'discord', url: 'https://discord.com/api/webhooks/2/bbb' },
		{ ...HOOK, id: 3, kind: 'generic', url: 'https://example.com/hooks/gone', token: 'tok_one_aaaaaaaaaaaaaaaaaaaa' },
		{ ...HOOK, id: 4, kind: 'generic', url: 'https://example.com/hooks/down', token: 'tok_two_bbbbbbbbbbbbbbbbbbbb' },
	];

	it('posts to every hook, then keeps all the books in one D1 round trip', async () => {
		const { env, queries, counts } = fakeEnv({ SITE_URL: BASE }, (q) =>
			q.sql.includes('RETURNING failures') ? { failures: 4, disabled_at: null } : null,
		);
		const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
			const href = String(url);
			if (href.endsWith('/gone')) return new Response('Unknown Webhook', { status: 404 });
			if (href.endsWith('/down')) return new Response('oops', { status: 500 });
			return new Response(null, { status: 204 });
		});
		vi.stubGlobal('fetch', fetch);
		const results = await deliverWebhookBatch(env, hooks, UPDATE_YES, STATE_YES);

		expect(results).toEqual([
			{ ok: true, detail: 'HTTP 204' },
			{ ok: true, detail: 'HTTP 204' },
			{ ok: false, gone: true, detail: "HTTP 404: Unknown Webhook: the webhook is gone, so it's been disabled" },
			{ ok: false, detail: `HTTP 500: oops (failure 4 of ${MAX_WEBHOOK_FAILURES})` },
		]);
		expect(counts.batches).toBe(1);
		expect(queries.map((q) => q.binds.at(-1))).toEqual([1, 2, 3, 4]);
		expect(queries.every((q) => q.method === 'batch')).toBe(true);
		// Discord bodies are identical; each generic one is signed with its own token.
		const bodies = fetch.mock.calls.map((c) => c[1]?.body as string);
		expect(bodies[0]).toBe(bodies[1]);
		const signatures = fetch.mock.calls.slice(2).map((c) => (c[1]?.headers as Record<string, string>)['X-Iszackadad-Signature']);
		expect(signatures[0]).toBe(`sha256=${createHmac('sha256', 'tok_one_aaaaaaaaaaaaaaaaaaaa').update(bodies[2] ?? '').digest('hex')}`);
		expect(signatures[1]).toBe(`sha256=${createHmac('sha256', 'tok_two_bbbbbbbbbbbbbbbbbbbb').update(bodies[3] ?? '').digest('hex')}`);
	});

	it('reports every result even when the bookkeeping write fails', async () => {
		const { env } = fakeEnv({ SITE_URL: BASE });
		(env.DB as unknown as { batch: () => Promise<never> }).batch = async () => {
			throw new Error('D1 down');
		};
		vi.stubGlobal('fetch', scriptedFetch([new Response('nope', { status: 500 })]).fn);
		expect(await deliverWebhookBatch(env, [HOOK], UPDATE_YES, STATE_YES)).toEqual([{ ok: false, detail: 'HTTP 500: nope' }]);
	});
});

describe('readBodySnippet', () => {
	it('reads only the start of an enormous error body', async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				if (pulled > 10_000) return controller.close();
				controller.enqueue(new TextEncoder().encode('<p>error</p>\n'.repeat(100)));
			},
		});
		const snippet = await readBodySnippet(new Response(stream, { status: 500 }));
		expect(snippet.startsWith('<p>error</p> <p>error</p>')).toBe(true);
		expect(snippet.length).toBeLessThanOrEqual(2048);
		expect(pulled).toBeLessThan(10);
	});

	it('copes with empty and short bodies', async () => {
		expect(await readBodySnippet(new Response(null, { status: 500 }))).toBe('');
		expect(await readBodySnippet(new Response('  Unknown   Webhook \n'))).toBe('Unknown Webhook');
	});
});
