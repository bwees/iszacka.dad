// Entry point. Owned by the foundation: route modules are mounted here and agents
// don't edit this file (each owns its own router, already mounted below).

import { Hono } from 'hono';
import { LinearRouter } from 'hono/router/linear-router';
import { handleScheduled } from './cron';
import { isTerminalClient, renderAscii } from './lib/ascii';
import { getCheckTotal, recordCheck } from './lib/counters';
import { STATUS_COPY, dnsAnswerName } from './lib/site';
import { getState } from './lib/state';
import { daysBetween, londonDate } from './lib/time';
import { adminRoutes } from './routes/admin';
import { apiRoutes } from './routes/api';
import { communityRoutes } from './routes/community';
import { feedRoutes } from './routes/feeds';
import { funRoutes } from './routes/fun';
import { ledgerRoutes } from './routes/ledger';
import { liveRoutes } from './routes/live';
import { errorHandler, notFoundHandler, pageRoutes } from './routes/pages';
import { pushRoutes } from './routes/push';
import { resendWebhookRoutes } from './routes/resend-webhook';
import { subscribeRoutes } from './routes/subscribe';
import { webhookRoutes } from './routes/webhooks';
import type { AppEnv, SiteState } from './types';

export { WaitingRoom } from './do/waiting-room';
export { AnnounceWorkflow } from './workflows/announce';
export { DailyWorkflow } from './workflows/daily';
export { InboundWorkflow } from './workflows/inbound';

// LinearRouter: no route-table compilation on cold start (most requests here hit a fresh
// isolate on Workers Free, where the whole invocation gets 10 ms of CPU).
const app = new Hono<AppEnv>({ router: new LinearRouter() });

/** Paths that count as "checking whether Zack is a dad". */
const COUNTED_PATHS = new Set(['/', '/api/status', '/api/status.txt', '/api/status.json', '/api/dad']);

/**
 * Routes that use neither the answer nor the headers that carry it, so they skip the state
 * read (a D1 query on every cold isolate, inside Workers Free's 10 ms). Their responses get the
 * security headers but no X-Is-Zack-A-Dad. `c.get('state')` is undefined on these routes.
 * (/api/push/test is not here: it sends the current answer.)
 */
const STATELESS_PATHS = new Set([
	'/api/resend/webhook',
	'/api/push/key',
	'/api/push/subscribe',
	'/api/push/unsubscribe',
	'/robots.txt',
	'/.well-known/security.txt',
]);

/** Whether a request skips the state read: a stateless route, or a WebSocket upgrade (nobody sees a 101's headers). */
function skipsState(pathname: string, upgrade: string | undefined): boolean {
	return STATELESS_PATHS.has(pathname) || (pathname === '/ws' && upgrade?.toLowerCase() === 'websocket');
}

app.use('*', async (c, next) => {
	const url = new URL(c.req.url);
	if (url.hostname.startsWith('www.')) {
		return c.redirect(`https://${url.hostname.slice(4)}${url.pathname}${url.search}`, 301);
	}
	c.set('requestStart', Date.now());
	if (!skipsState(url.pathname, c.req.header('upgrade'))) c.set('state', await getState(c.env));

	await next();
	applyHeaders(c.res.headers, c.get('state') as SiteState | undefined, c.get('requestStart'), url);

	// Only answered checks count: a 429 (or an error) is not someone finding out. recordCheck
	// only fires one RPC at the WaitingRoom, which tallies and writes D1 in batches on its own
	// budget, so a check costs this request next to nothing.
	if (c.req.method === 'GET' && COUNTED_PATHS.has(url.pathname) && c.res.ok) {
		c.executionCtx.waitUntil(recordCheck(c.env, c.req.raw));
	}
});

// `curl iszacka.dad` gets giant ASCII art instead of HTML.
app.get('/', async (c, next) => {
	// `/` varies by client: HTML for browsers, ASCII for terminals. Never let a cache mix them up.
	c.header('Vary', 'User-Agent');
	if (!isTerminalClient(c.req.header('user-agent'))) return next();
	const checks = await getCheckTotal(c.env).catch(() => 0);
	c.header('Cache-Control', 'no-store');
	return c.text(renderAscii(c.get('state'), { checks, dnsName: dnsAnswerName(c.env) }));
});

app.route('/', pageRoutes);
app.route('/', feedRoutes);
app.route('/', apiRoutes);
app.route('/', liveRoutes);
app.route('/', subscribeRoutes);
app.route('/', pushRoutes);
app.route('/', resendWebhookRoutes);
app.route('/', webhookRoutes);
app.route('/', communityRoutes);
app.route('/', funRoutes);
app.route('/', ledgerRoutes);
app.route('/admin', adminRoutes);

app.notFound(notFoundHandler);
app.onError(errorHandler);

/**
 * Headers on every dynamic response. Routes may pre-set any of these to override. Without
 * `state` (routes that skip the state read) the answer's headers are left out.
 */
function applyHeaders(headers: Headers, state: SiteState | undefined, start: number, url: URL): void {
	const setDefault = (name: string, value: string) => {
		if (!headers.has(name)) headers.set(name, value);
	};
	if (state) headers.set('X-Is-Zack-A-Dad', STATUS_COPY[state.status].header);
	setDefault('X-Powered-By', 'Hope, caffeine and Cloudflare Workers');
	if (state?.dueDate) headers.set('X-Days-Until-Due', String(daysBetween(londonDate(), state.dueDate)));

	// Server-Timing: real request time, plus the (estimated) gestation so far in ms.
	const timings = [`app;dur=${Date.now() - start};desc="Thinking about it"`];
	if (state?.dueDate && state.status !== 'yes') {
		const conception = Date.parse(`${state.dueDate}T00:00:00Z`) - 266 * 86_400_000;
		timings.push(`gestation;dur=${Math.max(0, Date.now() - conception)};desc="Gestation so far (est.)"`);
	}
	headers.append('Server-Timing', timings.join(', '));

	setDefault('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
	setDefault('X-Content-Type-Options', 'nosniff');
	setDefault('Referrer-Policy', 'strict-origin-when-cross-origin');
	setDefault('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
	if ((headers.get('Content-Type') ?? '').includes('text/html')) {
		setDefault(
			'Content-Security-Policy',
			[
				"default-src 'self'",
				"script-src 'self' https://challenges.cloudflare.com",
				'frame-src https://challenges.cloudflare.com',
				"style-src 'self' 'unsafe-inline'",
				"img-src 'self' data: blob:",
				"font-src 'self'",
				`connect-src 'self' wss://${url.host}${url.protocol === 'http:' ? ` ws://${url.host}` : ''}`,
				"manifest-src 'self'",
				"worker-src 'self'",
				"media-src 'self' data: blob:",
				"base-uri 'self'",
				"form-action 'self'",
				"frame-ancestors 'self'",
				"object-src 'none'",
			].join('; '),
		);
	}
}

export default {
	fetch: app.fetch,
	scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
