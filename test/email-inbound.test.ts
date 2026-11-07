import { beforeEach, describe, expect, it, vi } from 'vitest';

// Other agents' modules are mocked so these tests only exercise the email agent's logic.
const mocks = vi.hoisted(() => ({
	parseGuessText: vi.fn(),
	submitGuess: vi.fn(),
	allow: vi.fn(async () => true),
	hashIdentifier: vi.fn(async (_env: unknown, value: string) => `hash:${value}`),
	getState: vi.fn(async () => ({ status: 'no', statusChangedAt: '2026-10-01T10:00:00.000Z', dueDate: '2026-11-20' })),
	liveStats: vi.fn(async () => ({ viewers: 2, vibes: 0 })),
	getCheckTotal: vi.fn(async () => 999),
}));
vi.mock('../src/lib/pool', () => ({ parseGuessText: mocks.parseGuessText, submitGuess: mocks.submitGuess }));
vi.mock('../src/lib/security', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/lib/security')>()),
	allow: mocks.allow,
	hashIdentifier: mocks.hashIdentifier,
}));
vi.mock('../src/lib/state', () => ({ getState: mocks.getState }));
vi.mock('../src/lib/live', () => ({ liveStats: mocks.liveStats }));
vi.mock('../src/lib/counters', () => ({ getCheckTotal: mocks.getCheckTotal }));

const {
	ANONYMOUS_NAME,
	automatedReason,
	bareAddress,
	cleanName,
	extractFreshText,
	handleInboundEmail,
	htmlToText,
	normaliseMessageId,
	ownDomains,
	threadingHeaders,
} = await import('../src/email-handler');
type InboundEmail = import('../src/email-handler').InboundEmail;

const OWN = ['iszacka.dad'];
const headers = (init: Record<string, string> = {}) => new Headers(init);
const reason = (from: string, h: Record<string, string> = {}) => automatedReason({ from, headers: headers(h), ownDomains: OWN });

describe('loop protection', () => {
	it('lets a normal human through', () => {
		expect(reason('alex@example.com')).toBeNull();
		expect(reason('alex@example.com', { 'Auto-Submitted': 'no' })).toBeNull();
		expect(reason('alex@example.com', { Precedence: 'first-class' })).toBeNull();
	});

	it.each([
		[{ 'Auto-Submitted': 'auto-replied' }, 'Auto-Submitted'],
		[{ 'Auto-Submitted': 'auto-generated; owner-email="x@example.com"' }, 'Auto-Submitted'],
		[{ Precedence: 'bulk' }, 'Precedence'],
		[{ Precedence: 'List' }, 'Precedence'],
		[{ Precedence: 'junk' }, 'Precedence'],
		[{ 'List-Id': 'Some list <list.example.com>' }, 'List-Id'],
		[{ 'X-Auto-Response-Suppress': 'OOF, AutoReply' }, 'X-Auto-Response-Suppress'],
		[{ 'X-Autoreply': 'yes' }, 'auto-responder header'],
	])('ignores %o', (h, expected) => {
		expect(reason('alex@example.com', h)).toBe(expected);
	});

	it.each([
		'',
		'<>',
		'MAILER-DAEMON@mx.example.com',
		'postmaster@example.com',
		'noreply@example.com',
		'no-reply@example.com',
		'notifications-noreply@example.com',
		'do-not-reply@example.com',
		'donotreply@example.com',
		'bounces+abc123@example.com',
		'list-bounces@example.com',
		'stork@iszacka.dad',
		'anything@mail.iszacka.dad',
	])('ignores sender %j', (from) => {
		expect(reason(from)).not.toBeNull();
	});

	it('treats a null Return-Path as a bounce, whatever the From says', () => {
		expect(reason('alex@example.com', { 'Return-Path': '<>' })).toBe('null sender (bounce)');
		expect(reason('alex@example.com', { 'Return-Path': '< >' })).toBe('null sender (bounce)');
		expect(reason('alex@example.com', { 'Return-Path': '<alex@example.com>' })).toBeNull();
	});

	it('derives our own domains from config', () => {
		expect(ownDomains({ EMAIL_FROM: 'stork@iszacka.dad', EMAIL_REPLY_FROM: 'answer@other.example', ZONE_NAME: 'iszacka.dad' })).toEqual([
			'iszacka.dad',
			'other.example',
		]);
	});
});

