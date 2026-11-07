import { describe, expect, it, vi } from 'vitest';
import {
	ANONYMOUS_GUESS_NOTE,
	ResendApiError,
	classifyEmailError,
	cleanHeaderValue,
	deliverEmail,
	deliverEmailBatch,
	renderAlreadySubscribedEmail,
	renderAutoReply,
	renderConfirmationEmail,
	renderGuessConfirmation,
	renderGuessError,
	renderUpdateEmail,
	replySubject,
	sendConfirmation,
	sendEmail,
	sendEmailBatch,
	subscriberHeaders,
	updateEmailRenderer,
} from '../src/notify/email';
import type { Frequency, Status, SubscriberRow, Update, UpdateKind } from '../src/types';
import { sqliteD1 } from './email-announce-d1';

const BASE = 'https://iszacka.dad';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz012345';
const UNSUBSCRIBE = `${BASE}/unsubscribe/${TOKEN}`;
const GENDERED = /\b(he|she|him|her|hers|his|himself|herself)\b/i;

function update(kind: UpdateKind, status: Status, extra: Partial<Update> = {}): Update {
	return {
		id: 42,
		kind,
		title: kind === 'daily' ? 'Day 47: still no.' : 'Zack is a dad!',
		body: 'Zack is a dad! The baby is here.',
		status,
		audience: kind === 'daily' ? 'daily' : 'all',
		createdAt: '2026-11-06T09:00:00.000Z',
		notifiedAt: null,
		...extra,
	};
}

const VARIANTS: Array<[UpdateKind, Status]> = [
	['status', 'yes'],
	['status', 'soon'],
	['status', 'no'],
	['daily', 'no'],
	['daily', 'yes'],
	['system', 'no'],
];

