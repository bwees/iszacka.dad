import { describe, expect, it } from 'vitest';
import {
	OVERDUE_RETRY_SECONDS,
	SOON_RETRY_SECONDS,
	buildStatusDocument,
	dadVerdict,
	londonMidnightUtc,
	parseUpdatesQuery,
	publicUpdate,
	statusText,
	tooEarlyJokes,
} from '../src/lib/feeds-api';
import { buildOpenApi } from '../src/lib/feeds-openapi';
import type { SiteState } from '../src/types';
import { validate } from './feeds-schema-helper';

const SITE = 'https://iszacka.dad';
const NO: SiteState = { status: 'no', statusChangedAt: '2026-11-01T09:00:00.000Z', dueDate: '2026-11-20' };

describe('status document', () => {
	it('has every documented field', () => {
		const doc = buildStatusDocument(NO, { checks: 42, today: '2026-11-06', siteUrl: SITE });
		expect(doc).toMatchObject({
			isZackADad: false,
			status: 'no',
			answer: 'NO',
			sentence: 'Zack is not a dad. Yet.',
			statusChangedAt: NO.statusChangedAt,
			dueDate: '2026-11-20',
			daysUntilDue: 14,
			checks: 42,
		});
		expect(doc.links.self).toBe(`${SITE}/api/status`);
		expect(doc.links.mcp).toBe(`${SITE}/mcp`);
	});

	it('goes negative when overdue and null without a due date', () => {
		expect(buildStatusDocument(NO, { checks: 0, today: '2026-11-22', siteUrl: SITE }).daysUntilDue).toBe(-2);
		expect(buildStatusDocument({ ...NO, dueDate: null }, { checks: 0, today: '2026-11-22', siteUrl: SITE }).daysUntilDue).toBeNull();
	});

	it('says yes when yes', () => {
		const doc = buildStatusDocument({ ...NO, status: 'yes' }, { checks: 0, today: '2026-11-22', siteUrl: SITE });
		expect(doc.isZackADad).toBe(true);
		expect(doc.answer).toBe('YES');
	});

	it('matches the OpenAPI schema', () => {
		const openapi = buildOpenApi(SITE);
		for (const status of ['no', 'soon', 'yes'] as const) {
			const doc = buildStatusDocument({ ...NO, status }, { checks: 7, today: '2026-11-06', siteUrl: SITE });
			expect(validate(doc, { $ref: '#/components/schemas/Status' }, openapi)).toEqual([]);
		}
	});

	it('has a one-line text form', () => {
		expect(statusText('no')).toBe('no');
		expect(statusText('soon')).toBe('not yet');
		expect(statusText('yes')).toBe('yes');
	});
});

describe('parseUpdatesQuery', () => {
	it('defaults and accepts valid values', () => {
		expect(parseUpdatesQuery({})).toEqual({ ok: true, limit: 20, before: undefined });
		expect(parseUpdatesQuery({ limit: '5', before: '12' })).toEqual({ ok: true, limit: 5, before: 12 });
		expect(parseUpdatesQuery({ limit: '', before: '' })).toEqual({ ok: true, limit: 20, before: undefined });
		expect(parseUpdatesQuery({ limit: '50' })).toMatchObject({ ok: true, limit: 50 });
	});

	it.each([['0'], ['51'], ['-1'], ['1.5'], ['abc'], ['1e2'], [' 5']])('rejects limit=%s', (limit) => {
		expect(parseUpdatesQuery({ limit }).ok).toBe(false);
	});

	it.each([['0'], ['-3'], ['x'], ['99999999999999999999']])('rejects before=%s', (before) => {
		expect(parseUpdatesQuery({ before }).ok).toBe(false);
	});
});

describe('publicUpdate', () => {
	it('drops delivery internals and adds a URL', () => {
		const out = publicUpdate(
			{ id: 9, kind: 'status', title: 't', body: 'b', status: 'soon', audience: 'all', createdAt: '2026-11-01T00:00:00.000Z', notifiedAt: '2026-11-01T00:01:00.000Z' },
			SITE,
		);
		expect(out).toEqual({ id: 9, kind: 'status', title: 't', body: 'b', status: 'soon', createdAt: '2026-11-01T00:00:00.000Z', url: `${SITE}/updates/9` });
		expect(validate(out, { $ref: '#/components/schemas/Update' }, buildOpenApi(SITE))).toEqual([]);
	});
});

