import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The subscriber writes are spied on and the INBOUND binding is a fake; the route, the svix
// verification, the dedupe and the sender normalisation are the real thing.
const mocks = vi.hoisted(() => ({
	disableSubscriberByEmail: vi.fn(async () => true),
}));
vi.mock('../src/lib/state', () => ({ getState: vi.fn(), getOrCreateSetting: vi.fn() }));
vi.mock('../src/lib/live', () => ({ liveStats: vi.fn() }));
vi.mock('../src/lib/counters', () => ({ getCheckTotal: vi.fn() }));
vi.mock('../src/lib/pool', () => ({ parseGuessText: vi.fn(), submitGuess: vi.fn() }));
vi.mock('../src/notify/email', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/notify/email')>()),
	disableSubscriberByEmail: mocks.disableSubscriberByEmail,
}));

const {
	INBOUND_SUCCESS_RETENTION,
	MAX_SKEW_SECONDS,
	claimResendEvent,
	inboundInstanceId,
	inboundParams,
	purgeResendEvents,
	releaseResendEvent,
	resendWebhookRoutes,
	signSvixPayload,
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

describe('handing off to the InboundWorkflow', () => {
	it("passes the email id, the webhook's sender as a bare, lower-cased address, and the svix-id", () => {
		expect(inboundParams({ email_id: 'e1', from: 'Sender@Example.org' }, 'msg_1')).toEqual({
			emailId: 'e1',
			from: 'sender@example.org',
			svixId: 'msg_1',
		});
		expect(inboundParams({ email_id: 'e1', from: 'Alex Example <Alex@Example.com>' }, 'msg_1').from).toBe('alex@example.com');
		expect(inboundParams({}, 'msg_1')).toEqual({ emailId: '', from: '', svixId: 'msg_1' });
		expect(inboundParams({ email_id: 7, from: ['x'] } as never, 'msg_1')).toEqual({ emailId: '', from: '', svixId: 'msg_1' });
	});

	it('names the instance after the svix-id, hashing ids Workflows would refuse', async () => {
		expect(await inboundInstanceId('msg_2abcDEF-x')).toBe('inbound-msg_2abcDEF-x');
		const odd = await inboundInstanceId('msg with spaces/and=signs');
		expect(odd).toMatch(/^inbound-h[0-9a-f]{40}$/);
		expect(await inboundInstanceId('msg with spaces/and=signs')).toBe(odd);
		expect(await inboundInstanceId('m'.repeat(150))).toMatch(/^inbound-h[0-9a-f]{40}$/);
		expect(await inboundInstanceId('m'.repeat(92))).toMatch(/^inbound-m{92}$/);
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

/** The INBOUND Workflow binding: instances by id, with switchable failures. */
function fakeWorkflow() {
	const instances = new Map<string, { params: unknown; retention?: unknown }>();
	const control = { createFails: false, getFails: false };
	return {
		instances,
		control,
		create: vi.fn(async (opts: { id: string; params: unknown; retention?: unknown }) => {
			if (control.createFails) throw new Error('internal error');
			if (instances.has(opts.id)) throw new Error('instance.already_exists');
			instances.set(opts.id, { params: opts.params, retention: opts.retention });
			return { id: opts.id };
		}),
		get: vi.fn(async (id: string) => {
			if (control.getFails || !instances.has(id)) throw new Error('instance.not_found');
			return { id };
		}),
	};
}

function setup(opts: { secret?: string | null } = {}) {
	const db = fakeDb();
	const workflow = fakeWorkflow();
	const env = {
		DB: db,
		INBOUND: workflow,
		RESEND_WEBHOOK_SECRET: opts.secret === null ? undefined : (opts.secret ?? SECRET),
		RESEND_API_KEY: 're_test_key',
		RESEND_API_BASE: 'https://resend.test',
	} as unknown as Env;
	const pending: Promise<unknown>[] = [];
	let waitUntilCalls = 0;
	const ctx = {
		waitUntil: (p: Promise<unknown>) => {
			waitUntilCalls++;
			pending.push(p);
		},
		passThroughOnException: () => {},
		props: {},
	} as unknown as ExecutionContext;
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
	return { env, db, workflow, post, waitUntilCalls: () => waitUntilCalls };
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
		// The request itself never talks to Resend.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('the webhook must not fetch anything');
			}),
		);
	});

	it('is 503 until RESEND_WEBHOOK_SECRET is set', async () => {
		const { post, workflow } = setup({ secret: null });
		expect((await post(received())).status).toBe(503);
		expect(workflow.create).not.toHaveBeenCalled();
	});

	it('is 401 for a bad signature, and records nothing', async () => {
		const { post, db, workflow } = setup();
		const res = await post(received(), { signature: `v1,${Buffer.alloc(32).toString('base64')}` });
		expect(res.status).toBe(401);
		expect(db.events.size).toBe(0);
		expect(workflow.create).not.toHaveBeenCalled();
	});

	it('is 401 for a stale timestamp', async () => {
		const { post } = setup();
		const stale = String(Math.floor(Date.now() / 1000) - MAX_SKEW_SECONDS - 60);
		expect((await post(received(), { timestamp: stale })).status).toBe(401);
	});

	it('hands email.received to the InboundWorkflow and answers straight away', async () => {
		const { post, db, workflow, waitUntilCalls } = setup();
		const res = await post(received('Alex@Example.com'), { id: 'msg_abc123' });
		expect(res).toMatchObject({ status: 200, json: { ok: true } });
		expect(workflow.create).toHaveBeenCalledTimes(1);
		expect(workflow.create).toHaveBeenCalledWith({
			id: 'inbound-msg_abc123',
			params: { emailId: 'e-123', from: 'alex@example.com', svixId: 'msg_abc123' },
			retention: { successRetention: INBOUND_SUCCESS_RETENTION },
		});
		expect([...db.events.values()]).toEqual([{ type: 'email.received', at: expect.any(String) }]);
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		// Nothing left running after the response: no waitUntil work at all.
		expect(waitUntilCalls()).toBe(0);
	});

	it('acknowledges a duplicate svix-id without starting anything again', async () => {
		const { post, db, workflow } = setup();
		const first = await post(received(), { id: 'msg_same' });
		const again = await post(received(), { id: 'msg_same' });
		expect(first.json).toEqual({ ok: true });
		expect(again).toMatchObject({ status: 200, json: { ok: true, duplicate: true } });
		expect(workflow.create).toHaveBeenCalledTimes(1);
		expect(db.events.size).toBe(1);
	});

	it('starts an instance even without an email_id (it records and counts the email)', async () => {
		const { post, workflow } = setup();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const event = received();
		expect((await post({ ...event, data: { ...event.data, email_id: undefined } }, { id: 'msg_noid' })).status).toBe(200);
		expect(workflow.instances.get('inbound-msg_noid')?.params).toEqual({ emailId: '', from: 'alex@example.com', svixId: 'msg_noid' });
		errors.mockRestore();
	});

	describe('when the workflow instance cannot be started', () => {
		it('answers 503, releases the svix-id and starts it on the redelivery', async () => {
			const { post, db, workflow } = setup();
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
			workflow.control.createFails = true;

			const first = await post(received(), { id: 'msg_retry' });
			expect(first).toMatchObject({ status: 503, json: { ok: false, error: 'try again later' } });
			expect(db.events.has('msg_retry')).toBe(false);
			expect(workflow.instances.size).toBe(0);

			// Resend redelivers the same svix-id (re-signed with a fresh timestamp).
			workflow.control.createFails = false;
			const again = await post(received(), { id: 'msg_retry' });
			expect(again).toMatchObject({ status: 200, json: { ok: true } });
			expect(db.events.has('msg_retry')).toBe(true);
			expect([...workflow.instances.keys()]).toEqual(['inbound-msg_retry']);

			// A third copy is a plain duplicate.
			expect((await post(received(), { id: 'msg_retry' })).json).toEqual({ ok: true, duplicate: true });
			expect(workflow.create).toHaveBeenCalledTimes(2);
			errors.mockRestore();
		});

		it('treats an instance that already exists as started', async () => {
			const { post, db, workflow } = setup();
			// An earlier delivery created it, then its claim was released (say, a timeout after create).
			workflow.instances.set('inbound-msg_exists', { params: {} });
			expect(await post(received(), { id: 'msg_exists' })).toMatchObject({ status: 200, json: { ok: true } });
			expect(workflow.get).toHaveBeenCalledWith('inbound-msg_exists');
			expect(db.events.has('msg_exists')).toBe(true);
		});

		it('still answers 503 if the claim cannot be released, and says so in the log', async () => {
			const { post, db, workflow } = setup();
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
			workflow.control.createFails = true;
			db.breakDeletes();
			expect((await post(received(), { id: 'msg_stuck' })).status).toBe(503);
			expect(errors.mock.calls.some(([msg]) => String(msg).includes('could not release the event'))).toBe(true);
			errors.mockRestore();
		});
	});

	it('answers 500 (so Resend retries) if the dedupe table cannot be written', async () => {
		const { post, db, workflow } = setup();
		db.breakIt();
		expect((await post(received())).status).toBe(500);
		expect(workflow.create).not.toHaveBeenCalled();
	});

	it('unsubscribes bounced and complaining recipients, by bare address, before answering', async () => {
		const { post, waitUntilCalls } = setup();
		const bounced = await post({
			type: 'email.bounced',
			data: { email_id: 'x', to: ['Someone <Someone@Example.com>'], bounce: { type: 'Permanent', subType: 'Suppressed' } },
		});
		expect(bounced.status).toBe(200);
		expect(mocks.disableSubscriberByEmail).toHaveBeenCalledWith(expect.anything(), 'someone@example.com');

		await post({ type: 'email.complained', data: { email_id: 'y', to: ['other@example.com'] } });
		expect(mocks.disableSubscriberByEmail).toHaveBeenLastCalledWith(expect.anything(), 'other@example.com');
		expect(waitUntilCalls()).toBe(0);
	});

	it('looks at no more than 10 recipients of a bounce, and skips junk', async () => {
		const { post } = setup();
		const to = [7, 'not an address', ...Array.from({ length: 20 }, (_, i) => `r${i}@example.com`)];
		expect((await post({ type: 'email.bounced', data: { email_id: 'x', to, bounce: { type: 'Permanent' } } })).status).toBe(200);
		expect(mocks.disableSubscriberByEmail).toHaveBeenCalledTimes(8);
	});

	it('leaves subscribers alone after a temporary bounce', async () => {
		const { post } = setup();
		await post({ type: 'email.bounced', data: { email_id: 'x', to: ['someone@example.com'], bounce: { type: 'Temporary' } } });
		expect(mocks.disableSubscriberByEmail).not.toHaveBeenCalled();
	});

	it('ignores other events with a 200', async () => {
		const { post, workflow } = setup();
		const res = await post({ type: 'email.delivered', data: { email_id: 'z' } });
		expect(res).toMatchObject({ status: 200, json: { ok: true, ignored: 'email.delivered' } });
		expect(workflow.create).not.toHaveBeenCalled();
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
