import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/lib/state', () => ({
	getOrCreateSetting: vi.fn(async (_env: unknown, key: string, create: () => Promise<string> | string) => {
		if (!settings.has(key)) settings.set(key, await create());
		return settings.get(key) as string;
	}),
}));

import { base64UrlEncode } from '../src/lib/security';
import { verifyVapidJwt } from '../src/lib/vapid';
import {
	classifyPushStatus,
	deliverPush,
	deliverPushBatch,
	isPushServiceHost,
	listPushTargets,
	MAX_PUSH_FAILURES,
	PUSH_TTL_SECONDS,
	pushHeaders,
	retryDelayMs,
} from '../src/notify/push';
import { endpointFrom, parsePushSubscription } from '../src/routes/push';
import type { PushSubscriptionRow } from '../src/types';
import { fakeEnv, scriptedFetch, UPDATE_YES } from './push-helpers';

const SUB: PushSubscriptionRow = {
	id: 11,
	endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def',
	p256dh: 'unused-for-payloadless-pushes',
	auth: 'unused',
	failures: 0,
};

beforeEach(() => settings.clear());
afterEach(() => vi.unstubAllGlobals());

describe('push service responses', () => {
	it.each([
		[200, 'ok'],
		[201, 'ok'],
		[202, 'ok'],
		[404, 'gone'],
		[410, 'gone'],
		[429, 'retry'],
		[500, 'retry'],
		[503, 'retry'],
		[0, 'retry'],
		[400, 'fail'],
		[401, 'fail'],
		[403, 'fail'],
		[413, 'fail'],
	] as const)('%i → %s', (status, outcome) => {
		expect(classifyPushStatus(status)).toBe(outcome);
	});

	it('honours Retry-After, within reason', () => {
		const now = Date.parse('2026-11-06T21:00:00Z');
		expect(retryDelayMs('0', now)).toBe(0);
		expect(retryDelayMs('2', now)).toBe(2000);
		expect(retryDelayMs('120', now)).toBe(3000);
		expect(retryDelayMs(new Date(now + 1500).toUTCString(), now)).toBeLessThanOrEqual(1500);
		expect(retryDelayMs('soon-ish', now)).toBe(750);
		expect(retryDelayMs(null, now)).toBe(750);
	});

	it('sends payload-less push headers', () => {
		expect(pushHeaders('vapid t=x, k=y')).toEqual({
			Authorization: 'vapid t=x, k=y',
			TTL: String(PUSH_TTL_SECONDS),
			Urgency: 'high',
			Topic: 'iszackadad-status',
			'Content-Length': '0',
		});
		expect(PUSH_TTL_SECONDS).toBe(86_400);
	});
});

describe('listPushTargets', () => {
	it('lists active subscriptions after an id, ascending, with a sane limit', async () => {
		const { env, queries } = fakeEnv({}, () => [SUB]);
		expect(await listPushTargets(env, 5, 25)).toEqual([SUB]);
		expect(queries[0]?.sql).toContain('disabled_at IS NULL AND id > ?');
		expect(queries[0]?.sql).toContain('ORDER BY id ASC');
		expect(queries[0]?.binds).toEqual([5, 25]);
		await listPushTargets(env, -3, 0);
		expect(queries[1]?.binds).toEqual([0, 1]);
	});
});

