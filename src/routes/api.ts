// OWNER: feeds agent.
// /api docs page, /api/status(.txt|.json), /api/history, /api/updates, /api/dad (425 → 201),
// /openapi.json, and the MCP server at /mcp (mounted from ./mcp).
//
// Every endpoint here gets CORS (`*`, with preflight), a per-IP rate limit on RL_API
// (429 + JSON when exceeded) and explicit caching. The guard is attached path by path
// rather than to `/api/*`, so it never touches other modules' endpoints (/api/stream,
// /api/push/*, /api/ledger...).

import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { getCheckTotal } from '../lib/counters';
import { buildStatusDocument, dadVerdict, parseUpdatesQuery, publicUpdate, statusText } from '../lib/feeds-api';
import { renderApiDocs } from '../lib/feeds-docs';
import { RPC, mcpTransportError } from '../lib/feeds-mcp';
import { buildOpenApi } from '../lib/feeds-openapi';
import { renderPage } from '../lib/layout';
import { allow, clientKey } from '../lib/security';
import { dnsAnswerName, siteUrl } from '../lib/site';
import { getStatusHistory } from '../lib/state';
import { londonDate } from '../lib/time';
import { listUpdates } from '../lib/updates';
import type { AppEnv } from '../types';
import { MCP_PATH, mcpRoutes } from './mcp';

export const apiRoutes = new Hono<AppEnv>();

// ─── CORS + rate limiting ────────────────────────────────────────────────────

const ALLOW_HEADERS = [
	'Accept',
	'Content-Type',
	'If-None-Match',
	'MCP-Protocol-Version',
	'Mcp-Method',
	'Mcp-Name',
	'Mcp-Session-Id',
	'Last-Event-ID',
].join(', ');

const EXPOSE_HEADERS = ['ETag', 'Location', 'Retry-After', 'X-Is-Zack-A-Dad', 'X-Days-Until-Due'].join(', ');

/** Methods each guarded path answers (OPTIONS is implied). */
const GUARDED: Record<string, string> = {
	'/api/status': 'GET, HEAD',
	'/api/status.json': 'GET, HEAD',
	'/api/status.txt': 'GET, HEAD',
	'/api/history': 'GET, HEAD',
	'/api/updates': 'GET, HEAD',
	'/api/dad': 'GET, HEAD, POST',
	'/openapi.json': 'GET, HEAD',
	[MCP_PATH]: 'POST',
};

export function applyCors(headers: Headers): void {
	headers.set('Access-Control-Allow-Origin', '*');
	headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
}

function guard(path: string, methods: string): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (c.req.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': `${methods}, OPTIONS`,
					'Access-Control-Allow-Headers': ALLOW_HEADERS,
					'Access-Control-Max-Age': '86400',
					Allow: `${methods}, OPTIONS`,
					'Cache-Control': 'public, max-age=86400',
				},
			});
		}
		if (!(await allow(c.env.RL_API, `api:${clientKey(c)}`))) {
			const message = 'Too many requests. The answer will not change faster if you ask harder. Try again in a minute.';
			const body =
				path === MCP_PATH
					? mcpTransportError(RPC.RATE_LIMITED, message, false)
					: { error: 'rate_limited', message };
			const res = Response.json(body, { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } });
			applyCors(res.headers);
			return res;
		}
		await next();
		try {
			applyCors(c.res.headers);
		} catch {
			// Immutable headers (e.g. a proxied response): copy it, then decorate the copy.
			c.res = new Response(c.res.body, c.res);
			applyCors(c.res.headers);
		}
	};
}

for (const [path, methods] of Object.entries(GUARDED)) apiRoutes.use(path, guard(path, methods));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, init: { status?: number; cache: string; headers?: Record<string, string> }): Response {
	const status = init.status ?? 200;
	return new Response(`${JSON.stringify(body, null, 2)}\n`, {
		status,
		// Runtimes don't all know RFC 8470's reason phrase; HTTP/1.1 clients deserve it.
		...(status === 425 ? { statusText: 'Too Early' } : {}),
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': init.cache, ...init.headers },
	});
}

function apiError(status: number, error: string, message: string, extra: Record<string, string> = {}): Response {
	return jsonResponse({ error, message }, { status, cache: 'no-store', headers: extra });
}

