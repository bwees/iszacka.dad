import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from './email-inbound-helpers';

// Other agents' modules are mocked so these tests only exercise the inbound logic.
const mocks = vi.hoisted(() => ({
	parseGuessText: vi.fn(),
	allow: vi.fn(async () => true),
	hashIdentifier: vi.fn(async (_env: unknown, value: string) => `hash:${value}`),
}));
vi.mock('../src/lib/pool', () => ({ parseGuessText: mocks.parseGuessText, submitGuess: vi.fn() }));
vi.mock('../src/lib/security', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/lib/security')>()),
	allow: mocks.allow,
	hashIdentifier: mocks.hashIdentifier,
}));
vi.mock('../src/lib/state', () => ({ getState: vi.fn(), getOrCreateSetting: vi.fn() }));
vi.mock('../src/lib/live', () => ({ liveStats: vi.fn() }));
vi.mock('../src/lib/counters', () => ({ getCheckTotal: vi.fn() }));

const {
	MAX_GUESS_TEXT,
	MAX_HTML_CHARS,
	MAX_RECEIVED_BYTES,
	MAX_TEXT_CHARS,
	TransientFetchError,
	automatedReason,
	bareAddress,
	cleanName,
	decideInbound,
	extractFreshText,
	fetchReceivedEmail,
	guessText,
	htmlToText,
	keptHeaders,
	normaliseMessageId,
	ownDomains,
	readCapped,
	recordInbound,
	senderAuthenticated,
	sliceChars,
	threadingHeaders,
	trimReceivedEmail,
} = await import('../src/email-handler');
type FetchedEmail = import('../src/email-handler').FetchedEmail;

const OWN = ['iszacka.dad'];
const headers = (init: Record<string, string> = {}) => new Headers(init);
const reason = (from: string, h: Record<string, string> = {}) => automatedReason({ from, headers: headers(h), ownDomains: OWN });

/** Best of `runs` timings, in ms (the first run warms the JIT). */
function fastest(fn: () => unknown, runs = 3): number {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < runs; i++) {
		const start = performance.now();
		fn();
		best = Math.min(best, performance.now() - start);
	}
	return best;
}

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
		`${'a'.repeat(400)}@example.com`,
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

	it("only trusts Resend's structured verdicts", () => {
		expect(senderAuthenticated({ spf: 'pass', dkim: 'pass', dmarc: 'gray' })).toBe(true);
		expect(senderAuthenticated({ dkim: 'fail', dmarc: 'pass' })).toBe(true);
		expect(senderAuthenticated({ spf: 'pass', dkim: 'fail', dmarc: 'fail' })).toBe(false);
		expect(senderAuthenticated(null)).toBe(false);
	});
});