describe('parsing helpers', () => {
	it('drops quoted replies, signatures and two-line "wrote:" headers', () => {
		const text = ['14 Nov 15:30', 'Name: Alex', '', 'On Fri, 6 Nov 2026 at 21:30, Some Body <', 'body@example.com> wrote:', '> 1 Dec 10:00'].join('\n');
		expect(extractFreshText(text)).toBe('14 Nov 15:30\nName: Alex');
		expect(extractFreshText('hello\n> quoted 1 Jan\nbye\n-- \nsig 2 Feb')).toBe('hello\nbye');
		expect(extractFreshText('guess 3pm\n-----Original Message-----\nFrom: x')).toBe('guess 3pm');
	});

	it('turns HTML-only emails into text', () => {
		expect(htmlToText('<p>14 Nov&nbsp;15:30</p><div>Name: A &amp; B</div><style>p{}</style>')).toContain('14 Nov 15:30');
		expect(htmlToText('<p>Name: A &amp; B</p>')).toContain('Name: A & B');
	});

	it('cleans display names', () => {
		expect(cleanName('  "Alex  Smith"  ')).toBe('Alex Smith');
		expect(cleanName('alex@example.com')).toBeNull();
		expect(cleanName('‮evil‬')).toBe('evil');
		expect(cleanName('x'.repeat(100))).toHaveLength(40);
		expect(cleanName('')).toBeNull();
	});

	it('reduces any sender form to the bare, lower-cased address', () => {
		expect(bareAddress('Alex@Example.COM')).toBe('alex@example.com');
		expect(bareAddress('  <alex@example.com> ')).toBe('alex@example.com');
		expect(bareAddress('Alex Example <Alex@Example.com>')).toBe('alex@example.com');
		expect(bareAddress('"Example, Alex" <alex@example.com>')).toBe('alex@example.com');
		expect(bareAddress('"Sneaky <x@y.z>" <alex@example.com>')).toBe('alex@example.com');
		expect(bareAddress('')).toBe('');
		expect(bareAddress(null)).toBe('');
		expect(bareAddress('two words@example.com')).toBe('');
		expect(bareAddress('a@example.com, b@example.com')).toBe('');
	});

	it('normalises Message-IDs and builds threading headers', () => {
		expect(normaliseMessageId('<abc@host>')).toBe('<abc@host>');
		expect(normaliseMessageId('abc@host')).toBe('<abc@host>');
		expect(normaliseMessageId('garbage')).toBeNull();
		expect(threadingHeaders(null)).toEqual({});
		expect(threadingHeaders('<b@h>', '<a@h> <b@h> junk')).toEqual({ 'In-Reply-To': '<b@h>', References: '<a@h> <b@h>' });
	});
});

// ─── The handler, end to end (with a fake runtime and a fake Resend API) ────

interface Sent {
	to: string;
	from: string;
	subject: string;
	text: string;
	html: string;
	headers?: Record<string, string>;
}

function fakeEnv(sentToday = 0) {
	const sent: Sent[] = [];
	const inbound: unknown[][] = [];
	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async run() {
							if (sql.startsWith('INSERT INTO inbound_emails')) inbound.push(args);
							return { meta: { changes: 1 } };
						},
						async first() {
							return { n: sql.includes('email_sends') ? sentToday : 0 };
						},
					};
				},
			};
		},
	};
	const fetch = vi.fn(async (url: string, init: RequestInit) => {
		expect(url).toBe('https://resend.test/emails');
		expect(new Headers(init.headers).get('authorization')).toBe('Bearer re_test_key');
		sent.push(JSON.parse(String(init.body)) as Sent);
		return Response.json({ id: 'reply-1' });
	});
	vi.stubGlobal('fetch', fetch);
	const env = {
		DB: db,
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
	return { env, sent, inbound, fetch };
}

