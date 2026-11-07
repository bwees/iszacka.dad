import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerRecordContent, DNS_TTL, sameTxtContent, updateAnswerRecord } from '../src/notify/dns';
import { fakeEnv, scriptedFetch, STATE_NO, STATE_YES } from './push-helpers';

const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
const RECORD = { id: 'rec123', name: 'answer.iszacka.dad', content: '"is-zack-a-dad=no; since=2026-10-01T00:00:00.000Z"', ttl: 60 };

afterEach(() => vi.unstubAllGlobals());

describe('answerRecordContent', () => {
	it('is a quoted TXT value with the answer and when it changed', () => {
		expect(answerRecordContent(STATE_NO)).toBe('"is-zack-a-dad=no; since=2026-11-01T09:00:00.000Z; due=2026-11-20"');
		expect(answerRecordContent(STATE_YES)).toBe('"is-zack-a-dad=yes; since=2026-11-19T03:14:15.926Z"');
		expect(answerRecordContent({ ...STATE_NO, status: 'soon', dueDate: null })).toBe(
			'"is-zack-a-dad=soon; since=2026-11-01T09:00:00.000Z"',
		);
	});

	it('fits in a single TXT string', () => {
		expect(answerRecordContent(STATE_NO).length).toBeLessThan(255);
	});

	it('compares TXT values with or without quotes', () => {
		expect(sameTxtContent('"a=b"', 'a=b')).toBe(true);
		expect(sameTxtContent('"a=b"', '"a=b"')).toBe(true);
		expect(sameTxtContent('"a=b"', '"a=c"')).toBe(false);
	});
});

describe('updateAnswerRecord', () => {
	it('skips without a token or a record name', async () => {
		const fetch = scriptedFetch([new Error('should not be called')]);
		vi.stubGlobal('fetch', fetch.fn);
		expect(await updateAnswerRecord(fakeEnv().env, STATE_NO)).toEqual({ ok: true, detail: 'skipped' });
		expect(await updateAnswerRecord(fakeEnv({ DNS_API_TOKEN: 't', DNS_RECORD_NAME: '' }).env, STATE_NO)).toEqual({
			ok: true,
			detail: 'skipped',
		});
		expect(fetch.calls).toHaveLength(0);
	});

	it('looks up the zone, then creates the record when there is none', async () => {
		const fetch = scriptedFetch([ok([{ id: 'zone1', name: 'iszacka.dad' }]), ok([]), ok({ ...RECORD, id: 'new' })]);
		vi.stubGlobal('fetch', fetch.fn);
		const result = await updateAnswerRecord(fakeEnv({ DNS_API_TOKEN: 'secret' }).env, STATE_YES);
		expect(result.ok).toBe(true);
		expect(result.detail).toContain('created answer.iszacka.dad');

		expect(fetch.calls[0]?.url).toBe('https://api.cloudflare.com/client/v4/zones?name=iszacka.dad&per_page=5');
		expect((fetch.calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
		expect(fetch.calls[1]?.url).toBe(
			'https://api.cloudflare.com/client/v4/zones/zone1/dns_records?type=TXT&name=answer.iszacka.dad&per_page=10',
		);
		expect(fetch.calls[2]?.init.method).toBe('POST');
		expect(fetch.calls[2]?.url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/dns_records');
		expect(JSON.parse(fetch.calls[2]?.init.body as string)).toMatchObject({
			type: 'TXT',
			name: 'answer.iszacka.dad',
			content: answerRecordContent(STATE_YES),
			ttl: DNS_TTL,
		});
		expect(DNS_TTL).toBe(60);
	});

	it('patches the existing record, using DNS_ZONE_ID when set', async () => {
		const fetch = scriptedFetch([ok([RECORD]), ok(RECORD)]);
		vi.stubGlobal('fetch', fetch.fn);
		const result = await updateAnswerRecord(fakeEnv({ DNS_API_TOKEN: 'secret', DNS_ZONE_ID: 'zoneX' }).env, STATE_YES);
		expect(result).toMatchObject({ ok: true });
		expect(fetch.calls).toHaveLength(2);
		expect(fetch.calls[0]?.url).toContain('/zones/zoneX/dns_records?type=TXT');
		expect(fetch.calls[1]?.init.method).toBe('PATCH');
		expect(fetch.calls[1]?.url).toBe('https://api.cloudflare.com/client/v4/zones/zoneX/dns_records/rec123');
		expect(JSON.parse(fetch.calls[1]?.init.body as string)).toMatchObject({ content: answerRecordContent(STATE_YES), ttl: 60 });
	});

	it("doesn't touch a record that already says the right thing", async () => {
		const content = answerRecordContent(STATE_NO);
		const fetch = scriptedFetch([ok([{ ...RECORD, content: content.slice(1, -1) }])]);
		vi.stubGlobal('fetch', fetch.fn);
		const result = await updateAnswerRecord(fakeEnv({ DNS_API_TOKEN: 's', DNS_ZONE_ID: 'z' }).env, STATE_NO);
		expect(result.ok).toBe(true);
		expect(result.detail).toContain('already says');
		expect(fetch.calls).toHaveLength(1);
	});

	it('reports API errors without throwing', async () => {
		vi.stubGlobal(
			'fetch',
			scriptedFetch([Response.json({ success: false, errors: [{ code: 9109, message: 'Invalid access token' }], result: null }, { status: 403 })]).fn,
		);
		const result = await updateAnswerRecord(fakeEnv({ DNS_API_TOKEN: 'bad' }).env, STATE_NO);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('HTTP 403: 9109 Invalid access token');
	});

	it('reports a missing zone, a dead network and non-JSON replies without throwing', async () => {
		vi.stubGlobal('fetch', scriptedFetch([ok([])]).fn);
		expect((await updateAnswerRecord(fakeEnv({ DNS_API_TOKEN: 's' }).env, STATE_NO)).detail).toContain('no zone named iszacka.dad');

		vi.stubGlobal('fetch', scriptedFetch([new TypeError('network down')]).fn);
		const down = await updateAnswerRecord(fakeEnv({ DNS_API_TOKEN: 's', DNS_ZONE_ID: 'z' }).env, STATE_NO);
		expect(down).toMatchObject({ ok: false });
		expect(down.detail).toContain('network down');

		vi.stubGlobal('fetch', scriptedFetch([new Response('<html>bad gateway</html>', { status: 502 })]).fn);
		const html = await updateAnswerRecord(fakeEnv({ DNS_API_TOKEN: 's', DNS_ZONE_ID: 'z' }).env, STATE_NO);
		expect(html).toMatchObject({ ok: false });
		expect(html.detail).toContain('HTTP 502');
	});
});