function methodNotAllowed(methods: string) {
	return () =>
		apiError(405, 'method_not_allowed', `This endpoint only answers ${methods}. It is a yes/no question, after all.`, {
			Allow: `${methods}, OPTIONS`,
		});
}

async function statusDocument(c: Context<AppEnv>) {
	const checks = await getCheckTotal(c.env).catch(() => 0);
	return buildStatusDocument(c.get('state'), { checks, today: londonDate(), siteUrl: siteUrl(c.env) });
}

// ─── Status ──────────────────────────────────────────────────────────────────

const status = async (c: Context<AppEnv>) => jsonResponse(await statusDocument(c), { cache: 'no-store' });
apiRoutes.get('/api/status', status);
apiRoutes.get('/api/status.json', status);

apiRoutes.get('/api/status.txt', (c) => {
	return new Response(`${statusText(c.get('state').status)}\n`, {
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
	});
});

// ─── History & updates ───────────────────────────────────────────────────────

apiRoutes.get('/api/history', async (c) => {
	try {
		const history = await getStatusHistory(c.env);
		return jsonResponse({ current: c.get('state').status, history }, { cache: 'public, max-age=30' });
	} catch (err) {
		console.error('api history failed:', err);
		return apiError(503, 'unavailable', 'History is temporarily unavailable. It will be back; history always is.', { 'Retry-After': '30' });
	}
});

apiRoutes.get('/api/updates', async (c) => {
	const query = parseUpdatesQuery({ limit: c.req.query('limit'), before: c.req.query('before') });
	if (!query.ok) return apiError(400, 'invalid_query', query.error);
	const base = siteUrl(c.env);
	try {
		const rows = await listUpdates(c.env, { limit: query.limit, ...(query.before ? { beforeId: query.before } : {}) });
		const updates = rows.map((u) => publicUpdate(u, base));
		const last = updates.at(-1);
		const nextBefore = updates.length === query.limit && last ? last.id : null;
		const next = nextBefore === null ? null : `${base}/api/updates?limit=${query.limit}&before=${nextBefore}`;
		return jsonResponse({ updates, nextBefore, next }, { cache: 'public, max-age=30' });
	} catch (err) {
		console.error('api updates failed:', err);
		return apiError(503, 'unavailable', 'Updates are temporarily unavailable. Please try again shortly.', { 'Retry-After': '30' });
	}
});

// ─── /api/dad ────────────────────────────────────────────────────────────────

const dad = (c: Context<AppEnv>) => {
	const verdict = dadVerdict(c.get('state'), new Date());
	return jsonResponse(verdict.body, { status: verdict.httpStatus, cache: 'no-store', headers: verdict.headers });
};
apiRoutes.get('/api/dad', dad);
apiRoutes.post('/api/dad', dad);

// ─── OpenAPI ─────────────────────────────────────────────────────────────────

apiRoutes.get('/openapi.json', (c) => jsonResponse(buildOpenApi(siteUrl(c.env)), { cache: 'public, max-age=300' }));

// ─── Unsupported methods on the JSON endpoints (registered after the real handlers) ──

for (const [path, methods] of Object.entries(GUARDED)) {
	if (path !== MCP_PATH) apiRoutes.all(path, methodNotAllowed(methods));
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

apiRoutes.route('/', mcpRoutes);

// ─── Docs page ───────────────────────────────────────────────────────────────

apiRoutes.get('/api', async (c) => {
	const base = siteUrl(c.env);
	const state = c.get('state');
	const [status, rows] = await Promise.all([statusDocument(c), listUpdates(c.env, { limit: 2 }).catch(() => [])]);
	const updates = rows.map((u) => publicUpdate(u, base));
	const last = updates.at(-1);
	const nextBefore = updates.length === 2 && last ? last.id : null;
	return renderPage(c, {
		title: 'API',
		description: 'The Is Zack a Dad? API: status, feeds, badges, embeds, MCP and HTTP 425 Too Early.',
		path: '/api',
		body: renderApiDocs({
			siteUrl: base,
			dnsName: dnsAnswerName(c.env),
			status,
			dad: dadVerdict(state, new Date(), () => 0),
			updates: { updates, nextBefore, next: nextBefore === null ? null : `${base}/api/updates?limit=2&before=${nextBefore}` },
		}),
	});
});