describe('parsing helpers', () => {
	it('drops quoted replies, signatures and two-line "wrote:" headers', () => {
		const text = ['14 Nov 15:30', 'Name: Alex', '', 'On Fri, 6 Nov 2026 at 21:30, Some Body <', 'body@example.com> wrote:', '> 1 Dec 10:00'].join('\n');
		expect(extractFreshText(text)).toBe('14 Nov 15:30\nName: Alex');
		expect(extractFreshText('hello\n> quoted 1 Jan\nbye\n-- \nsig 2 Feb')).toBe('hello\nbye');
		expect(extractFreshText('guess 3pm\n-----Original Message-----\nFrom: x')).toBe('guess 3pm');
		// A From: line only ends the fresh part once there is some.
		expect(extractFreshText('\n\nFrom: me\n14 Nov\nFrom: them\nold')).toBe('From: me\n14 Nov');
	});

	it('turns HTML-only emails into text', () => {
		expect(htmlToText('<p>14 Nov&nbsp;15:30</p><div>Name: A &amp; B</div><style>p{}</style>')).toContain('14 Nov 15:30');
		expect(htmlToText('<p>Name: A &amp; B</p>')).toContain('Name: A & B');
		expect(htmlToText('a<br>b<br/>c</p >d')).toBe('a\nb\nc\nd');
	});

	it('drops closed script, style and head blocks, and nothing else', () => {
		expect(htmlToText('<head><title>x 1 Jan</title></head><body>14 Nov</body>').trim()).toBe('14 Nov');
		expect(htmlToText('a<script type="x">1 Jan</script>b<STYLE>2 Feb</Style >c').replace(/\s+/g, '')).toBe('abc');
		// <header> is not <head>, and </header> doesn't close a <head>.
		expect(htmlToText('<header>14 Nov</header>')).toContain('14 Nov');
		expect(htmlToText('<head><header>14 Nov</header>').trim()).toBe('14 Nov');
		// An unclosed block keeps its content (only the tag goes), like the old regex.
		expect(htmlToText('<style>14 Nov 15:30').trim()).toBe('14 Nov 15:30');
		// Several blocks, one unclosed name among closed ones.
		expect(htmlToText('<style>a</style>x<script>y<style>b</style>z').replace(/\s+/g, '')).toBe('xyz');
	});

	it('reads at most MAX_HTML_CHARS of HTML', () => {
		const html = `<p>${'a'.repeat(MAX_HTML_CHARS)}</p><p>14 Nov</p>`;
		expect(htmlToText(html)).not.toContain('14 Nov');
		expect(sliceChars('ab\u{1F600}', 3)).toBe('ab');
	});

	describe('stays linear on hostile input', () => {
		const cases: Array<[string, string]> = [
			['140 KB of unclosed <style>', '<style>'.repeat(20_000)],
			['72 KB of <header> with no </head>', '<header>x'.repeat(8_000)],
			['140 KB of unclosed <script and <head', '<script <head '.repeat(10_000)],
			['140 KB of "<"', '<'.repeat(140_000)],
			['140 KB of <br followed by spaces', `<br${' '.repeat(140_000)}`],
			['140 KB of blank lines', '\n \n'.repeat(46_000)],
		];

		it.each(cases)('htmlToText: %s parses in under 5 ms', (_label, html) => {
			expect(fastest(() => htmlToText(html))).toBeLessThan(5);
		});

		it.each(cases)('htmlToText without the slice: %s stays under 25 ms', (_label, html) => {
			// The old code took 178 ms on the unclosed <style> and 175 ms on 32 KB of "<".
			expect(fastest(() => htmlToText(html, Number.POSITIVE_INFINITY))).toBeLessThan(25);
		});

		it('guessText on 140 KB of hostile text and HTML stays under 5 ms', () => {
			const lines = '\n'.repeat(70_000) + 'From: x\n'.repeat(10_000);
			expect(fastest(() => guessText('guess', lines, null))).toBeLessThan(5);
			expect(fastest(() => guessText('guess', null, '<style>'.repeat(20_000)))).toBeLessThan(5);
		});
	});

	it('hands the guess parser the subject and the fresh text, sliced', () => {
		expect(guessText('My guess', '14 Nov 15:30\n> 1 Dec', null)).toBe('My guess\n14 Nov 15:30');
		expect(guessText('guess', null, '<p>14 Nov</p><style>1 Dec</style>')).toBe('guess\n14 Nov');
		// Text wins over HTML, even when empty.
		expect(guessText('guess', '', '<p>14 Nov</p>')).toBe('guess\n');
		expect(guessText('guess', 'x'.repeat(100_000), null)).toHaveLength(MAX_GUESS_TEXT);
		// Only the first MAX_TEXT_CHARS are read at all.
		expect(guessText('guess', `${' '.repeat(MAX_TEXT_CHARS)}14 Nov`, null)).toBe('guess\n');
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
		expect(bareAddress(`${'a'.repeat(400)}@example.com`)).toBe('');
	});

	it('normalises Message-IDs and builds threading headers', () => {
		expect(normaliseMessageId('<abc@host>')).toBe('<abc@host>');
		expect(normaliseMessageId('abc@host')).toBe('<abc@host>');
		expect(normaliseMessageId('garbage')).toBeNull();
		expect(threadingHeaders(null)).toEqual({});
		expect(threadingHeaders('<b@h>', '<a@h> <b@h> junk')).toEqual({ 'In-Reply-To': '<b@h>', References: '<a@h> <b@h>' });
	});
});

// ─── Step 1: fetch ───────────────────────────────────────────────────────────

const received = (over: Record<string, unknown> = {}) => ({
	object: 'email',
	id: 'e-123',
	from: 'Alex Example <Alex@Example.com>',
	to: ['ask@iszacka.dad'],
	subject: 'My guess',
	text: '14 Nov 15:30\nName: Sam',
	html: '<p>14 Nov 15:30</p>',
	headers: {
		From: 'Alex Example <Alex@Example.com>',
		'Message-ID': '<orig-123@example.com>',
		References: ['<a@example.com>', '<b@example.com>'],
		'Authentication-Results': 'mx.example.com; dkim=pass; dmarc=pass',
		Received: 'from somewhere',
		'Auto-Submitted': 'no',
	},
	message_id: '<orig-123@example.com>',
	authentication: { spf: 'pass', dkim: 'pass', dmarc: 'gray', extra: 'ignored' },
	attachments: [],
	...over,
});

