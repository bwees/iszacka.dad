import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The inbound handler and the subscriber/quota writes are spied on; the route, the svix
// verification, the dedupe and the sender normalisation are the real thing.
const mocks = vi.hoisted(() => ({
	handleInboundEmail: vi.fn(async () => {}),
	disableSubscriberByEmail: vi.fn(async () => true),
	recordEmailSend: vi.fn(async () => {}),
}));
vi.mock('../src/lib/state', () => ({ getState: vi.fn(), getOrCreateSetting: vi.fn() }));
vi.mock('../src/lib/live', () => ({ liveStats: vi.fn() }));
vi.mock('../src/lib/counters', () => ({ getCheckTotal: vi.fn() }));
vi.mock('../src/lib/pool', () => ({ parseGuessText: vi.fn(), submitGuess: vi.fn() }));
vi.mock('../src/email-handler', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/email-handler')>()),
	handleInboundEmail: mocks.handleInboundEmail,
}));
vi.mock('../src/notify/email', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/notify/email')>()),
	disableSubscriberByEmail: mocks.disableSubscriberByEmail,
	recordEmailSend: mocks.recordEmailSend,
}));

const {
	MAX_SKEW_SECONDS,
	claimResendEvent,
	purgeResendEvents,
	releaseResendEvent,
	resendWebhookRoutes,
	signSvixPayload,
	toInboundEmail,
	verifySvixSignature,
} = await import('../src/routes/resend-webhook');

// A throwaway secret in Resend's format (never a real one).
const KEY = randomBytes(24);
const SECRET = `whsec_${KEY.toString('base64')}`;
const NOW = 1_794_000_000;