describe('update emails', () => {
	it.each(VARIANTS)('%s/%s carries a visible unsubscribe link in HTML and text', async (kind, status) => {
		for (const frequency of ['big', 'daily'] as Frequency[]) {
			const email = await renderUpdateEmail({ base: BASE, update: update(kind, status), token: TOKEN, frequency });
			expect(email.html).toContain(`href="${UNSUBSCRIBE}#unsubscribe"`);
			expect(email.html).toMatch(/>Unsubscribe</);
			expect(email.text).toContain(`Unsubscribe: ${UNSUBSCRIBE}`);
			expect(email.subject.length).toBeGreaterThan(0);
			expect(email.html.startsWith('<!doctype html>')).toBe(true);
		}
	});

	it.each(VARIANTS)('%s/%s escapes user-controlled text in HTML', async (kind, status) => {
		const evil = '<script>alert("x")</script> & <img src=x onerror=alert(1)>';
		const email = await renderUpdateEmail({
			base: BASE,
			update: update(kind, status, { title: `Title ${evil}`, body: `Note: ${evil}` }),
			token: TOKEN,
			frequency: 'daily',
		});
		expect(email.html).not.toContain('<script>');
		expect(email.html).not.toContain('<img src=x');
		expect(email.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(1)&gt;');
		// Plain text is plain text: no escaping, no markup.
		expect(email.text).not.toContain('&lt;');
	});

	it('goes gloriously over the top for YES, and stays dry for NO', async () => {
		const yes = await renderUpdateEmail({ base: BASE, update: update('status', 'yes'), token: TOKEN, frequency: 'big' });
		expect(yes.subject).toMatch(/^YES\./);
		expect(yes.html).toContain('🎉');
		expect(yes.html).toContain('>YES<');
		expect(yes.text).toContain('ZACK IS A DAD.');
		expect(yes.text.split('\n')[0]).toBe(' __   __  _____   ____    _'); // banner indentation survives
		expect(yes.html).toContain(`${BASE}/wall`);

		const no = await renderUpdateEmail({ base: BASE, update: update('status', 'no', { body: 'Zack is not a dad. Yet.' }), token: TOKEN, frequency: 'big' });
		expect(no.subject).toBe('Update: Zack is not a dad.');
		expect(no.html).not.toContain('🎉');
	});

	it('shows an admin note only when it adds something', async () => {
		const plain = await renderUpdateEmail({ base: BASE, update: update('status', 'yes'), token: TOKEN, frequency: 'big' });
		expect(plain.html).not.toContain('control room');
		const noted = await renderUpdateEmail({
			base: BASE,
			update: update('status', 'yes', { body: 'Everyone is well & <happy>.' }),
			token: TOKEN,
			frequency: 'big',
		});
		expect(noted.html).toContain('control room');
		expect(noted.html).toContain('Everyone is well &amp; &lt;happy&gt;.');
		expect(noted.text).toContain('Everyone is well & <happy>.');
	});

	it('uses the daily title as the subject and offers the other frequency', async () => {
		const email = await renderUpdateEmail({ base: BASE, update: update('daily', 'no'), token: TOKEN, frequency: 'daily' });
		expect(email.subject).toBe('Day 47: still no.');
		expect(email.text).toContain('Switch to "Only when it happens"');
		expect(email.html).toContain(`${UNSUBSCRIBE}#frequency`);
	});

	it('never uses gendered pronouns', async () => {
		for (const [kind, status] of VARIANTS) {
			const email = await renderUpdateEmail({ base: BASE, update: update(kind, status, { body: '' }), token: TOKEN, frequency: 'daily' });
			expect(email.text).not.toMatch(GENDERED);
		}
	});
});

describe('subscriber headers', () => {
	it('sets RFC 8058 one-click unsubscribe headers', () => {
		const headers = subscriberHeaders(BASE, TOKEN, 'no', 7);
		expect(headers['List-Unsubscribe']).toBe(`<${UNSUBSCRIBE}>`);
		expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
		expect(headers['Auto-Submitted']).toBe('auto-generated');
		expect(headers['X-Update-Id']).toBe('7');
		expect(headers['List-Id']).toContain('<updates.iszacka.dad>');
	});

	it('omits List-Unsubscribe for non-HTTPS bases (Email Service would reject the send)', () => {
		const headers = subscriberHeaders('http://localhost:8787', TOKEN, 'no');
		expect(headers['List-Unsubscribe']).toBeUndefined();
		expect(headers['List-Unsubscribe-Post']).toBeUndefined();
	});
});

describe('subscription emails', () => {
	it('confirmation links to /confirm/<token>', async () => {
		const email = await renderConfirmationEmail({ base: BASE, token: TOKEN, frequency: 'daily', status: 'no' });
		expect(email.html).toContain(`href="${BASE}/confirm/${TOKEN}"`);
		expect(email.text).toContain(`${BASE}/confirm/${TOKEN}`);
		expect(email.text).toContain('daily');
	});

	it('already-subscribed email links to the manage page', async () => {
		const email = await renderAlreadySubscribedEmail({ base: BASE, token: TOKEN, frequency: 'big', status: 'no' });
		expect(email.html).toContain(`href="${UNSUBSCRIBE}"`);
	});
});

describe('auto-replies', () => {
	const state = { status: 'no' as const, statusChangedAt: '2026-10-01T10:00:00.000Z', dueDate: '2026-11-20' };

	it('threads with "Re:" and strips header-breaking characters', async () => {
		const email = await renderAutoReply({
			base: BASE,
			state,
			stats: { checks: 1234, viewers: 3, subscribers: 10, guesses: 4 },
			today: '2026-11-06',
			originalSubject: 'Hello\r\nBcc: victim@example.com',
		});
		expect(email.subject).toBe('Re: Hello Bcc: victim@example.com');
		expect(email.subject).not.toMatch(/[\r\n]/);
		expect(email.text).toContain('1,234');
		expect(email.text).toContain('14 days to go');
		expect(email.html).toContain('>NO<');
	});

	it('escapes the subject inside the HTML title', async () => {
		const email = await renderAutoReply({
			base: BASE,
			state,
			stats: { checks: null, viewers: null, subscribers: null, guesses: null },
			today: '2026-11-06',
			originalSubject: '<b>bold</b>',
		});
		expect(email.html).toContain('<title>Re: &lt;b&gt;bold&lt;/b&gt;</title>');
	});

	it('escapes names in guess confirmations and errors', async () => {
		const ok = await renderGuessConfirmation({ base: BASE, name: '<img src=x onerror=alert(1)>', guessAt: '2026-11-14T15:30:00.000Z', id: 9 });
		expect(ok.html).not.toContain('<img src=x');
		expect(ok.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(ok.text).toContain('#9');

		expect(ok.text).not.toContain(ANONYMOUS_GUESS_NOTE);

		const anonymous = await renderGuessConfirmation({ base: BASE, name: 'Anonymous emailer', anonymous: true, guessAt: '2026-11-14T15:30:00.000Z', id: 10 });
		expect(anonymous.text).toContain(ANONYMOUS_GUESS_NOTE);
		expect(anonymous.html).toContain('Anonymous emailer');

		const bad = await renderGuessError({ base: BASE, error: 'No <date> found' });
		expect(bad.html).toContain('No &lt;date&gt; found');
		expect(bad.text).toContain('14 Nov 15:30');
	});

	it('does not stack Re: prefixes', () => {
		expect(replySubject('Re: guess', 'x')).toBe('Re: guess');
		expect(replySubject('guess', 'x')).toBe('Re: guess');
		expect(replySubject('   ', 'fallback')).toBe('fallback');
		expect(replySubject(null, 'fallback')).toBe('fallback');
	});
});

describe('error classification', () => {
	it.each([
		[new ResendApiError(429, 'rate_limit_exceeded', 'Too many requests'), 'rate_limit_exceeded', 'transient', true],
		[new ResendApiError(429, 'daily_quota_exceeded', 'You have exceeded your daily email sending quota.'), 'daily_quota_exceeded', 'transient', true],
		[new ResendApiError(500, 'application_error', 'An unexpected error occurred.'), 'application_error', 'transient', true],
		[new ResendApiError(503, 'service_unavailable', 'API is temporarily unavailable'), 'service_unavailable', 'transient', true],
		[new ResendApiError(409, 'concurrent_idempotent_requests', 'in progress'), 'concurrent_idempotent_requests', 'transient', true],
		[new ResendApiError(422, 'validation_error', 'Invalid `to` field.'), 'validation_error', 'permanent', false],
		[new ResendApiError(403, 'validation_error', 'The iszacka.dad domain is not verified.'), 'validation_error', 'permanent', false],
		[new ResendApiError(401, 'missing_api_key', 'Missing API key'), 'missing_api_key', 'permanent', false],
	])('%s → %s / %s (retry now: %s)', (err, code, kind, retryNow) => {
		expect(classifyEmailError(err)).toMatchObject({ code, kind, retryNow });
	});

	it('treats suppressed recipients as gone', () => {
		expect(classifyEmailError(new ResendApiError(422, 'recipient_suppressed', 'suppressed')).kind).toBe('suppressed');
	});

	it('treats network failures and unknown errors as transient', () => {
		expect(classifyEmailError(new TypeError('network went away'))).toMatchObject({ code: 'unknown_error', kind: 'transient' });
	});

	it('cleans header values', () => {
		expect(cleanHeaderValue('a\r\nb\tc  d')).toBe('a b c d');
		expect(cleanHeaderValue('x'.repeat(50), 10)).toHaveLength(10);
	});
});

describe('sendEmail (Resend)', () => {
	/** A D1 stand-in whose email_sends count is `sentToday`. */
	function fakeDb(sentToday = 0) {
		const runs: string[] = [];
		return {
			runs,
			prepare(sql: string) {
				return {
					bind() {
						return {
							async first() {
								return { n: sentToday };
							},
							async run() {
								runs.push(sql);
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		};
	}
	function fakeEnv(sentToday = 0) {
		const db = fakeDb(sentToday);
		const env = {
			RESEND_API_KEY: 're_test_key',
			RESEND_API_BASE: 'https://resend.test/',
			EMAIL_FROM: 'stork@iszacka.dad',
			EMAIL_FROM_NAME: 'The Stork',
			EMAIL_DAILY_LIMIT: '90',
			DB: db,
		} as unknown as Parameters<typeof sendEmail>[0];
		return { env, db };
	}
	/** A fetch that answers with `responses` in order (the last one repeats). */
	function fakeFetch(...responses: Array<() => Response>) {
		let i = 0;
		return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => (responses[Math.min(i++, responses.length - 1)] as () => Response)());
	}
	const error = (status: number, name: string, message = name) => () => Response.json({ statusCode: status, name, message }, { status });
	const okResponse = (id: string) => () => Response.json({ id });
	const msg = { to: 'someone@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };
	const sleep = vi.fn(async () => {});

	it('posts to /emails with the key, a User-Agent, an idempotency key, the sender and cleaned headers', async () => {
		const { env, db } = fakeEnv();
		const fetch = fakeFetch(okResponse('m1'));
		const res = await sendEmail(env, { ...msg, idempotencyKey: 'k1', headers: { 'X-Ok': 'yes\r\nInjected: 1', 'X-Empty': '  ' } }, { sleep, fetch });
		expect(res).toMatchObject({ ok: true, messageId: 'm1' });

		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe('https://resend.test/emails');
		const headers = new Headers(init?.headers);
		expect(headers.get('authorization')).toBe('Bearer re_test_key');
		expect(headers.get('user-agent')).toMatch(/iszacka\.dad/);
		expect(headers.get('idempotency-key')).toMatch(/^[0-9a-f]{64}$/);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(body).toMatchObject({ from: '"The Stork" <stork@iszacka.dad>', to: 'someone@example.com', subject: 'Hi', text: 'Hi' });
		expect(body.headers).toEqual({ 'X-Ok': 'yes Injected: 1' });
		// The send counts against today's quota.
		expect(db.runs.some((sql) => sql.includes('email_sends'))).toBe(true);
	});

	it('retries a rate limit once, then succeeds', async () => {
		const { env } = fakeEnv();
		const fetch = fakeFetch(error(429, 'rate_limit_exceeded'), okResponse('m2'));
		expect((await sendEmail(env, msg, { sleep, fetch })).ok).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('reports a persistent outage as transient, without throwing', async () => {
		const { env } = fakeEnv();
		const fetch = fakeFetch(error(500, 'application_error'));
		expect(await sendEmail(env, msg, { sleep, fetch })).toMatchObject({ ok: false, transient: true, code: 'application_error' });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('treats a network failure as transient', async () => {
		const { env } = fakeEnv();
		const fetch = vi.fn(async () => {
			throw new TypeError('fetch failed');
		});
		expect(await sendEmail(env, msg, { sleep, fetch })).toMatchObject({ ok: false, transient: true });
	});

	it('does not retry validation errors', async () => {
		const { env, db } = fakeEnv();
		const fetch = fakeFetch(error(422, 'validation_error', 'Invalid `to` field.'));
		const res = await sendEmail(env, msg, { sleep, fetch });
		expect(res).toMatchObject({ ok: false, transient: false, code: 'validation_error' });
		expect(res.gone).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(db.runs).toEqual([]);
	});

	it('fails cleanly, without calling Resend, when RESEND_API_KEY is missing', async () => {
		const { env } = fakeEnv();
		const fetch = fakeFetch(okResponse('never'));
		const res = await sendEmail({ ...env, RESEND_API_KEY: undefined }, msg, { sleep, fetch });
		expect(res).toMatchObject({ ok: false, transient: false, code: 'no_api_key' });
		expect(res.detail).toMatch(/RESEND_API_KEY/);
		expect(fetch).not.toHaveBeenCalled();
	});

	const keyOf = async (m: Parameters<typeof sendEmail>[1], sentToday = 0) => {
		const { env } = fakeEnv(sentToday);
		const fetch = fakeFetch(okResponse('m'));
		await sendEmail(env, m, { sleep, fetch });
		return new Headers(fetch.mock.calls[0]?.[1]?.headers).get('idempotency-key');
	};

	it('keys idempotency per logical send, not per recipient and subject', async () => {
		const a = await keyOf({ ...msg, idempotencyKey: 'reply:<one@example.com>' });
		const b = await keyOf({ ...msg, idempotencyKey: 'reply:<two@example.com>' });
		expect(a).not.toBe(b);
		expect(await keyOf({ ...msg, idempotencyKey: 'reply:<one@example.com>' })).toBe(a);
		// No key: a fresh random one every time, so a second admin test email isn't swallowed.
		expect(await keyOf(msg)).not.toBe(await keyOf(msg));
	});

	it('gives each claimed sign-up email its own key, and each update + subscriber a stable one', async () => {
		const { env } = fakeEnv();
		const full = { ...env, SITE_URL: 'https://iszacka.dad' } as unknown as Env;
		const fetch = vi.fn(async () => Response.json({ id: 'm' }));
		vi.stubGlobal('fetch', fetch);
		try {
			const sub = { id: 7, email: 'someone@example.com', token: 'tok-xxxxxxxxxxxxxxxxxxxx', frequency: 'big' as const };
			await sendConfirmation(full, { ...sub, confirm_sent_at: '2026-11-01T10:00:00.000Z' });
			await sendConfirmation(full, { ...sub, confirm_sent_at: '2026-11-01T10:11:00.000Z' });
			const update = { id: 3, kind: 'status', title: 'Zack is a dad!', body: '', status: 'yes', audience: 'all', createdAt: '2026-11-10T14:00:00.000Z', notifiedAt: null } as const;
			const row = { ...sub, created_at: '2026-11-01T00:00:00.000Z', confirm_sent_at: null, confirmed_at: '2026-11-01T00:00:00.000Z', unsubscribed_at: null };
			await deliverEmail(full, row, update, { sleep });
			await deliverEmail(full, row, update, { sleep });
			const keys = fetch.mock.calls.map((call) => new Headers((call as unknown as [string, RequestInit])[1].headers).get('idempotency-key'));
			expect(keys[0]).not.toBe(keys[1]);
			expect(keys[2]).toBe(keys[3]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('does not retry a reused idempotency key, and reports it as permanent', async () => {
		const { env } = fakeEnv();
		const fetch = fakeFetch(error(409, 'invalid_idempotent_request'), okResponse('never'));
		expect(await sendEmail(env, msg, { sleep, fetch })).toMatchObject({ ok: false, transient: false, code: 'invalid_idempotent_request' });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(classifyEmailError(new ResendApiError(409, 'concurrent_idempotent_requests', 'x')).kind).toBe('transient');
	});

	it('keeps the reserve for real news when asked to', async () => {
		const { env } = fakeEnv(80);
		const fetch = fakeFetch(okResponse('never'));
		expect(await sendEmail(env, msg, { sleep, fetch, reserve: 10 })).toMatchObject({ ok: false, code: 'quota_reserve' });
		expect(fetch).not.toHaveBeenCalled();
		expect((await sendEmail(env, msg, { sleep, fetch })).ok).toBe(true);
	});

	it("doesn't call Resend once the daily limit is used up", async () => {
		const { env } = fakeEnv(90);
		const fetch = fakeFetch(okResponse('never'));
		expect(await sendEmail(env, msg, { sleep, fetch })).toMatchObject({ ok: false, transient: true, code: 'daily_quota_exceeded' });
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('updateEmailRenderer (render once per frequency)', () => {
	const tokens = [TOKEN, 'tok-AZaz09_-xxxxxxxxxxxxxxxx', "odd'token&<x>\"y\" é/?#"];

	it.each(VARIANTS)('%s/%s is byte-for-byte what renderUpdateEmail gives each subscriber', async (kind, status) => {
		const u = update(kind, status, { body: 'A note & a <b>half</b>.' });
		const render = updateEmailRenderer(BASE, u);
		for (const frequency of ['big', 'daily'] as Frequency[]) {
			for (const token of tokens) {
				expect(await render({ token, frequency })).toEqual(await renderUpdateEmail({ base: BASE, update: u, token, frequency }));
			}
		}
	});

	it('still renders correctly if the update text happens to contain the placeholder', async () => {
		const u = update('system', 'no', { body: 'izadTokenSlot7f3a9c2e' });
		const email = await updateEmailRenderer(BASE, u)({ token: TOKEN, frequency: 'big' });
		expect(email).toEqual(await renderUpdateEmail({ base: BASE, update: u, token: TOKEN, frequency: 'big' }));
	});

	it('no longer claims a headless browser photographs anything', async () => {
		const email = await renderUpdateEmail({ base: BASE, update: update('status', 'yes'), token: TOKEN, frequency: 'big' });
		expect(email.text).not.toMatch(/headless|photograph/i);
	});
});

describe('sendEmailBatch (Resend /emails/batch)', () => {
	/** A D1 stand-in: email_sends reads `sentToday`; writes are logged with their binds. */
	function fakeEnv(sentToday = 0) {
		const writes: Array<{ sql: string; binds: unknown[] }> = [];
		const reads = { n: 0 };
		const DB = {
			prepare(sql: string) {
				return {
					bind(...binds: unknown[]) {
						return {
							async first() {
								reads.n++;
								return { n: sentToday };
							},
							async run() {
								writes.push({ sql, binds });
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		};
		const env = {
			RESEND_API_KEY: 're_test_key',
			RESEND_API_BASE: 'https://resend.test',
			EMAIL_FROM: 'stork@iszacka.dad',
			EMAIL_FROM_NAME: 'The Stork',
			EMAIL_DAILY_LIMIT: '90',
			DB,
		} as unknown as Parameters<typeof sendEmailBatch>[0];
		return { env, writes, reads };
	}
	const msgs = (n: number) =>
		Array.from({ length: n }, (_, i) => ({ to: `p${i}@example.com`, subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', idempotencyKey: `update:1:${i}` }));
	const accepted = async (_url: string | URL | Request, init?: RequestInit) =>
		Response.json({ data: (JSON.parse(String(init?.body)) as unknown[]).map((_, i) => ({ id: `m${i}` })) });
	const sleep = vi.fn(async () => {});

	it('sends the whole batch in one permissive request, and counts it with one write', async () => {
		const { env, writes, reads } = fakeEnv(3);
		const fetch = vi.fn(accepted);
		const results = await sendEmailBatch(env, msgs(3), { fetch, sleep, idempotencyKey: 'update:1' });
		expect(results.map((r) => r.messageId)).toEqual(['m0', 'm1', 'm2']);
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe('https://resend.test/emails/batch');
		const headers = new Headers(init?.headers);
		expect(headers.get('user-agent')).toMatch(/iszacka\.dad/);
		expect(headers.get('x-batch-validation')).toBe('permissive');
		expect(headers.get('idempotency-key')).toMatch(/^[0-9a-f]{64}$/);
		const body = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(3);
		expect(body[0]).toMatchObject({ from: '"The Stork" <stork@iszacka.dad>', to: 'p0@example.com', subject: 'Hi' });
		expect(reads.n).toBe(1);
		expect(writes).toEqual([{ sql: expect.stringContaining('email_sends'), binds: [expect.any(String), 3] }]);
	});

	it('keys idempotency by the exact set of emails', async () => {
		const keyFor = async (batch: ReturnType<typeof msgs>, key = 'update:1') => {
			const fetch = vi.fn(accepted);
			await sendEmailBatch(fakeEnv().env, batch, { fetch, sleep, idempotencyKey: key });
			return new Headers(fetch.mock.calls[0]?.[1]?.headers).get('idempotency-key');
		};
		const a = await keyFor(msgs(3));
		expect(await keyFor(msgs(3))).toBe(a);
		expect(await keyFor(msgs(2))).not.toBe(a);
		expect(await keyFor(msgs(3), 'update:2')).not.toBe(a);
	});

	it('maps per-email rejections by index, and pairs the ids with the rest', async () => {
		const { env, writes } = fakeEnv();
		const fetch = vi.fn(async () =>
			Response.json({
				data: [{ id: 'a' }, { id: 'c' }],
				errors: [{ index: 1, message: 'Invalid `to` field. The email address needs to follow the `email@example.com` format.' }],
			}),
		);
		const results = await sendEmailBatch(env, msgs(3), { fetch, sleep });
		expect(results[0]).toMatchObject({ ok: true, messageId: 'a' });
		expect(results[1]).toMatchObject({ ok: false, transient: false });
		expect(results[2]).toMatchObject({ ok: true, messageId: 'c' });
		expect(writes[0]?.binds[1]).toBe(2);
	});

	it('treats a suppressed recipient as gone', async () => {
		const fetch = vi.fn(async () => Response.json({ data: [], errors: [{ index: 0, message: 'recipient_suppressed: on the suppression list' }] }));
		expect((await sendEmailBatch(fakeEnv().env, msgs(1), { fetch, sleep }))[0]).toMatchObject({ ok: false, gone: true, code: 'recipient_suppressed' });
	});

	it('sends only what the quota allows; the rest come back unsent with a quota code', async () => {
		const { env } = fakeEnv(85);
		const fetch = vi.fn(accepted);
		const results = await sendEmailBatch(env, msgs(8), { fetch, sleep });
		expect((JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as unknown[]).length).toBe(5);
		expect(results.filter((r) => r.ok)).toHaveLength(5);
		expect(results.slice(5).map((r) => r.code)).toEqual(['daily_quota_exceeded', 'daily_quota_exceeded', 'daily_quota_exceeded']);

		const reserved = await sendEmailBatch(fakeEnv(75).env, msgs(8), { fetch, sleep, reserve: 10 });
		expect(reserved.filter((r) => r.ok)).toHaveLength(5);
		expect(reserved[7]?.code).toBe('quota_reserve');

		const none = vi.fn(accepted);
		expect((await sendEmailBatch(fakeEnv(90).env, msgs(2), { fetch: none, sleep })).every((r) => r.code === 'daily_quota_exceeded')).toBe(true);
		expect(none).not.toHaveBeenCalled();
	});

	it('retries a whole-batch rate limit once with the same key, but not Resend running out of quota', async () => {
		const limited = vi
			.fn(accepted)
			.mockImplementationOnce(async () => Response.json({ name: 'rate_limit_exceeded', message: 'Too many requests' }, { status: 429 }));
		const results = await sendEmailBatch(fakeEnv().env, msgs(2), { fetch: limited, sleep });
		expect(results.every((r) => r.ok)).toBe(true);
		expect(limited).toHaveBeenCalledTimes(2);
		const keys = limited.mock.calls.map((c) => new Headers(c[1]?.headers).get('idempotency-key'));
		expect(keys[0]).toBe(keys[1]);

		const quota = vi.fn(async () => Response.json({ name: 'daily_quota_exceeded', message: 'quota' }, { status: 429 }));
		const out = await sendEmailBatch(fakeEnv().env, msgs(2), { fetch: quota, sleep });
		expect(quota).toHaveBeenCalledTimes(1);
		expect(out.map((r) => r.code)).toEqual(['daily_quota_exceeded', 'daily_quota_exceeded']);
	});

	it('reports a persistent outage for every email as transient, without throwing or counting', async () => {
		const { env, writes } = fakeEnv();
		const fetch = vi.fn(async () => Response.json({ name: 'application_error', message: 'boom' }, { status: 500 }));
		const results = await sendEmailBatch(env, msgs(2), { fetch, sleep });
		expect(results).toEqual([
			expect.objectContaining({ ok: false, transient: true, code: 'application_error' }),
			expect.objectContaining({ ok: false, transient: true, code: 'application_error' }),
		]);
		expect(writes).toEqual([]);
	});

	it('fails cleanly without an API key, and splits anything over 100 emails', async () => {
		const fetch = vi.fn(accepted);
		const { env } = fakeEnv();
		expect((await sendEmailBatch({ ...env, RESEND_API_KEY: undefined }, msgs(2), { fetch, sleep }))[0]).toMatchObject({ code: 'no_api_key' });
		expect(fetch).not.toHaveBeenCalled();
		const results = await sendEmailBatch({ ...env, EMAIL_DAILY_LIMIT: '1000' }, msgs(150), { fetch, sleep });
		expect(results.filter((r) => r.ok)).toHaveLength(150);
		expect(fetch.mock.calls.map((c) => (JSON.parse(String(c[1]?.body)) as unknown[]).length)).toEqual([100, 50]);
	});
});

describe('deliverEmailBatch', () => {
	it('renders per subscriber, sends one request and unsubscribes suppressed addresses', async () => {
		const { D1, db } = sqliteD1();
		const insert = db.prepare('INSERT INTO subscribers (email, frequency, token, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?)');
		insert.run('a@example.com', 'big', 'tok_aaaaaaaaaaaaaaaaaaaaaa', '2026-11-01', '2026-11-01');
		insert.run('b@example.com', 'daily', 'tok_bbbbbbbbbbbbbbbbbbbbbb', '2026-11-01', '2026-11-01');
		const subs = db.prepare('SELECT id, email, frequency, token, created_at, confirm_sent_at, confirmed_at, unsubscribed_at FROM subscribers').all() as unknown as SubscriberRow[];
		const env = { DB: D1, SITE_URL: BASE, RESEND_API_KEY: 'k', EMAIL_FROM: 'stork@iszacka.dad', EMAIL_FROM_NAME: 'The Stork', EMAIL_DAILY_LIMIT: '90' } as unknown as Env;
		const fetch = vi.fn(async () => Response.json({ data: [{ id: 'm1' }], errors: [{ index: 1, message: 'recipient_suppressed' }] }));

		const u = update('status', 'yes', { id: 9 });
		const results = await deliverEmailBatch(env, subs, u, { fetch });
		expect(results[0]).toMatchObject({ ok: true, messageId: 'm1' });
		expect(results[1]).toMatchObject({ ok: false, gone: true, detail: expect.stringContaining('(subscriber disabled)') });
		const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Array<{ html: string; headers: Record<string, string> }>;
		expect(body[0]?.html).toBe((await renderUpdateEmail({ base: BASE, update: u, token: subs[0]!.token, frequency: 'big' })).html);
		expect(body[1]?.html).toContain(`${BASE}/unsubscribe/${subs[1]!.token}`);
		expect(body[1]?.headers['List-Unsubscribe']).toBe(`<${BASE}/unsubscribe/${subs[1]!.token}>`);
		expect(db.prepare('SELECT email FROM subscribers WHERE unsubscribed_at IS NOT NULL').all()).toEqual([{ email: 'b@example.com' }]);
		expect(db.prepare('SELECT n FROM email_sends').get()).toEqual({ n: 1 });
	});
});