describe('trimReceivedEmail', () => {
	it('keeps only what the later steps read', () => {
		expect(trimReceivedEmail(received(), 'alex@example.com')).toEqual({
			from: 'alex@example.com',
			subject: 'My guess',
			text: '14 Nov 15:30\nName: Sam',
			html: null,
			headers: { 'message-id': '<orig-123@example.com>', references: '<a@example.com> <b@example.com>', 'auto-submitted': 'no' },
			messageId: '<orig-123@example.com>',
			references: '<a@example.com> <b@example.com>',
			authentication: { spf: 'pass', dkim: 'pass', dmarc: 'gray' },
		});
	});

	it("prefers the webhook's sender, else reduces the email's From to the bare address", () => {
		expect(trimReceivedEmail(received(), 'sender@example.org').from).toBe('sender@example.org');
		expect(trimReceivedEmail(received(), '').from).toBe('alex@example.com');
	});

	it('drops the body unless it is a guess, and keeps HTML only without a text part', () => {
		expect(trimReceivedEmail(received({ subject: 'Well?' }))).toMatchObject({ text: null, html: null });
		const html = trimReceivedEmail(received({ text: null, html: `<p>14 Nov</p>${'x'.repeat(100_000)}` }));
		expect(html.text).toBeNull();
		expect(html.html).toHaveLength(MAX_HTML_CHARS);
		expect(trimReceivedEmail(received({ text: 'y'.repeat(100_000) })).text).toHaveLength(MAX_TEXT_CHARS);
	});

	it('never carries forged authentication headers, and survives junk', () => {
		const forged = trimReceivedEmail(received({ authentication: undefined }));
		expect(forged.authentication).toBeNull();
		expect(JSON.stringify(forged)).not.toContain('dkim=pass');
		const junk = trimReceivedEmail({ id: 'x', subject: 7, headers: 'nope', authentication: 'pass' } as never);
		expect(junk).toMatchObject({ from: '', subject: '', headers: {}, authentication: null, messageId: null });
	});

	it('caps header values, keeping the newest References', () => {
		const refs = Array.from({ length: 200 }, (_, i) => `<ref-${i}@example.com>`).join(' ');
		const kept = keptHeaders({ references: refs, 'list-id': '', precedence: 'p'.repeat(5000), 'x-other': 'x' });
		expect(kept.references?.endsWith('<ref-199@example.com>')).toBe(true);
		expect(kept.references?.length).toBeLessThanOrEqual(2000);
		expect(kept.precedence).toHaveLength(2000);
		expect(kept['list-id']).toBe('');
		expect(kept).not.toHaveProperty('x-other');
	});
});

describe('readCapped', () => {
	it('reads a body under the cap', async () => {
		expect(await readCapped(new Response('hello'), 10)).toBe('hello');
	});

	it('refuses a declared or streamed body over the cap', async () => {
		expect(await readCapped(new Response('x'.repeat(20), { headers: { 'content-length': '20' } }), 10)).toBeNull();
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(4096));
			},
		});
		expect(await readCapped(new Response(stream), 10_000)).toBeNull();
	});
});