/** What Resend's receiving API hands us (after the webhook route has reduced the sender). */
function email(
	subject: string,
	body: string,
	from = 'alex@example.com',
	headers: Record<string, string> = {},
	authentication: InboundEmail['authentication'] = { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
): InboundEmail {
	return {
		from,
		subject,
		text: body,
		html: null,
		headers: { from: `Alex Example <${from}>`, 'message-id': '<orig-123@example.com>', ...headers },
		messageId: '<orig-123@example.com>',
		authentication,
	};
}

describe('handleInboundEmail', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		mocks.allow.mockResolvedValue(true);
	});

	it('enters a guess and replies with a threaded confirmation', async () => {
		const { env, sent, inbound } = fakeEnv();
		mocks.parseGuessText.mockReturnValue({ guessAt: '2026-11-14T15:30:00.000Z', name: 'Sam' });
		mocks.submitGuess.mockResolvedValue({ ok: true, id: 7 });

		await handleInboundEmail(email('My guess', '14 Nov 15:30\nName: Sam'), env);

		expect(mocks.parseGuessText.mock.calls[0]?.[0]).toBe('My guess\n14 Nov 15:30\nName: Sam');
		expect(mocks.submitGuess).toHaveBeenCalledWith(env, {
			name: 'Sam',
			guessAt: '2026-11-14T15:30:00.000Z',
			source: 'email',
			ipHash: 'hash:alex@example.com',
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ to: 'alex@example.com', subject: 'Re: My guess' });
		expect(sent[0]?.from).toContain('<answer@iszacka.dad>');
		expect(sent[0]?.headers).toMatchObject({
			'Auto-Submitted': 'auto-replied',
			'In-Reply-To': '<orig-123@example.com>',
			References: '<orig-123@example.com>',
		});
		expect(sent[0]?.text).toContain('#7');
		expect(sent[0]?.text).not.toContain('Anonymous emailer');
		expect(inbound).toEqual([['guess', 'hash:alex@example.com', expect.any(String)]]);
	});

	it('never puts the From display name on the leaderboard, and says so', async () => {
		const { env, sent } = fakeEnv();
		mocks.parseGuessText.mockReturnValue({ guessAt: '2026-11-14T15:30:00.000Z' });
		mocks.submitGuess.mockResolvedValue({ ok: true, id: 8 });

		await handleInboundEmail(email('GUESS', '14 Nov 15:30'), env);

		expect(mocks.submitGuess.mock.calls[0]?.[1]).toMatchObject({ name: ANONYMOUS_NAME });
		expect(JSON.stringify(mocks.submitGuess.mock.calls)).not.toContain('Alex Example');
		expect(sent[0]?.text).toContain('Anonymous emailer');
		expect(sent[0]?.text).toContain('Name: Alex');
		expect(sent[0]?.html).toContain('Anonymous emailer');
	});

	it('uses the bare, lower-cased sender for hashing, limits and the reply', async () => {
		const { env, sent } = fakeEnv();
		await handleInboundEmail(email('Well?', 'Is Zack a dad yet?', 'Alex Example <Alex@Example.com>'), env);
		expect(mocks.hashIdentifier).toHaveBeenCalledWith(env, 'alex@example.com');
		expect(mocks.allow).toHaveBeenCalledWith(env.RL_EMAIL, 'email:hash:alex@example.com');
		expect(sent[0]?.to).toBe('alex@example.com');
	});

	it('replies with the error and format help when the guess is rejected', async () => {
		const { env, sent } = fakeEnv();
		mocks.parseGuessText.mockReturnValue({ error: "I couldn't find a date in that." });
		await handleInboundEmail(email('guess', 'whenever'), env);
		expect(mocks.submitGuess).not.toHaveBeenCalled();
		expect(sent[0]?.text).toContain("I couldn't find a date in that.");
		expect(sent[0]?.text).toContain('Subject: guess');
		expect(sent[0]?.text).not.toContain('name on your email.');
	});

	it('auto-replies with the answer and stats otherwise', async () => {
		const { env, sent, inbound } = fakeEnv();
		await handleInboundEmail(email('Well?', 'Is Zack a dad yet?'), env);
		expect(mocks.parseGuessText).not.toHaveBeenCalled();
		expect(sent[0]?.subject).toBe('Re: Well?');
		expect(sent[0]?.text).toContain('Zack is not a dad. Yet.');
		expect(sent[0]?.text).toContain('dig +short TXT answer.iszacka.dad');
		expect(inbound[0]?.[0]).toBe('status');
	});

	it('never replies to auto-responders or bounces, but still counts them', async () => {
		const { env, sent, inbound } = fakeEnv();
		await handleInboundEmail(email('Out of office', 'Away', undefined, { 'auto-submitted': 'auto-replied' }), env);
		await handleInboundEmail(email('Undeliverable', 'Bounce', undefined, { 'return-path': '<>' }), env);
		await handleInboundEmail(email('Hi', 'Hi', ''), env);
		expect(sent).toHaveLength(0);
		expect(inbound.map((row) => row[0])).toEqual(['ignored', 'ignored', 'ignored']);
	});

	it('respects the per-sender rate limit', async () => {
		const { env, sent, inbound } = fakeEnv();
		mocks.allow.mockResolvedValue(false);
		await handleInboundEmail(email('Hi', 'Hi'), env);
		expect(sent).toHaveLength(0);
		expect(inbound[0]?.[0]).toBe('ignored');
	});

	it("doesn't crash without RESEND_API_KEY: the email is recorded, the reply isn't sent", async () => {
		const { env, sent, inbound, fetch } = fakeEnv();
		(env as { RESEND_API_KEY?: string }).RESEND_API_KEY = undefined;
		await expect(handleInboundEmail(email('Well?', 'Hello'), env)).resolves.toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
		expect(inbound[0]?.[0]).toBe('status');
	});

	it('ignores senders Resend could not authenticate: no reply, no guess', async () => {
		const { env, sent, inbound } = fakeEnv();
		mocks.parseGuessText.mockReturnValue({ guessAt: '2026-11-14T15:30:00.000Z', name: 'Sam' });
		await handleInboundEmail(email('guess', '14 Nov 15:30', undefined, {}, { spf: 'pass', dkim: 'fail', dmarc: 'fail' }), env);
		await handleInboundEmail(email('Your account is locked', 'Hi', undefined, {}, null), env);
		await handleInboundEmail(email('Hi', 'Hi', undefined, {}, { dkim: 'gray', dmarc: 'gray' }), env);
		// Forged headers don't count: only Resend's structured verdicts do.
		const forged = email('Hi', 'Hi', undefined, { 'authentication-results': 'mx.example.com; dkim=pass; dmarc=pass' });
		await handleInboundEmail({ ...forged, authentication: undefined }, env);
		expect(sent).toHaveLength(0);
		expect(mocks.submitGuess).not.toHaveBeenCalled();
		expect(inbound.map((row) => row[0])).toEqual(['ignored', 'ignored', 'ignored', 'ignored']);
	});

	it('replies to an aligned DKIM pass even when DMARC is gray (p=none)', async () => {
		const { env, sent } = fakeEnv();
		await handleInboundEmail(email('Well?', 'Is Zack a dad yet?', undefined, {}, { spf: 'pass', dkim: 'pass', dmarc: 'gray' }), env);
		expect(sent).toHaveLength(1);
	});

	it('keeps the last emails of the day for real news', async () => {
		const { env, sent, inbound } = fakeEnv(80);
		mocks.parseGuessText.mockReturnValue({ guessAt: '2026-11-14T15:30:00.000Z', name: 'Sam' });
		await handleInboundEmail(email('guess', '14 Nov 15:30'), env);
		expect(sent).toHaveLength(0);
		expect(mocks.submitGuess).not.toHaveBeenCalled();
		expect(inbound[0]?.[0]).toBe('ignored');
	});

	it('only advertises dig when the DNS record is kept up to date', async () => {
		const { env, sent } = fakeEnv();
		(env as { DNS_API_TOKEN?: string }).DNS_API_TOKEN = undefined;
		await handleInboundEmail(email('Well?', 'Is Zack a dad yet?'), env);
		expect(sent[0]?.text).not.toContain('dig +short');
	});

	it('never throws, even when everything is on fire', async () => {
		const { env } = fakeEnv();
		mocks.getState.mockRejectedValueOnce(new Error('D1 is down'));
		await expect(handleInboundEmail(email('Hi', 'Hi'), env)).resolves.toBeUndefined();
	});
});