describe('deliverPush', () => {
	it('POSTs an empty, VAPID-signed push and resets failures on success', async () => {
		const { env, queries } = fakeEnv();
		const fetch = scriptedFetch([new Response(null, { status: 201 })]);
		vi.stubGlobal('fetch', fetch.fn);
		const result = await deliverPush(env, { ...SUB, failures: 2 }, UPDATE_YES);
		expect(result).toEqual({ ok: true, detail: 'HTTP 201' });

		const call = fetch.calls[0];
		expect(call?.url).toBe(SUB.endpoint);
		expect(call?.init.method).toBe('POST');
		expect(call?.init.body).toBeUndefined();
		const headers = call?.init.headers as Record<string, string>;
		expect(headers.TTL).toBe('86400');
		expect(headers.Urgency).toBe('high');
		expect(headers['Content-Length']).toBe('0');
		const match = /^vapid t=(\S+), k=(\S+)$/.exec(headers.Authorization ?? '');
		expect(match).not.toBeNull();
		const claims = await verifyVapidJwt(match?.[1] ?? '', match?.[2] ?? '');
		expect(claims?.aud).toBe('https://fcm.googleapis.com');

		expect(queries.at(-1)?.sql).toContain('SET failures = 0');
	});

	it('disables gone subscriptions', async () => {
		for (const status of [404, 410]) {
			const { env, queries } = fakeEnv();
			vi.stubGlobal('fetch', scriptedFetch([new Response('gone', { status })]).fn);
			const result = await deliverPush(env, SUB, UPDATE_YES);
			expect(result.ok).toBe(false);
			expect(result.gone).toBe(true);
			expect(queries.at(-1)?.sql).toContain('disabled_at = COALESCE(disabled_at, ?)');
		}
	});

	it('retries 429/5xx once, then succeeds', async () => {
		const { env } = fakeEnv();
		const fetch = scriptedFetch([
			new Response('busy', { status: 503, headers: { 'Retry-After': '0' } }),
			new Response(null, { status: 201 }),
		]);
		vi.stubGlobal('fetch', fetch.fn);
		const result = await deliverPush(env, SUB, UPDATE_YES);
		expect(result.ok).toBe(true);
		expect(fetch.calls).toHaveLength(2);
	});

	it('retries once, then counts a failure', async () => {
		const { env, queries } = fakeEnv({}, (q) => (q.sql.includes('RETURNING failures') ? { failures: 2 } : null));
		const fetch = scriptedFetch([new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })]);
		vi.stubGlobal('fetch', fetch.fn);
		const result = await deliverPush(env, SUB, UPDATE_YES);
		expect(fetch.calls).toHaveLength(2);
		expect(result).toEqual({ ok: false, detail: `HTTP 429: slow down (failure 2 of ${MAX_PUSH_FAILURES})` });
		const failure = queries.find((q) => q.sql.includes('failures + 1'));
		expect(failure?.binds).toEqual([MAX_PUSH_FAILURES, expect.any(String), SUB.id]);
	});

	it('does not retry other 4xx, and reports the disabling failure', async () => {
		const { env } = fakeEnv({}, () => ({ failures: MAX_PUSH_FAILURES }));
		const fetch = scriptedFetch([new Response('bad jwt', { status: 403 })]);
		vi.stubGlobal('fetch', fetch.fn);
		const result = await deliverPush(env, SUB, UPDATE_YES);
		expect(fetch.calls).toHaveLength(1);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('disabled after 5 in a row');
	});

	it('never throws, even when the network does', async () => {
		const { env } = fakeEnv({}, () => ({ failures: 1 }));
		vi.stubGlobal('fetch', scriptedFetch([new Response(null, { status: 503, headers: { 'Retry-After': '0' } }), new TypeError('offline')]).fn);
		const result = await deliverPush(env, SUB, UPDATE_YES);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('offline');

		const insecure = await deliverPush(fakeEnv().env, { ...SUB, endpoint: 'http://push.example.com/x' }, UPDATE_YES);
		expect(insecure).toMatchObject({ ok: false, gone: true });
	});

	it('disables, without contacting, endpoints that are not real push services', async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 201 }));
		vi.stubGlobal('fetch', fetch);
		const result = await deliverPush(fakeEnv().env, { ...SUB, endpoint: 'https://example.com/collect?id=1' }, UPDATE_YES);
		expect(result).toMatchObject({ ok: false, gone: true });
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('deliverPushBatch', () => {
	const subs: PushSubscriptionRow[] = [
		{ ...SUB, id: 1, endpoint: 'https://fcm.googleapis.com/fcm/send/one', failures: 0 },
		{ ...SUB, id: 2, endpoint: 'https://fcm.googleapis.com/fcm/send/two', failures: 3 },
		{ ...SUB, id: 3, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/three', failures: 0 },
		{ ...SUB, id: 4, endpoint: 'https://web.push.apple.com/gone', failures: 0 },
		{ ...SUB, id: 5, endpoint: 'https://web.push.apple.com/broken', failures: 1 },
		{ ...SUB, id: 6, endpoint: 'https://example.com/not-a-push-service', failures: 0 },
	];

	it('pushes the batch, then keeps all the books in one D1 round trip', async () => {
		const { env, queries, counts } = fakeEnv({}, (q) => (q.sql.includes('RETURNING failures') ? { failures: 2 } : null));
		const fetch = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.endsWith('/gone')) return new Response('gone', { status: 410 });
			if (href.endsWith('/broken')) return new Response('bad', { status: 400 });
			return new Response(null, { status: 201 });
		});
		vi.stubGlobal('fetch', fetch);
		const results = await deliverPushBatch(env, subs);

		expect(results.map((r) => [r.ok, r.gone ?? false])).toEqual([
			[true, false],
			[true, false],
			[true, false],
			[false, true],
			[false, false],
			[false, true],
		]);
		expect(results[4]?.detail).toBe(`HTTP 400: bad (failure 2 of ${MAX_PUSH_FAILURES})`);
		expect(fetch).toHaveBeenCalledTimes(5); // the non-push-service endpoint is never contacted
		expect(counts.batches).toBe(1);
		expect(queries.every((q) => q.method === 'batch')).toBe(true);
		// Only the subscription that had failures gets the reset; the healthy ones cost nothing.
		const resets = queries.filter((q) => q.sql.includes('SET failures = 0'));
		expect(resets.map((q) => q.binds)).toEqual([[2]]);
		expect(queries.filter((q) => q.sql.includes('disabled_at = COALESCE')).map((q) => q.binds[1])).toEqual([4, 6]);
		expect(queries.filter((q) => q.sql.includes('failures + 1')).map((q) => q.binds[2])).toEqual([5]);
	});

	it('signs one VAPID JWT per push service, not one per push', async () => {
		const { env } = fakeEnv();
		const fetch = scriptedFetch([new Response(null, { status: 201 })]);
		vi.stubGlobal('fetch', fetch.fn);
		await deliverPushBatch(env, subs.slice(0, 3));
		// Concurrent pushes reach fetch in any order, so look them up by endpoint.
		const auth = new Map(fetch.calls.map((c) => [c.url, (c.init.headers as Record<string, string>).Authorization]));
		const [fcm1, fcm2, mozilla] = subs.slice(0, 3).map((s) => auth.get(s.endpoint));
		expect(fcm1).toBe(fcm2);
		expect(mozilla).not.toBe(fcm1); // Mozilla has its own audience
		const match = /^vapid t=(\S+), k=(\S+)$/.exec(mozilla ?? '');
		expect((await verifyVapidJwt(match?.[1] ?? '', match?.[2] ?? ''))?.aud).toBe('https://updates.push.services.mozilla.com');
	});

	it('writes nothing at all when every push lands on a healthy subscription', async () => {
		const { env, queries, counts } = fakeEnv();
		vi.stubGlobal('fetch', scriptedFetch([new Response(null, { status: 201 })]).fn);
		const results = await deliverPushBatch(env, [subs[0] as PushSubscriptionRow, subs[2] as PushSubscriptionRow]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(queries).toHaveLength(0);
		expect(counts.batches).toBe(0);
	});

	it('still reports every result when the bookkeeping write fails', async () => {
		const { env } = fakeEnv();
		(env.DB as unknown as { batch: () => Promise<never> }).batch = async () => {
			throw new Error('D1 down');
		};
		vi.stubGlobal('fetch', scriptedFetch([new Response('nope', { status: 400 })]).fn);
		const [result] = await deliverPushBatch(env, [subs[1] as PushSubscriptionRow]);
		expect(result).toEqual({ ok: false, detail: 'HTTP 400: nope' });
	});

	it('keeps to six pushes in flight (the per-invocation connection limit)', async () => {
		const { env } = fakeEnv();
		let inFlight = 0;
		let peak = 0;
		vi.stubGlobal('fetch', async () => {
			peak = Math.max(peak, ++inFlight);
			await new Promise((r) => setTimeout(r, 2));
			inFlight--;
			return new Response(null, { status: 201 });
		});
		const many = Array.from({ length: 10 }, (_, i) => ({ ...SUB, id: i + 1, endpoint: `https://fcm.googleapis.com/fcm/send/${i}` }));
		expect((await deliverPushBatch(env, many)).every((r) => r.ok)).toBe(true);
		expect(peak).toBeLessThanOrEqual(6);
	});
});