describe('fetchReceivedEmail', () => {
	const env = { RESEND_API_KEY: 're_test_key', RESEND_API_BASE: 'https://resend.test/' } as unknown as Env;
	afterEach(() => vi.unstubAllGlobals());

	it('GETs the email with the key, a User-Agent and a timeout, and trims it', async () => {
		const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json(received()));
		vi.stubGlobal('fetch', fetch);
		const result = await fetchReceivedEmail(env, 'e/123', 'alex@example.com');
		expect(result).toMatchObject({ ok: true, email: { from: 'alex@example.com', subject: 'My guess' } });
		const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://resend.test/emails/receiving/e%2F123');
		expect(new Headers(init.headers).get('authorization')).toBe('Bearer re_test_key');
		expect(new Headers(init.headers).get('user-agent')).toMatch(/iszacka\.dad/);
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it.each([
		['a 429', async () => new Response('', { status: 429 })],
		['a 500', async () => new Response('', { status: 500 })],
		['a network error', async () => Promise.reject(new TypeError('Network connection lost'))],
		['a timeout', async () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
		['a body that is not JSON', async () => new Response('<html>')],
	])('throws for %s, so the step retries', async (_label, fail) => {
		vi.stubGlobal('fetch', vi.fn(fail));
		await expect(fetchReceivedEmail(env, 'e-123')).rejects.toBeInstanceOf(TransientFetchError);
	});

	it.each([404, 403, 422])('gives up on HTTP %i', async (status) => {
		vi.spyOn(console, 'error').mockImplementationOnce(() => {});
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'not_found' }, { status })));
		expect(await fetchReceivedEmail(env, 'e-123')).toEqual({ ok: false, reason: `HTTP ${status}` });
	});

	it('gives up without an id or a key, without fetching', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		vi.spyOn(console, 'error').mockImplementationOnce(() => {});
		expect(await fetchReceivedEmail(env, '')).toEqual({ ok: false, reason: 'no email_id' });
		expect(await fetchReceivedEmail({ ...env, RESEND_API_KEY: '' } as Env, 'e-123')).toEqual({ ok: false, reason: 'no RESEND_API_KEY' });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('does not parse an email over MAX_RECEIVED_BYTES', async () => {
		const parse = vi.spyOn(JSON, 'parse');
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(received({ html: 'x'.repeat(MAX_RECEIVED_BYTES) })))));
		expect(await fetchReceivedEmail(env, 'e-123')).toEqual({ ok: false, reason: 'message too large' });
		expect(parse).not.toHaveBeenCalled();
		parse.mockRestore();
	});
});

// ─── Step 2: decide (real SQL over node:sqlite) ──────────────────────────────

function decideEnv(sentToday = 0) {
	const sql = sqliteD1();
	if (sentToday) sql.db.prepare('INSERT INTO email_sends (day, n) VALUES (?, ?)').run(new Date().toISOString().slice(0, 10), sentToday);
	const env = {
		DB: sql.D1,
		EMAIL_FROM: 'stork@iszacka.dad',
		EMAIL_REPLY_FROM: 'answer@iszacka.dad',
		EMAIL_DAILY_LIMIT: '90',
		ZONE_NAME: 'iszacka.dad',
		RL_EMAIL: {},
	} as unknown as Env;
	return { env, sql };
}

const fetched = (over: Partial<FetchedEmail> = {}): FetchedEmail => ({
	from: 'alex@example.com',
	subject: 'Well?',
	text: null,
	html: null,
	headers: {},
	messageId: '<orig-123@example.com>',
	references: null,
	authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
	...over,
});