describe('londonMidnightUtc', () => {
	it('handles GMT and BST', () => {
		expect(new Date(londonMidnightUtc('2026-11-20')).toISOString()).toBe('2026-11-20T00:00:00.000Z');
		expect(new Date(londonMidnightUtc('2026-07-01')).toISOString()).toBe('2026-06-30T23:00:00.000Z');
		// The clocks change at 01:00 UTC, after London's midnight on both days.
		expect(new Date(londonMidnightUtc('2026-03-29')).toISOString()).toBe('2026-03-29T00:00:00.000Z');
		expect(new Date(londonMidnightUtc('2026-10-25')).toISOString()).toBe('2026-10-24T23:00:00.000Z');
	});
});

describe('/api/dad', () => {
	const openapi = buildOpenApi(SITE);
	const now = new Date('2026-11-06T12:00:00Z');

	it('is 425 Too Early with Retry-After counting down to the due date', () => {
		const v = dadVerdict(NO, now, () => 0);
		expect(v.httpStatus).toBe(425);
		const expected = (Date.parse('2026-11-20T00:00:00Z') - now.getTime()) / 1000;
		expect(v.headers['Retry-After']).toBe(String(expected));
		expect(v.body).toMatchObject({ error: 'too_early', status: 'no', isZackADad: false, retryAfterSeconds: expected, dueDate: '2026-11-20' });
		expect(v.body.message).toBe(tooEarlyJokes()[0]);
		expect(validate(v.body, { $ref: '#/components/schemas/DadTooEarly' }, openapi)).toEqual([]);
	});

	it('retries hourly once overdue', () => {
		const v = dadVerdict({ ...NO, dueDate: '2026-11-01' }, now);
		expect(v.httpStatus).toBe(425);
		expect(v.headers['Retry-After']).toBe(String(OVERDUE_RETRY_SECONDS));
	});

	it('has no Retry-After without a due date', () => {
		const v = dadVerdict({ ...NO, dueDate: null }, now);
		expect(v.httpStatus).toBe(425);
		expect(v.headers['Retry-After']).toBeUndefined();
		expect(v.body).toMatchObject({ retryAfterSeconds: null, retryAt: null });
	});

	it('is still 425 during labour, any minute now', () => {
		const v = dadVerdict({ ...NO, status: 'soon' }, now);
		expect(v.httpStatus).toBe(425);
		expect(v.headers['Retry-After']).toBe(String(SOON_RETRY_SECONDS));
		expect(v.body.message).toMatch(/any minute now/i);
	});

	it('is 201 Created with Location: / once Zack is a dad', () => {
		const v = dadVerdict({ ...NO, status: 'yes' }, now);
		expect(v.httpStatus).toBe(201);
		expect(v.headers).toEqual({ Location: '/' });
		expect(v.body).toMatchObject({ status: 'yes', isZackADad: true, location: '/' });
		expect(validate(v.body, { $ref: '#/components/schemas/DadCreated' }, openapi)).toEqual([]);
	});

	it('never picks a joke out of range', () => {
		for (const pick of [() => -5, () => 999, () => Number.NaN, () => 2.7]) {
			expect(tooEarlyJokes()).toContain(dadVerdict(NO, now, pick).body.message);
		}
	});
});

describe('OpenAPI document', () => {
	const doc = buildOpenApi(SITE) as {
		openapi: string;
		paths: Record<string, Record<string, { operationId?: string }>>;
	};

	it('is OpenAPI 3.1 and every $ref resolves', () => {
		expect(doc.openapi).toBe('3.1.0');
		const refs = JSON.stringify(doc).match(/"\$ref":"[^"]+"/g) ?? [];
		expect(refs.length).toBeGreaterThan(10);
		for (const ref of refs) {
			const path = ref.slice(8, -1);
			expect(validate(null, { $ref: path }, doc as unknown as Record<string, unknown>).some((p) => p.includes('unresolved')), path).toBe(false);
		}
	});

	it('documents every feeds-owned public endpoint, with unique operation ids', () => {
		for (const path of [
			'/api/status',
			'/api/status.json',
			'/api/status.txt',
			'/api/history',
			'/api/updates',
			'/api/dad',
			'/openapi.json',
			'/mcp',
			'/feed.xml',
			'/rss.xml',
			'/atom.xml',
			'/feed.json',
			'/calendar.ics',
			'/badge.svg',
			'/embed',
			'/embed.js',
			'/llms.txt',
			'/humans.txt',
			'/robots.txt',
			'/sitemap.xml',
			'/.well-known/security.txt',
		]) {
			expect(doc.paths[path], path).toBeDefined();
		}
		const ids = Object.values(doc.paths).flatMap((ops) => Object.values(ops).map((op) => op.operationId));
		expect(new Set(ids).size).toBe(ids.length);
	});
});