/** The reference implementation: what Svix documents, computed with node:crypto. */
function nodeSign(key: Buffer, id: string, timestamp: string, body: string): string {
	return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

describe('svix signatures', () => {
	const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e1' } });
	const id = 'msg_2abcDEF';
	const ts = String(NOW);

	it('matches a node:crypto HMAC-SHA256 vector', async () => {
		expect(await signSvixPayload(SECRET, id, ts, body)).toBe(nodeSign(KEY, id, ts, body));
	});

	it('accepts a valid signature, including one among several', async () => {
		const sig = nodeSign(KEY, id, ts, body);
		expect(await verifySvixSignature(SECRET, { id, timestamp: ts, signature: `v1,${sig}` }, body, NOW)).toBe(true);
		const several = `v1,${Buffer.alloc(32).toString('base64')} v1,${sig}`;
		expect(await verifySvixSignature(SECRET, { id, timestamp: ts, signature: several }, body, NOW)).toBe(true);
	});

	it('rejects tampering, a wrong key, wrong versions and missing headers', async () => {
		const sig = nodeSign(KEY, id, ts, body);
		const verify = (h: { id: string | null; timestamp: string | null; signature: string | null }, b = body) => verifySvixSignature(SECRET, h, b, NOW);
		expect(await verify({ id, timestamp: ts, signature: `v1,${sig}` }, `${body} `)).toBe(false);
		expect(await verify({ id: 'msg_other', timestamp: ts, signature: `v1,${sig}` })).toBe(false);
		expect(await verify({ id, timestamp: ts, signature: `v1,${nodeSign(randomBytes(24), id, ts, body)}` })).toBe(false);
		expect(await verify({ id, timestamp: ts, signature: `v2,${sig}` })).toBe(false);
		expect(await verify({ id, timestamp: ts, signature: sig })).toBe(false);
		expect(await verify({ id: null, timestamp: ts, signature: `v1,${sig}` })).toBe(false);
		expect(await verify({ id, timestamp: null, signature: `v1,${sig}` })).toBe(false);
		expect(await verify({ id, timestamp: ts, signature: null })).toBe(false);
	});

	it('rejects timestamps outside the tolerance (replays)', async () => {
		for (const skew of [MAX_SKEW_SECONDS + 1, -(MAX_SKEW_SECONDS + 1)]) {
			const old = String(NOW - skew);
			const sig = nodeSign(KEY, id, old, body);
			expect(await verifySvixSignature(SECRET, { id, timestamp: old, signature: `v1,${sig}` }, body, NOW)).toBe(false);
		}
		const edge = String(NOW - MAX_SKEW_SECONDS);
		expect(await verifySvixSignature(SECRET, { id, timestamp: edge, signature: `v1,${nodeSign(KEY, id, edge, body)}` }, body, NOW)).toBe(true);
	});

	it('returns false, not an exception, for a secret that is not base64', async () => {
		expect(await verifySvixSignature('whsec_!!!not base64!!!', { id, timestamp: ts, signature: 'v1,AAAA' }, body, NOW)).toBe(false);
	});
});

describe('toInboundEmail', () => {
	const received = {
		id: 'e1',
		from: 'Alex Example <Alex@Example.com>',
		subject: 'guess',
		text: '14 Nov 15:30',
		headers: { from: 'Alex Example <Alex@Example.com>', references: ['<a@x>', '<b@x>'] },
		message_id: '<m@x>',
	};

	it("prefers the webhook's bare data.from, lower-cased", () => {
		expect(toInboundEmail({ from: 'Sender@Example.org' }, received).from).toBe('sender@example.org');
	});

	it("falls back to the retrieved email's From, reduced to the bare address", () => {
		expect(toInboundEmail({}, received).from).toBe('alex@example.com');
		expect(toInboundEmail({ from: '' }, received).from).toBe('alex@example.com');
	});

	it('never carries a display name, and joins repeated headers', () => {
		const inbound = toInboundEmail({ from: 'alex@example.com' }, received);
		expect(Object.keys(inbound)).not.toContain('fromName');
		expect(inbound.references).toBe('<a@x> <b@x>');
		expect(inbound.messageId).toBe('<m@x>');
	});

	it("carries Resend's authentication verdicts, and never trusts forged headers", async () => {
		const { senderAuthenticated } = await import('../src/email-handler');
		const signed = toInboundEmail({}, { ...received, authentication: { spf: 'pass', dkim: 'pass', dmarc: 'gray' } });
		expect(signed.authentication).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'gray' });
		expect(signed.id).toBe('e1');
		expect(senderAuthenticated(signed.authentication)).toBe(true);

		const forged = toInboundEmail(
			{},
			{ ...received, headers: { ...received.headers, 'authentication-results': 'mx.example.com; dkim=pass; dmarc=pass' } },
		);
		expect(forged.authentication).toBeNull();
		expect(senderAuthenticated(forged.authentication)).toBe(false);
	});
});

// ─── The route ───────────────────────────────────────────────────────────────

/** Enough D1 for resend_events and subscribers, in memory. */
function fakeDb() {
	const events = new Map<string, { type: string; at: string }>();
	let broken = false;
	let deletesBroken = false;
	return {
		events,
		breakIt: () => {
			broken = true;
		},
		breakDeletes: () => {
			deletesBroken = true;
		},
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async run() {
							if (broken) throw new Error('D1_ERROR: no such table: resend_events');
							if (sql.startsWith('INSERT INTO resend_events')) {
								const [id, type, at] = args as [string, string, string];
								if (events.has(id)) return { meta: { changes: 0 } };
								events.set(id, { type, at });
								return { meta: { changes: 1 } };
							}
							if (sql.startsWith('DELETE FROM resend_events WHERE svix_id')) {
								if (deletesBroken) throw new Error('D1_ERROR: database is locked');
								const [id] = args as [string];
								return { meta: { changes: events.delete(id) ? 1 : 0 } };
							}
							if (sql.startsWith('DELETE FROM resend_events')) {
								const [cutoff] = args as [string];
								let n = 0;
								for (const [id, row] of events) {
									if (row.at < cutoff) {
										events.delete(id);
										n++;
									}
								}
								return { meta: { changes: n } };
							}
							return { meta: { changes: 0 } };
						},
					};
				},
			};
		},
	};
}