describe('decideInbound', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.allow.mockResolvedValue(true);
	});

	it('answers a human with the status, reading quota and history in one batch', async () => {
		const { env, sql } = decideEnv();
		expect(await decideInbound(env, fetched())).toEqual({ action: 'status', fromHash: 'hash:alex@example.com' });
		expect(sql.log.filter((s) => s.startsWith('SELECT'))).toHaveLength(2);
		expect(mocks.allow).toHaveBeenCalledWith(env.RL_EMAIL, 'email:hash:alex@example.com');
	});

	it('parses a guess, keeping only an explicit Name: line', async () => {
		const { env } = decideEnv();
		mocks.parseGuessText.mockReturnValueOnce({ guessAt: '2026-11-14T15:30:00.000Z', name: '  "Sam" ' });
		const named = await decideInbound(env, fetched({ subject: 'My guess', text: '14 Nov 15:30\nName: Sam\n> 1 Dec' }));
		expect(mocks.parseGuessText.mock.calls[0]?.[0]).toBe('My guess\n14 Nov 15:30\nName: Sam');
		expect(named).toEqual({ action: 'guess', fromHash: 'hash:alex@example.com', guess: { guessAt: '2026-11-14T15:30:00.000Z', name: 'Sam' } });

		mocks.parseGuessText.mockReturnValueOnce({ guessAt: '2026-11-14T15:30:00.000Z' });
		expect(await decideInbound(env, fetched({ subject: 'GUESS', text: '14 Nov' }))).toMatchObject({ guess: { name: null } });

		mocks.parseGuessText.mockReturnValueOnce({ error: 'No date.' });
		expect(await decideInbound(env, fetched({ subject: 'guess', text: 'whenever' }))).toMatchObject({ guess: { error: 'No date.' } });
	});

	it('checks robots and authentication before spending the rate limit', async () => {
		const { env } = decideEnv();
		expect(await decideInbound(env, fetched({ headers: { 'auto-submitted': 'auto-replied' } }))).toMatchObject({
			action: 'ignore',
			reason: 'Auto-Submitted',
		});
		expect(await decideInbound(env, fetched({ authentication: { dkim: 'fail', dmarc: 'fail' } }))).toMatchObject({
			reason: 'sender not authenticated',
		});
		expect(await decideInbound(env, fetched({ from: '' }))).toMatchObject({ reason: 'null sender (bounce)', fromHash: null });
		expect(mocks.allow).not.toHaveBeenCalled();
	});

	it('counts this email towards the reserve: 78 sent leaves room, 79 does not', async () => {
		expect(await decideInbound(decideEnv(78).env, fetched())).toMatchObject({ action: 'status' });
		expect(await decideInbound(decideEnv(79).env, fetched())).toMatchObject({ reason: 'daily send quota down to the reserve' });
		expect(mocks.allow).toHaveBeenCalledTimes(1);
	});

	it('applies the per-minute and per-day limits', async () => {
		const { env, sql } = decideEnv();
		mocks.allow.mockResolvedValueOnce(false);
		expect(await decideInbound(env, fetched())).toMatchObject({ reason: 'per-minute limit' });
		const insert = sql.db.prepare('INSERT INTO inbound_emails (kind, from_hash, at) VALUES (?, ?, ?)');
		const recent = new Date(Date.now() - 3_600_000).toISOString();
		for (let i = 0; i < 20; i++) insert.run('status', 'hash:alex@example.com', recent);
		expect(await decideInbound(env, fetched())).toMatchObject({ reason: 'daily limit' });
	});

	it('fails open if D1 is down, as the quota always has', async () => {
		const { env, sql } = decideEnv(85);
		sql.failBatches(1);
		vi.spyOn(console, 'error').mockImplementationOnce(() => {});
		expect(await decideInbound(env, fetched())).toMatchObject({ action: 'status' });
	});
});

// ─── Step 5: record ──────────────────────────────────────────────────────────

describe('recordInbound', () => {
	const day = '2026-11-07';
	const now = new Date(`${day}T10:00:00.000Z`);

	it('records and counts each email exactly once, however often it runs', async () => {
		const { env, sql } = decideEnv();
		expect(await recordInbound(env, 'inbound-msg_1', 'status', 'hash:a', now)).toBe(true);
		expect(await recordInbound(env, 'inbound-msg_1', 'status', 'hash:a', now)).toBe(false);
		expect(await recordInbound(env, 'inbound-msg_1', 'ignored', null, now)).toBe(false);
		expect(await recordInbound(env, 'inbound-msg_2', 'ignored', null, now)).toBe(true);
		expect(sql.rows('SELECT day, n FROM email_sends')).toEqual([{ day, n: 2 }]);
		expect(sql.rows('SELECT kind, from_hash FROM inbound_emails ORDER BY id')).toEqual([
			{ kind: 'status', from_hash: 'hash:a' },
			{ kind: 'ignored', from_hash: null },
		]);
		expect(sql.rows("SELECT svix_id FROM resend_events WHERE type = 'inbound.recorded' ORDER BY svix_id")).toEqual([
			{ svix_id: 'inbound-msg_1' },
			{ svix_id: 'inbound-msg_2' },
		]);
	});

	it('adds to the day the reply sends already counted', async () => {
		const { env, sql } = decideEnv(5);
		await recordInbound(env, 'inbound-msg_3', 'guess', 'hash:b');
		expect(sql.rows('SELECT n FROM email_sends')).toEqual([{ n: 6 }]);
	});

	it('throws (so the step retries) when D1 is down, having written nothing', async () => {
		const { env, sql } = decideEnv();
		sql.failBatches(1);
		await expect(recordInbound(env, 'inbound-msg_4', 'status', null, now)).rejects.toThrow(/outage/);
		expect(sql.rows('SELECT * FROM inbound_emails')).toEqual([]);
		expect(await recordInbound(env, 'inbound-msg_4', 'status', null, now)).toBe(true);
		expect(sql.rows('SELECT n FROM email_sends')).toEqual([{ n: 1 }]);
	});
});
