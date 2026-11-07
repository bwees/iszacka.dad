import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeStep, fakeStep, sqliteD1 } from './email-inbound-helpers';

// The InboundWorkflow end to end: a fake step runner, a fake Resend API, and the real SQL
// (D1 over node:sqlite with the real migrations). Other agents' modules are stubbed, except
// submitGuess, which runs for real against the database.
const mocks = vi.hoisted(() => ({
	parseGuessText: vi.fn(),
	allow: vi.fn(async () => true),
	hashIdentifier: vi.fn(async (_env: unknown, value: string) => `hash:${value}`),
	getState: vi.fn(),
	liveStats: vi.fn(async () => ({ viewers: 2, vibes: 0 })),
	getCheckTotal: vi.fn(async () => 999),
}));
vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));
vi.mock('../src/lib/pool', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/lib/pool')>()),
	parseGuessText: mocks.parseGuessText,
}));
vi.mock('../src/lib/security', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/lib/security')>()),
	allow: mocks.allow,
	hashIdentifier: mocks.hashIdentifier,
}));
vi.mock('../src/lib/state', () => ({ getState: mocks.getState, getOrCreateSetting: vi.fn() }));
vi.mock('../src/lib/live', () => ({ liveStats: mocks.liveStats }));
vi.mock('../src/lib/counters', () => ({ getCheckTotal: mocks.getCheckTotal }));

const { inbound, REPLY_RETRIES } = await import('../src/workflows/inbound');
const { ANONYMOUS_NAME, MAX_HTML_CHARS } = await import('../src/email-handler');

const SENDER = 'alex@example.com';
const DAY_MS = 86_400_000;
const GUESS_AT = new Date(Date.now() + 10 * DAY_MS).toISOString();
const today = () => new Date().toISOString().slice(0, 10);

interface Sent {
	to: string;
	from: string;
	subject: string;
	text: string;
	html: string;
	headers?: Record<string, string>;
	idempotencyKey: string | null;
}

/** What GET /emails/receiving/{id} returns. */
function receivedEmail(over: Record<string, unknown> = {}) {
	return {
		object: 'email',
		id: 'e-123',
		from: `Alex Example <${SENDER}>`,
		to: ['ask@iszacka.dad'],
		subject: 'Well?',
		text: 'Is Zack a dad yet?',
		html: null,
		headers: { from: `Alex Example <${SENDER}>`, 'message-id': '<orig-123@example.com>' },
		message_id: '<orig-123@example.com>',
		authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
		...over,
	};
}

type Handler = () => Promise<Response>;

function setup(opts: { sentToday?: number; received?: Record<string, unknown> } = {}) {
	const sql = sqliteD1();
	if (opts.sentToday) sql.db.prepare('INSERT INTO email_sends (day, n) VALUES (?, ?)').run(today(), opts.sentToday);
	const sent: Sent[] = [];
	const resend = {
		receive: [] as Handler[],
		send: [] as Handler[],
		received: receivedEmail(opts.received),
	};
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		expect(headers.get('authorization')).toBe('Bearer re_test_key');
		if (url.startsWith('https://resend.test/emails/receiving/')) {
			const next = resend.receive.shift();
			return next ? next() : Response.json(resend.received);
		}
		expect(url).toBe('https://resend.test/emails');
		const next = resend.send.shift();
		if (next) return next();
		sent.push({ ...(JSON.parse(String(init?.body)) as Sent), idempotencyKey: headers.get('idempotency-key') });
		return Response.json({ id: `reply-${sent.length}` });
	});
	vi.stubGlobal('fetch', fetch);
	const env = {
		DB: sql.D1,
		RESEND_API_KEY: 're_test_key',
		RESEND_API_BASE: 'https://resend.test',
		EMAIL_FROM: 'stork@iszacka.dad',
		EMAIL_FROM_NAME: 'The Stork',
		EMAIL_REPLY_FROM: 'answer@iszacka.dad',
		EMAIL_DAILY_LIMIT: '90',
		ZONE_NAME: 'iszacka.dad',
		SITE_URL: 'https://iszacka.dad',
		DNS_RECORD_NAME: 'answer.iszacka.dad',
		DNS_API_TOKEN: 'dns-token',
		RL_EMAIL: {},
	} as unknown as Env;
	const params = { emailId: 'e-123', from: SENDER, svixId: 'msg_1' };
	const run = (s: FakeStep = fakeStep(), p: Partial<typeof params> = {}) => inbound(env, { ...params, ...p }, `inbound-${p.svixId ?? params.svixId}`, s.step);
	const inboundRows = () => sql.rows('SELECT kind, from_hash FROM inbound_emails ORDER BY id');
	const sendsToday = () => Number(sql.rows('SELECT n FROM email_sends WHERE day = ?', today())[0]?.n ?? 0);
	return { env, sql, sent, resend, fetch, run, inboundRows, sendsToday };
}