function setup(opts: { secret?: string | null } = {}) {
	const db = fakeDb();
	const env = {
		DB: db,
		RESEND_WEBHOOK_SECRET: opts.secret === null ? undefined : (opts.secret ?? SECRET),
		RESEND_API_KEY: 're_test_key',
		RESEND_API_BASE: 'https://resend.test',
	} as unknown as Env;
	const pending: Promise<unknown>[] = [];
	const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
	const post = async (event: unknown, headers: { id?: string; signature?: string; timestamp?: string } = {}) => {
		const body = JSON.stringify(event);
		const id = headers.id ?? `msg_${randomBytes(6).toString('hex')}`;
		const timestamp = headers.timestamp ?? String(Math.floor(Date.now() / 1000));
		const res = await resendWebhookRoutes.request(
			'/api/resend/webhook',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'svix-id': id,
					'svix-timestamp': timestamp,
					'svix-signature': headers.signature ?? `v1,${nodeSign(KEY, id, timestamp, body)}`,
				},
				body,
			},
			env,
			ctx,
		);
		await Promise.all(pending.splice(0));
		return { status: res.status, json: (await res.json()) as Record<string, unknown> };
	};
	return { env, db, post };
}

const received = (from = 'alex@example.com') => ({
	type: 'email.received',
	created_at: '2026-11-07T10:00:00.000Z',
	data: { email_id: 'e-123', from, to: ['ask@iszacka.dad'], subject: 'Well?', message_id: '<m@example.com>' },
});