describe('parsePushSubscription', () => {
	const p256dh = base64UrlEncode(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i)));
	const auth = base64UrlEncode(Uint8Array.from({ length: 16 }, (_, i) => i));
	const valid = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/gAAAA', expirationTime: null, keys: { p256dh, auth } };

	it('accepts a browser PushSubscription', () => {
		expect(parsePushSubscription(valid)).toEqual({ ok: true, value: { endpoint: valid.endpoint, p256dh, auth } });
		const padded = parsePushSubscription({ ...valid, keys: { p256dh: `${p256dh}=`, auth: `${auth}==` } });
		expect(padded.ok && padded.value.auth).toBe(auth);
	});

	it.each([
		['not an object', 'nope'],
		['http endpoint', { ...valid, endpoint: 'http://push.example.com/x' }],
		['IP endpoint', { ...valid, endpoint: 'https://10.0.0.1/x' }],
		['missing keys', { endpoint: valid.endpoint }],
		['short p256dh', { ...valid, keys: { p256dh: auth, auth } }],
		['compressed p256dh', { ...valid, keys: { p256dh: base64UrlEncode(new Uint8Array(33).fill(2)), auth } }],
		['long auth', { ...valid, keys: { p256dh, auth: p256dh } }],
		['own site', { ...valid, endpoint: 'https://iszacka.dad/api/push/subscribe' }],
		['a server that is not a push service', { ...valid, endpoint: 'https://example.com/x' }],
		['a look-alike host', { ...valid, endpoint: 'https://evilpush.apple.com.attacker.example/x' }],
		['a bare suffix', { ...valid, endpoint: 'https://notify.windows.com/x' }],
	])('rejects %s', (_label, input) => {
		expect(parsePushSubscription(input, ['iszacka.dad']).ok).toBe(false);
	});

	it.each([
		'https://fcm.googleapis.com/fcm/send/abc:def',
		'https://android.googleapis.com/gcm/send/abc',
		'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
		'https://push.services.mozilla.com.example/x',
		'https://web.push.apple.com/QOd0',
		'https://api.push.apple.com/x',
		'https://wns2-par02p.notify.windows.com/w/?token=abc',
	])('accepts or rejects %s by its host', (endpoint) => {
		const host = new URL(endpoint).hostname;
		expect(parsePushSubscription({ ...valid, endpoint }).ok).toBe(isPushServiceHost(host));
	});

	it('knows the real push services and nothing else', () => {
		for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'x.notify.windows.com', 'FCM.googleapis.com.']) {
			expect(isPushServiceHost(host)).toBe(true);
		}
		for (const host of ['example.com', 'push.services.mozilla.com.example', 'evilpush.apple.com.attacker.example', 'notify.windows.com', 'googleapis.com']) {
			expect(isPushServiceHost(host)).toBe(false);
		}
	});
});

describe('endpointFrom', () => {
	it('normalises the endpoint the same way subscribe stores it', () => {
		expect(endpointFrom({ endpoint: ' https://FCM.googleapis.com:443/fcm/send/abc ' })).toBe('https://fcm.googleapis.com/fcm/send/abc');
		expect(endpointFrom({ endpoint: 'nope' })).toBeNull();
		expect(endpointFrom({ endpoint: `https://x.example/${'a'.repeat(2048)}` })).toBeNull();
		expect(endpointFrom({})).toBeNull();
		expect(endpointFrom(null)).toBeNull();
	});
});