describe('InboundWorkflow', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.allow.mockResolvedValue(true);
		mocks.getState.mockResolvedValue({
			status: 'no',
			statusChangedAt: '2026-10-01T10:00:00.000Z',
			dueDate: new Date(Date.now() + 20 * DAY_MS).toISOString().slice(0, 10),
		});
	});

	it('enters a guess and replies with a threaded confirmation, one fixed step at a time', async () => {
		const t = setup({ received: { subject: 'My guess', text: '14 Nov 15:30\nName: Sam\n\n> 1 Dec 10:00' } });
		mocks.parseGuessText.mockReturnValue({ guessAt: GUESS_AT, name: 'Sam' });
		const s = fakeStep();

		const summary = await t.run(s);

		expect(s.names).toEqual(['fetch', 'decide', 'guess', 'reply', 'record']);
		expect(mocks.parseGuessText.mock.calls[0]?.[0]).toBe('My guess\n14 Nov 15:30\nName: Sam');
		expect(t.sql.rows('SELECT name, guess_at, source, ip_hash FROM guesses')).toEqual([
			{ name: 'Sam', guess_at: GUESS_AT, source: 'email', ip_hash: `hash:${SENDER}` },
		]);
		expect(t.sent).toHaveLength(1);
		expect(t.sent[0]).toMatchObject({ to: SENDER, subject: 'Re: My guess' });
		expect(t.sent[0]?.from).toContain('<answer@iszacka.dad>');
		expect(t.sent[0]?.headers).toMatchObject({
			'Auto-Submitted': 'auto-replied',
			'In-Reply-To': '<orig-123@example.com>',
			References: '<orig-123@example.com>',
		});
		expect(t.sent[0]?.text).toMatch(/#\d+/);
		expect(t.sent[0]?.text).not.toContain(ANONYMOUS_NAME);
		expect(t.inboundRows()).toEqual([{ kind: 'guess', from_hash: `hash:${SENDER}` }]);
		// The received email plus the reply.
		expect(t.sendsToday()).toBe(2);
		expect(summary).toEqual({ kind: 'guess', replied: true, recorded: true });
	});

	it('never puts the From display name on the leaderboard, and says so', async () => {
		const t = setup({ received: { subject: 'GUESS', text: '14 Nov 15:30' } });
		mocks.parseGuessText.mockReturnValue({ guessAt: GUESS_AT });
		await t.run();
		expect(t.sql.rows('SELECT name FROM guesses')).toEqual([{ name: ANONYMOUS_NAME }]);
		expect(t.sent[0]?.text).toContain(ANONYMOUS_NAME);
		expect(t.sent[0]?.text).toContain('Name: Alex');
		expect(JSON.stringify(t.sql.rows('SELECT * FROM guesses'))).not.toContain('Alex Example');
	});

	it("falls back to the email's From, as the bare, lower-cased address, for hashing, limits and the reply", async () => {
		const t = setup({ received: { from: 'Alex Example <Alex@Example.com>' } });
		await t.run(fakeStep(), { from: '' });
		expect(mocks.hashIdentifier).toHaveBeenCalledWith(expect.anything(), SENDER);
		expect(mocks.allow).toHaveBeenCalledWith(expect.anything(), `email:hash:${SENDER}`);
		expect(t.sent[0]?.to).toBe(SENDER);
	});

	it('replies with the error and format help when the guess is rejected, without a guess step', async () => {
		const t = setup({ received: { subject: 'guess', text: 'whenever' } });
		mocks.parseGuessText.mockReturnValue({ error: "I couldn't find a date in that." });
		const s = fakeStep();
		await t.run(s);
		expect(s.names).toEqual(['fetch', 'decide', 'reply', 'record']);
		expect(t.sql.rows('SELECT * FROM guesses')).toEqual([]);
		expect(t.sent[0]?.text).toContain("I couldn't find a date in that.");
		expect(t.sent[0]?.text).toContain('Subject: guess');
	});

	it('tells the sender when the pool refuses the guess', async () => {
		const t = setup({ received: { subject: 'guess', text: '14 Nov' } });
		mocks.parseGuessText.mockReturnValue({ guessAt: '2020-01-01T12:00:00.000Z', name: 'Sam' });
		await t.run();
		expect(t.sql.rows('SELECT * FROM guesses')).toEqual([]);
		expect(t.sent[0]?.subject).toBe('Re: guess');
		expect(t.sent[0]?.text).toContain("didn't go in");
	});

	it('auto-replies with the answer and stats otherwise', async () => {
		const t = setup();
		const s = fakeStep();
		await t.run(s);
		expect(s.names).toEqual(['fetch', 'decide', 'reply', 'record']);
		expect(mocks.parseGuessText).not.toHaveBeenCalled();
		expect(t.sent[0]?.subject).toBe('Re: Well?');
		expect(t.sent[0]?.text).toContain('Zack is not a dad. Yet.');
		expect(t.sent[0]?.text).toContain('dig +short TXT answer.iszacka.dad');
		expect(t.sent[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
		expect(t.inboundRows()).toEqual([{ kind: 'status', from_hash: `hash:${SENDER}` }]);
	});

	it('only advertises dig when the DNS record is kept up to date', async () => {
		const t = setup();
		(t.env as { DNS_API_TOKEN?: string }).DNS_API_TOKEN = undefined;
		await t.run();
		expect(t.sent[0]?.text).not.toContain('dig +short');
	});

	it.each([
		['an auto-responder', { headers: { 'auto-submitted': 'auto-replied' } }, 'Auto-Submitted'],
		['a bounce', { headers: { 'return-path': '<>' } }, 'null sender (bounce)'],
		['an unauthenticated sender', { authentication: { spf: 'pass', dkim: 'fail', dmarc: 'fail' } }, 'sender not authenticated'],
		['an email from before Resend authenticated', { authentication: null }, 'sender not authenticated'],
		['forged authentication headers', { authentication: undefined, headers: { 'authentication-results': 'mx; dkim=pass; dmarc=pass' } }, 'sender not authenticated'],
	])('never replies to %s, but still records and counts it', async (_label, over, reason) => {
		const t = setup({ received: { subject: 'guess', ...over } });
		mocks.parseGuessText.mockReturnValue({ guessAt: GUESS_AT, name: 'Sam' });
		const s = fakeStep();
		expect(await t.run(s)).toEqual({ kind: 'ignored', reason, recorded: true });
		expect(s.names).toEqual(['fetch', 'decide', 'record']);
		expect(t.sent).toHaveLength(0);
		expect(t.sql.rows('SELECT * FROM guesses')).toEqual([]);
		expect(t.inboundRows()).toEqual([{ kind: 'ignored', from_hash: `hash:${SENDER}` }]);
		expect(t.sendsToday()).toBe(1);
	});

	it('replies to an aligned DKIM pass even when DMARC is gray (p=none)', async () => {
		const t = setup({ received: { authentication: { spf: 'pass', dkim: 'pass', dmarc: 'gray' } } });
		await t.run();
		expect(t.sent).toHaveLength(1);
	});

	it('respects the per-sender rate limit', async () => {
		const t = setup();
		mocks.allow.mockResolvedValue(false);
		expect(await t.run()).toMatchObject({ kind: 'ignored', reason: 'per-minute limit' });
		expect(t.sent).toHaveLength(0);
	});

	it('keeps the last emails of the day for real news', async () => {
		const t = setup({ sentToday: 80, received: { subject: 'guess' } });
		mocks.parseGuessText.mockReturnValue({ guessAt: GUESS_AT, name: 'Sam' });
		expect(await t.run()).toMatchObject({ kind: 'ignored', reason: 'daily send quota down to the reserve' });
		expect(t.sent).toHaveLength(0);
		expect(t.sql.rows('SELECT * FROM guesses')).toEqual([]);
		expect(t.sendsToday()).toBe(81);
	});

	it('records and counts the email without RESEND_API_KEY, and fetches nothing', async () => {
		const t = setup();
		(t.env as { RESEND_API_KEY?: string }).RESEND_API_KEY = undefined;
		expect(await t.run()).toEqual({ kind: 'ignored', reason: 'no RESEND_API_KEY', recorded: true });
		expect(t.fetch).not.toHaveBeenCalled();
		expect(t.inboundRows()).toEqual([{ kind: 'ignored', from_hash: null }]);
		expect(t.sendsToday()).toBe(1);
	});

	describe('fetching the email', () => {
		it('retries transient failures inside the step, then carries on', async () => {
			const t = setup();
			t.resend.receive.push(
				async () => new Response('', { status: 429 }),
				async () => new Response('', { status: 503 }),
				async () => Promise.reject(new TypeError('Network connection lost')),
			);
			const s = fakeStep();
			expect(await t.run(s)).toMatchObject({ kind: 'status', replied: true });
			expect(s.attempts.get('fetch')).toBe(4);
			expect(t.sent).toHaveLength(1);
		});

		it('still records and counts the email once it gives up', async () => {
			const t = setup();
			t.resend.receive.push(...Array.from({ length: 20 }, () => async () => new Response('', { status: 500 })));
			const s = fakeStep();
			expect(await t.run(s)).toEqual({ kind: 'ignored', reason: 'fetch failed', recorded: true });
			expect(s.names).toEqual(['fetch', 'record']);
			expect(t.sendsToday()).toBe(1);
			expect(t.inboundRows()).toEqual([{ kind: 'ignored', from_hash: null }]);
		});

		it.each([404, 403, 422])('records and counts the email after a permanent HTTP %i', async (status) => {
			const t = setup();
			t.resend.receive.push(async () => Response.json({ name: 'not_found' }, { status }));
			const s = fakeStep();
			expect(await t.run(s)).toEqual({ kind: 'ignored', reason: `HTTP ${status}`, recorded: true });
			expect(s.attempts.get('fetch')).toBe(1);
			expect(t.sendsToday()).toBe(1);
		});

		it('handles an event without an email_id', async () => {
			const t = setup();
			expect(await t.run(fakeStep(), { emailId: '' })).toMatchObject({ reason: 'no email_id', recorded: true });
			expect(t.fetch).not.toHaveBeenCalled();
		});

		it('keeps the step result small: no body unless it is a guess, HTML capped', async () => {
			const t = setup({ received: { text: 'x'.repeat(50_000), html: `<p>${'y'.repeat(200_000)}</p>` } });
			const results: unknown[] = [];
			const s = fakeStep();
			const doStep = s.step.do.bind(s.step) as (...args: unknown[]) => Promise<unknown>;
			(s.step as unknown as { do: (...args: unknown[]) => Promise<unknown> }).do = async (...args) => {
				const result = await doStep(...args);
				if (args[0] === 'fetch') results.push(result);
				return result;
			};
			await t.run(s);
			expect(results[0]).toMatchObject({ ok: true, email: { text: null, html: null } });
			expect(JSON.stringify(results[0]).length).toBeLessThan(1000);

			const g = setup({ received: { subject: 'guess', text: null, html: `<p>14 Nov</p>${'<style>'.repeat(20_000)}` } });
			mocks.parseGuessText.mockReturnValue({ error: 'No date.' });
			const start = performance.now();
			await g.run();
			expect(performance.now() - start).toBeLessThan(250);
			expect(mocks.parseGuessText.mock.calls.at(-1)?.[0].startsWith('guess\n14 Nov')).toBe(true);
			expect(MAX_HTML_CHARS).toBe(32_000);
		});
	});

	describe('exactly once', () => {
		it('counts and records the email once when the record step runs twice', async () => {
			const t = setup();
			const s = fakeStep();
			s.repeat.add('record');
			expect(await t.run(s)).toMatchObject({ recorded: false });
			expect(t.inboundRows()).toHaveLength(1);
			// The received email once, the reply once.
			expect(t.sendsToday()).toBe(2);
		});

		it('replays finished steps instead of repeating them', async () => {
			const t = setup({ received: { subject: 'guess', text: '14 Nov' } });
			mocks.parseGuessText.mockReturnValue({ guessAt: GUESS_AT, name: 'Sam' });
			const s = fakeStep();
			const first = await t.run(s);
			const again = await t.run(s);
			expect(again).toEqual(first);
			expect(t.sent).toHaveLength(1);
			expect(t.sql.rows('SELECT * FROM guesses')).toHaveLength(1);
			expect(t.inboundRows()).toHaveLength(1);
		});

		it('counts the email on the day Resend received it, however late the record step runs', async () => {
			const t = setup();
			t.resend.receive.push(async () => new Response('', { status: 404 }));
			const receivedAt = new Date('2026-11-06T23:59:30.000Z');
			await inbound(t.env, { emailId: 'e-123', from: SENDER, svixId: 'msg_late' }, 'inbound-msg_late', fakeStep().step, receivedAt);
			expect(t.sql.rows('SELECT day, n FROM email_sends')).toEqual([{ day: '2026-11-06', n: 1 }]);
			expect(t.sql.rows('SELECT at FROM inbound_emails')).toEqual([{ at: receivedAt.toISOString() }]);
		});

		it('never double-counts a restarted instance, and its reply reuses the idempotency key', async () => {
			const t = setup();
			await t.run();
			await t.run();
			expect(t.inboundRows()).toHaveLength(1);
			expect(t.sent).toHaveLength(2);
			expect(t.sent[1]?.idempotencyKey).toBe(t.sent[0]?.idempotencyKey);
			// Resend would drop the second send; our count only ever sees one received email.
			expect(t.sendsToday()).toBe(3);
		});
	});

	describe('the reply', () => {
		it('retries a transient send failure with the same idempotency key', async () => {
			const t = setup();
			const keys: Array<string | null> = [];
			const fail = (status: number) => async () => {
				keys.push(new Headers((t.fetch.mock.calls.at(-1)?.[1] as RequestInit).headers).get('idempotency-key'));
				return Response.json({ name: 'internal_server_error' }, { status });
			};
			// sendEmail retries once in-process; the step retries the rest.
			t.resend.send.push(fail(500), fail(502), fail(503));
			const s = fakeStep();
			expect(await t.run(s)).toMatchObject({ kind: 'status', replied: true });
			expect(s.attempts.get('reply')).toBe(2);
			expect(new Set([...keys, t.sent[0]?.idempotencyKey])).toHaveProperty('size', 1);
			expect(t.sent).toHaveLength(1);
		}, 15_000);

		it('gives up quietly after its retries, and still records the email', async () => {
			const t = setup();
			t.resend.send.push(...Array.from({ length: 20 }, () => async () => new Response('', { status: 500 })));
			const s = fakeStep();
			expect(await t.run(s)).toMatchObject({ kind: 'status', replied: false, code: 'unknown_error', recorded: true });
			expect(s.attempts.get('reply')).toBe(REPLY_RETRIES);
			expect(t.inboundRows()).toEqual([{ kind: 'status', from_hash: `hash:${SENDER}` }]);
		}, 30_000);

		it('does not retry a permanent failure', async () => {
			const t = setup();
			t.resend.send.push(async () => Response.json({ name: 'validation_error', message: 'nope' }, { status: 422 }));
			const s = fakeStep();
			expect(await t.run(s)).toMatchObject({ replied: false, code: 'validation_error' });
			expect(s.attempts.get('reply')).toBe(1);
		});

		it('survives a broken status lookup: no reply, still recorded', async () => {
			const t = setup();
			mocks.getState.mockRejectedValue(new Error('D1 is down'));
			expect(await t.run()).toMatchObject({ kind: 'status', replied: false, recorded: true });
			expect(t.sent).toHaveLength(0);
		});
	});

	it('never stores the sender address, and keeps it out of the summary', async () => {
		const t = setup({ received: { subject: 'guess', text: '14 Nov' } });
		mocks.parseGuessText.mockReturnValue({ guessAt: GUESS_AT, name: null });
		// A real hash, not the readable stand-in the other tests use.
		mocks.hashIdentifier.mockResolvedValueOnce('5f3a9c0d1e2b4a6f8c7d9e0f1a2b3c4d');
		const summary = await t.run();
		expect(t.inboundRows()).toEqual([{ kind: 'guess', from_hash: '5f3a9c0d1e2b4a6f8c7d9e0f1a2b3c4d' }]);
		expect(JSON.stringify(summary)).not.toContain(SENDER);
		for (const { name } of t.sql.rows("SELECT name FROM sqlite_master WHERE type = 'table'")) {
			expect(JSON.stringify(t.sql.rows(`SELECT * FROM "${String(name)}"`))).not.toContain(SENDER);
		}
	});
});