describe('POST /api/resend/webhook', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				expect(url).toBe('https://resend.test/emails/receiving/e-123');
				expect(new Headers(init?.headers).get('user-agent')).toMatch(/iszacka\.dad/);
				return Response.json({
					object: 'email',
					id: 'e-123',
					from: 'Alex Example <Alex@Example.com>',
					subject: 'Well?',
					text: 'Is Zack a dad yet?',
					html: null,
					headers: { from: 'Alex Example <Alex@Example.com>' },
					message_id: '<m@example.com>',
				});
			}),
		);
	});

	it('is 503 until RESEND_WEBHOOK_SECRET is set', async () => {
		const { post } = setup({ secret: null });
		expect((await post(received())).status).toBe(503);
		expect(mocks.handleInboundEmail).not.toHaveBeenCalled();
	});

	it('is 401 for a bad signature, and records nothing', async () => {
		const { post, db } = setup();
		const res = await post(received(), { signature: `v1,${Buffer.alloc(32).toString('base64')}` });
		expect(res.status).toBe(401);
		expect(db.events.size).toBe(0);
		expect(mocks.handleInboundEmail).not.toHaveBeenCalled();
	});

	it('is 401 for a stale timestamp', async () => {
		const { post } = setup();
		const stale = String(Math.floor(Date.now() / 1000) - MAX_SKEW_SECONDS - 60);
		expect((await post(received(), { timestamp: stale })).status).toBe(401);
	});

	it('handles email.received with the bare sender from data.from, and counts it', async () => {
		const { post, db } = setup();
		const res = await post(received('Alex@Example.com'));
		expect(res).toEqual({ status: 200, json: { ok: true } });
		expect(mocks.recordEmailSend).toHaveBeenCalledTimes(1);
		expect(mocks.handleInboundEmail).toHaveBeenCalledTimes(1);
		const [inbound] = mocks.handleInboundEmail.mock.calls[0] as unknown as [{ from: string; subject: string; text: string }];
		expect(inbound).toMatchObject({ from: 'alex@example.com', subject: 'Well?', text: 'Is Zack a dad yet?' });
		expect(JSON.stringify(inbound)).not.toContain('fromName');
		expect([...db.events.values()]).toEqual([{ type: 'email.received', at: expect.any(String) }]);
	});

	it('acknowledges a duplicate svix-id without processing it again', async () => {
		const { post, db } = setup();
		const first = await post(received(), { id: 'msg_same' });
		const again = await post(received(), { id: 'msg_same' });
		expect(first.json).toEqual({ ok: true });
		expect(again).toEqual({ status: 200, json: { ok: true, duplicate: true } });
		expect(mocks.handleInboundEmail).toHaveBeenCalledTimes(1);
		expect(mocks.recordEmailSend).toHaveBeenCalledTimes(1);
		expect(db.events.size).toBe(1);
	});

	it('fetches the received email with a timeout, inside the request', async () => {
		const { post } = setup();
		await post(received());
		const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	describe('when fetching the received email fails', () => {
		const ok = () =>
			Response.json({ object: 'email', id: 'e-123', subject: 'Well?', text: 'Is Zack a dad yet?', headers: {}, message_id: '<m@example.com>' });

		const transient: [string, () => Promise<Response>][] = [
			['a 429', async () => Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '1' } })],
			['a 500', async () => new Response('upstream error', { status: 500 })],
			['a 503', async () => new Response('unavailable', { status: 503 })],
			['a network error', async () => Promise.reject(new TypeError('Network connection lost'))],
			['a timeout', async () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
		];

		it.each(transient)('answers 503 for %s, releases the svix-id and handles the redelivery once', async (_label, fail) => {
			const { post, db } = setup();
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.stubGlobal('fetch', vi.fn(fail));

			const first = await post(received(), { id: 'msg_retry' });
			expect(first).toEqual({ status: 503, json: { ok: false, error: 'try again later' } });
			expect(db.events.has('msg_retry')).toBe(false);
			expect(mocks.recordEmailSend).not.toHaveBeenCalled();
			expect(mocks.handleInboundEmail).not.toHaveBeenCalled();

			// Resend redelivers the same svix-id (re-signed with a fresh timestamp).
			vi.stubGlobal('fetch', vi.fn(async () => ok()));
			const again = await post(received(), { id: 'msg_retry' });
			expect(again).toEqual({ status: 200, json: { ok: true } });
			expect(db.events.has('msg_retry')).toBe(true);
			expect(mocks.recordEmailSend).toHaveBeenCalledTimes(1);
			expect(mocks.handleInboundEmail).toHaveBeenCalledTimes(1);

			// A third copy is a plain duplicate.
			expect((await post(received(), { id: 'msg_retry' })).json).toEqual({ ok: true, duplicate: true });
			expect(mocks.handleInboundEmail).toHaveBeenCalledTimes(1);
			errors.mockRestore();
		});

		it('still answers 503 if the claim cannot be released, and says so in the log', async () => {
			const { post, db } = setup();
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
			db.breakDeletes();
			expect((await post(received(), { id: 'msg_stuck' })).status).toBe(503);
			expect(errors.mock.calls.some(([msg]) => String(msg).includes('could not release the event'))).toBe(true);
			expect(mocks.handleInboundEmail).not.toHaveBeenCalled();
			errors.mockRestore();
		});

		it.each([
			['a 404', 404],
			['a 403', 403],
			['a 422', 422],
		])('keeps the claim and answers 200 for %s (permanent), counting the email once', async (_label, status) => {
			const { post, db } = setup();
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'not_found' }, { status })));
			const res = await post(received(), { id: 'msg_gone' });
			expect(res).toEqual({ status: 200, json: { ok: true } });
			expect(db.events.has('msg_gone')).toBe(true);
			expect(mocks.recordEmailSend).toHaveBeenCalledTimes(1);
			expect(mocks.handleInboundEmail).not.toHaveBeenCalled();
			expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
			errors.mockRestore();
		});

		it('keeps the claim and answers 200 without an email_id or an API key', async () => {
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
			const noId = setup();
			const event = received();
			const res = await noId.post({ ...event, data: { ...event.data, email_id: undefined } });
			expect(res.status).toBe(200);
			expect(noId.db.events.size).toBe(1);

			const noKey = setup();
			(noKey.env as unknown as { RESEND_API_KEY?: string }).RESEND_API_KEY = undefined;
			expect((await noKey.post(received())).status).toBe(200);
			expect(noKey.db.events.size).toBe(1);

			expect(vi.mocked(fetch)).not.toHaveBeenCalled();
			expect(mocks.recordEmailSend).toHaveBeenCalledTimes(2);
			expect(mocks.handleInboundEmail).not.toHaveBeenCalled();
			errors.mockRestore();
		});
	});

	it('answers 500 (so Resend retries) if the dedupe table cannot be written', async () => {
		const { post, db } = setup();
		db.breakIt();
		expect((await post(received())).status).toBe(500);
		expect(mocks.handleInboundEmail).not.toHaveBeenCalled();
	});

	it('unsubscribes bounced and complaining recipients, by bare address', async () => {
		const { post } = setup();
		const bounced = await post({
			type: 'email.bounced',
			data: { email_id: 'x', to: ['Someone <Someone@Example.com>'], bounce: { type: 'Permanent', subType: 'Suppressed' } },
		});
		expect(bounced.status).toBe(200);
		expect(mocks.disableSubscriberByEmail).toHaveBeenCalledWith(expect.anything(), 'someone@example.com');

		await post({ type: 'email.complained', data: { email_id: 'y', to: ['other@example.com'] } });
		expect(mocks.disableSubscriberByEmail).toHaveBeenLastCalledWith(expect.anything(), 'other@example.com');
	});

	it('leaves subscribers alone after a temporary bounce', async () => {
		const { post } = setup();
		await post({ type: 'email.bounced', data: { email_id: 'x', to: ['someone@example.com'], bounce: { type: 'Temporary' } } });
		expect(mocks.disableSubscriberByEmail).not.toHaveBeenCalled();
	});

	it('ignores other events with a 200', async () => {
		const { post } = setup();
		const res = await post({ type: 'email.delivered', data: { email_id: 'z' } });
		expect(res).toEqual({ status: 200, json: { ok: true, ignored: 'email.delivered' } });
		expect(mocks.handleInboundEmail).not.toHaveBeenCalled();
	});

	it('is 400 for a signed body that is not JSON', async () => {
		// post() always sends JSON, so sign a raw non-JSON body by hand.
		const id = 'msg_raw';
		const ts = String(Math.floor(Date.now() / 1000));
		const env = { DB: fakeDb(), RESEND_WEBHOOK_SECRET: SECRET } as unknown as Env;
		const res = await resendWebhookRoutes.request(
			'/api/resend/webhook',
			{ method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${nodeSign(KEY, id, ts, 'not json')}` }, body: 'not json' },
			env,
			{ waitUntil: () => {} } as unknown as ExecutionContext,
		);
		expect(res.status).toBe(400);
	});
});

describe('resend_events housekeeping', () => {
	it('claims each svix-id once and purges old rows', async () => {
		const db = fakeDb();
		const env = { DB: db } as unknown as Env;
		expect(await claimResendEvent(env, 'msg_a', 'email.received', '2026-09-01T00:00:00.000Z')).toBe(true);
		expect(await claimResendEvent(env, 'msg_a', 'email.received')).toBe(false);
		expect(await claimResendEvent(env, 'msg_b', 'email.bounced', '2026-11-06T00:00:00.000Z')).toBe(true);
		expect(await purgeResendEvents(env, new Date('2026-11-07T00:00:00.000Z'))).toBe(1);
		expect([...db.events.keys()]).toEqual(['msg_b']);
	});

	it('releases a claim so the same svix-id can be claimed again', async () => {
		const db = fakeDb();
		const env = { DB: db } as unknown as Env;
		expect(await claimResendEvent(env, 'msg_c', 'email.received')).toBe(true);
		await releaseResendEvent(env, 'msg_c');
		expect(db.events.has('msg_c')).toBe(false);
		expect(await claimResendEvent(env, 'msg_c', 'email.received')).toBe(true);
	});
});
