// Test doubles shared by the push agent's tests: a D1 stand-in that records SQL,
// a settings store for getOrCreateSetting, and a scripted fetch.

import type { SiteState, Update } from '../src/types';

export interface RecordedQuery {
	sql: string;
	binds: unknown[];
	method: 'first' | 'all' | 'run';
}

/** Answers queries with whatever `respond` returns, and keeps a log of them. */
export function fakeDb(respond: (q: RecordedQuery) => unknown = () => null) {
	const queries: RecordedQuery[] = [];
	const db = {
		prepare(sql: string) {
			let binds: unknown[] = [];
			const statement = {
				bind(...args: unknown[]) {
					binds = args;
					return statement;
				},
				async first() {
					const q: RecordedQuery = { sql, binds, method: 'first' };
					queries.push(q);
					return respond(q) ?? null;
				},
				async all() {
					const q: RecordedQuery = { sql, binds, method: 'all' };
					queries.push(q);
					return { results: (respond(q) as unknown[] | null) ?? [] };
				},
				async run() {
					const q: RecordedQuery = { sql, binds, method: 'run' };
					queries.push(q);
					return { success: true, meta: { changes: 1 } };
				},
			};
			return statement;
		},
	};
	return { db, queries };
}

export function fakeEnv(overrides: Record<string, unknown> = {}, respond?: (q: RecordedQuery) => unknown) {
	const { db, queries } = fakeDb(respond);
	const env = {
		DB: db,
		SITE_URL: 'https://iszacka.dad',
		DNS_RECORD_NAME: 'answer.iszacka.dad',
		ZONE_NAME: 'iszacka.dad',
		...overrides,
	} as unknown as Env;
	return { env, queries };
}

export interface FetchCall {
	url: string;
	init: RequestInit;
}

/** A fetch that replays `responses` in order (an Error is thrown instead of returned). */
export function scriptedFetch(responses: Array<Response | Error | (() => Response)>) {
	const calls: FetchCall[] = [];
	let i = 0;
	const fn = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
		calls.push({ url: String(input), init });
		const next = responses[Math.min(i++, responses.length - 1)];
		if (next instanceof Error) throw next;
		if (typeof next === 'function') return next();
		if (!next) throw new Error('no scripted response');
		return next.clone();
	};
	return { fn, calls };
}

export const STATE_NO: SiteState = { status: 'no', statusChangedAt: '2026-11-01T09:00:00.000Z', dueDate: '2026-11-20' };
export const STATE_YES: SiteState = { status: 'yes', statusChangedAt: '2026-11-19T03:14:15.926Z', dueDate: '2026-11-20' };

export const UPDATE_YES: Update = {
	id: 7,
	kind: 'status',
	title: 'Zack is a dad!',
	body: 'Zack is a dad! The baby is here.',
	status: 'yes',
	audience: 'all',
	createdAt: '2026-11-19T03:14:15.926Z',
	notifiedAt: null,
};
