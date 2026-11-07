// OWNER: admin agent.
// Admin auth (password → signed session cookie), CSRF checks, flash messages and the
// admin page shell.
//
// Session cookie value: "<exp>.<sig>"
//   exp  expiry as Unix seconds (30 days after login)
//   sig  base64url HMAC-SHA256 over `${SESSION_CONTEXT}|<exp>`, keyed with HKDF-SHA-256 of
//        ADMIN_PASSWORD salted with a per-deployment random value (settings
//        'admin_session_salt'). Changing ADMIN_PASSWORD changes the key, so every session
//        dies at once. "Log out everywhere" rotates the salt for the same effect.
//
// Cookie: HttpOnly; Secure; SameSite=Strict; Path=/, named `__Host-admin` on https. Local
// `wrangler dev` is plain http, where the __Host- prefix (and Secure) can't work, so there
// it's a plain `admin` cookie without Secure.
//
// CSRF: SameSite=Strict, plus an Origin / Referer / Sec-Fetch-Site check on every unsafe
// request that passes through requireAdmin (and on login / logout).

import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import type { AppEnv, Status } from '../types';
import type { Html } from './layout';
import { renderPage } from './layout';
import { base64UrlDecode, base64UrlEncode, randomToken, sha256Hex, timingSafeEqual, wantsJson } from './security';
import { getOrCreateSetting, setSetting } from './state';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Sessions last 30 days, then you get to type the password again. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Domain separation for the session MAC and its key derivation. */
const SESSION_CONTEXT = 'iszacka.dad/admin-session/v1';

/** Settings key holding the per-deployment session salt (rotated by "log out everywhere"). */
export const SESSION_SALT_SETTING = 'admin_session_salt';

/** Maximum accepted password length (anything longer is not the password, and is slow to hash). */
export const MAX_PASSWORD_LENGTH = 1024;

/** Flash messages are truncated to this many characters (they travel in the URL). */
export const MAX_FLASH_LENGTH = 300;

/**
 * The word you have to type to change the answer. Validated server-side; the admin JS only
 * uses it to arm the matching button.
 */
export const CONFIRM_WORDS: Readonly<Record<Status, string>> = Object.freeze({
	no: 'NO',
	soon: 'SOON',
	yes: 'DAD',
});

/** Admin sub-navigation. `match` decides which entry gets aria-current. */
const ADMIN_NAV: ReadonlyArray<{ href: string; label: string }> = [
	{ href: '/admin', label: 'Dashboard' },
	{ href: '/admin/checklist', label: 'Checklist' },
	{ href: '/admin/wall', label: 'Wall' },
	{ href: '/admin/names', label: 'Names' },
	{ href: '/admin/pool', label: 'Pool' },
];

// ─── Confirmation words ─────────────────────────────────────────────────────

export function confirmWordFor(status: Status): string {
	return CONFIRM_WORDS[status];
}

/** Trim, collapse inner whitespace and upper-case whatever was typed in the confirm box. */
export function normaliseConfirmWord(typed: unknown): string {
	if (typeof typed !== 'string') return '';
	return typed.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** True if `typed` is the confirmation word for `status` (case-insensitive, trimmed). */
export function confirmMatches(status: Status, typed: unknown): boolean {
	const word = normaliseConfirmWord(typed);
	return word.length > 0 && timingSafeEqual(word, CONFIRM_WORDS[status]);
}

// ─── Session tokens (pure: no env, no request) ──────────────────────────────

export interface SessionSecret {
	/** ADMIN_PASSWORD. */
	password: string;
	/** Per-deployment random salt. */
	salt: string;
}

const encoder = new TextEncoder();
let keyCache: { password: string; salt: string; key: Promise<CryptoKey> } | null = null;

/** HKDF-SHA-256(password, salt) → HMAC-SHA-256 key. Cached per isolate for the current secret. */
function sessionKey(secret: SessionSecret): Promise<CryptoKey> {
	if (keyCache && keyCache.password === secret.password && keyCache.salt === secret.salt) return keyCache.key;
	const key = (async () => {
		const ikm = await crypto.subtle.importKey('raw', encoder.encode(secret.password), 'HKDF', false, ['deriveKey']);
		return crypto.subtle.deriveKey(
			{ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(secret.salt), info: encoder.encode(SESSION_CONTEXT) },
			ikm,
			{ name: 'HMAC', hash: 'SHA-256', length: 256 },
			false,
			['sign', 'verify'],
		);
	})();
	keyCache = { password: secret.password, salt: secret.salt, key };
	// Don't cache a failed derivation.
	key.catch(() => {
		if (keyCache?.key === key) keyCache = null;
	});
	return key;
}

function sessionMessage(exp: number): Uint8Array {
	return encoder.encode(`${SESSION_CONTEXT}|${exp}`);
}

export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** Sign a session that expires at `exp` (Unix seconds). Returns the cookie value "<exp>.<sig>". */
export async function signSession(secret: SessionSecret, exp: number): Promise<string> {
	if (!Number.isSafeInteger(exp) || exp <= 0) throw new Error('Session expiry must be a positive integer');
	const sig = await crypto.subtle.sign('HMAC', await sessionKey(secret), sessionMessage(exp));
	return `${exp}.${base64UrlEncode(sig)}`;
}

const SESSION_PATTERN = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/** The expiry (Unix seconds) encoded in a session value, without checking the signature. */
export function sessionExpiry(value: string | undefined | null): number | null {
	const match = value ? SESSION_PATTERN.exec(value) : null;
	if (!match) return null;
	const exp = Number(match[1]);
	return Number.isSafeInteger(exp) ? exp : null;
}

/**
 * Verify a session cookie value: well-formed, not expired, not suspiciously far in the
 * future, and signed with the current key. Constant-time MAC comparison via WebCrypto.
 */
export async function verifySession(
	secret: SessionSecret,
	value: string | undefined | null,
	now: number = nowSeconds(),
): Promise<boolean> {
	if (!value || !secret.password) return false;
	const match = SESSION_PATTERN.exec(value);
	if (!match) return false;
	const exp = Number(match[1]);
	if (!Number.isSafeInteger(exp) || exp <= now || exp > now + SESSION_TTL_SECONDS + 300) return false;
	let sig: Uint8Array;
	try {
		sig = base64UrlDecode(match[2] as string);
	} catch {
		return false;
	}
	// Reject non-canonical encodings so each session has exactly one valid spelling.
	if (sig.length !== 32 || base64UrlEncode(sig) !== match[2]) return false;
	try {
		return await crypto.subtle.verify('HMAC', await sessionKey(secret), sig, sessionMessage(exp));
	} catch {
		return false;
	}
}

/** Constant-time password check (both sides hashed first so the length doesn't leak either). */
export async function passwordMatches(expected: string | undefined, candidate: unknown): Promise<boolean> {
	if (!expected || typeof candidate !== 'string' || candidate.length === 0) return false;
	if (candidate.length > MAX_PASSWORD_LENGTH) return false;
	const [a, b] = await Promise.all([sha256Hex(`admin-password:${candidate}`), sha256Hex(`admin-password:${expected}`)]);
	return timingSafeEqual(a, b);
}

// ─── Request helpers (pure) ─────────────────────────────────────────────────

/** `__Host-admin` on https; plain `admin` on http (local wrangler dev). */
export function adminCookieName(requestUrl: string | URL): string {
	return isHttps(requestUrl) ? '__Host-admin' : 'admin';
}

function isHttps(requestUrl: string | URL): boolean {
	return new URL(requestUrl).protocol === 'https:';
}

export interface OriginHeaders {
	origin?: string | null;
	referer?: string | null;
	secFetchSite?: string | null;
}

function originOf(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
	} catch {
		return null;
	}
}

/**
 * CSRF check for unsafe requests. Passes only when the browser says the request came from
 * this origin: Sec-Fetch-Site (if sent) must be same-origin or none, and Origin (or, failing
 * that, Referer) must match the request URL's origin. No Origin and no Referer: refused.
 */
export function isSameOriginRequest(requestUrl: string | URL, headers: OriginHeaders): boolean {
	const expected = new URL(requestUrl).origin;
	const site = headers.secFetchSite?.trim().toLowerCase();
	if (site && site !== 'same-origin' && site !== 'none') return false;
	const origin = headers.origin?.trim();
	if (origin) return origin !== 'null' && originOf(origin) === expected;
	const referer = headers.referer?.trim();
	if (referer) return originOf(referer) === expected;
	return false;
}

/**
 * Where to go after logging in. Only same-site admin paths are allowed; anything else
 * (absolute URLs, protocol-relative `//evil`, backslashes, control characters) becomes /admin.
 */
export function safeNextPath(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 512) return '/admin';
	if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/admin';
	let url: URL;
	try {
		url = new URL(value, 'https://admin.invalid');
	} catch {
		return '/admin';
	}
	if (url.origin !== 'https://admin.invalid') return '/admin';
	if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return '/admin';
	if (isLoginPath(url.pathname) || url.pathname === '/admin/logout') return '/admin';
	// Old-style free-text flash parameters never survive the trip through login.
	url.searchParams.delete('ok');
	url.searchParams.delete('err');
	return `${url.pathname}${url.search}`;
}

function isLoginPath(pathname: string): boolean {
	return pathname === '/admin/login' || pathname === '/admin/login/';
}

function isUnsafeMethod(method: string): boolean {
	return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/** "3 days, 4 hours", "12 minutes", "41 seconds". The two most significant units. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total} second${total === 1 ? '' : 's'}`;
	const units: Array<[string, number]> = [
		['day', 86_400],
		['hour', 3_600],
		['minute', 60],
	];
	const parts: string[] = [];
	let rest = total;
	for (const [name, size] of units) {
		const n = Math.floor(rest / size);
		rest -= n * size;
		if (n > 0 || parts.length > 0) parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
		if (parts.length === 2) break;
	}
	return parts.filter((p) => !p.startsWith('0 ')).join(', ');
}

/** Trim and cap a flash message for the URL. */
export function clampFlash(message: string): string {
	const clean = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
	return clean.length > MAX_FLASH_LENGTH ? `${clean.slice(0, MAX_FLASH_LENGTH - 1)}…` : clean;
}

// ─── Sessions (env + request) ───────────────────────────────────────────────

/** The current signing secret, or null when admin is disabled (no ADMIN_PASSWORD). */
async function sessionSecret(env: Env): Promise<SessionSecret | null> {
	if (!adminEnabled(env)) return null;
	const salt = await getOrCreateSetting(env, SESSION_SALT_SETTING, () => randomToken(32));
	return { password: env.ADMIN_PASSWORD, salt };
}

/** True when ADMIN_PASSWORD is set. Without it the admin area is switched off entirely. */
export function adminEnabled(env: Pick<Env, 'ADMIN_PASSWORD'>): boolean {
	return typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length > 0;
}

// isAdmin() runs at most once per request, however many routers stack requireAdmin.
const adminCache = new WeakMap<Request, boolean>();

export async function isAdmin(c: Context<AppEnv>): Promise<boolean> {
	const cached = adminCache.get(c.req.raw);
	if (cached !== undefined) return cached;
	let ok = false;
	try {
		const value = getCookie(c, adminCookieName(c.req.url));
		if (value) {
			const secret = await sessionSecret(c.env);
			ok = secret ? await verifySession(secret, value) : false;
		}
	} catch (err) {
		console.error('admin session check failed:', err);
		ok = false;
	}
	adminCache.set(c.req.raw, ok);
	return ok;
}

/** The current session's expiry (Unix seconds), if there is a session cookie at all. */
export function currentSessionExpiry(c: Context<AppEnv>): number | null {
	return sessionExpiry(getCookie(c, adminCookieName(c.req.url)));
}

function cookieOptions(c: Context<AppEnv>, maxAge: number) {
	return {
		path: '/',
		httpOnly: true,
		secure: isHttps(c.req.url),
		sameSite: 'Strict' as const,
		maxAge,
	};
}

/** Log in: set a fresh 30-day session cookie on the response. */
export async function startSession(c: Context<AppEnv>): Promise<void> {
	const secret = await sessionSecret(c.env);
	if (!secret) throw new Error('Admin is disabled');
	const value = await signSession(secret, nowSeconds() + SESSION_TTL_SECONDS);
	setCookie(c, adminCookieName(c.req.url), value, cookieOptions(c, SESSION_TTL_SECONDS));
	adminCache.set(c.req.raw, true);
}

/** Log out this browser: expire the cookie. */
export function endSession(c: Context<AppEnv>): void {
	setCookie(c, adminCookieName(c.req.url), '', cookieOptions(c, 0));
	adminCache.set(c.req.raw, false);
}

/** Log out every browser by rotating the session salt (the password stays the same). */
export async function endAllSessions(env: Env): Promise<void> {
	await setSetting(env, SESSION_SALT_SETTING, randomToken(32));
}

/** CSRF check for the current request (see isSameOriginRequest). */
export function sameOrigin(c: Context<AppEnv>): boolean {
	return isSameOriginRequest(c.req.url, {
		origin: c.req.header('origin'),
		referer: c.req.header('referer'),
		secFetchSite: c.req.header('sec-fetch-site'),
	});
}

/** The response for a request that failed the CSRF check. */
export function crossSiteRefused(c: Context<AppEnv>): Response | Promise<Response> {
	noStore(c);
	if (wantsJson(c)) return c.json({ ok: false, error: 'Cross-site request refused' }, 403);
	return renderPage(c, {
		title: 'Cross-site request refused',
		noindex: true,
		status: 403,
		body: html`<div class="wrap section stack">
			<header class="page-head">
				<p class="kicker">403</p>
				<h1>Nice try.</h1>
				<p class="lede">
					That request didn't come from this site, so it has been politely declined. If you pressed a button in the
					admin panel and still ended up here, reload the page and press it again.
				</p>
			</header>
			<p><a class="btn" href="/admin">Back to the admin panel</a></p>
		</div>`,
	});
}

function noStore(c: Context<AppEnv>): void {
	c.header('Cache-Control', 'no-store');
	c.header('X-Robots-Tag', 'noindex, nofollow');
}

/**
 * Middleware: redirects to /admin/login unless the request has a valid admin session.
 * Always lets /admin/login through (so it can be stacked on `/admin/*`). Unsafe methods
 * must also pass the same-origin check. JSON clients get 401 / 403 instead of redirects.
 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
	const url = new URL(c.req.url);
	if (isLoginPath(url.pathname)) return next();

	if (isUnsafeMethod(c.req.method) && !sameOrigin(c)) return crossSiteRefused(c);

	if (!(await isAdmin(c))) {
		noStore(c);
		if (wantsJson(c)) return c.json({ ok: false, error: 'Admin session required' }, 401);
		const target = c.req.method === 'GET' ? safeNextPath(`${url.pathname}${url.search}`) : '/admin';
		const location = target === '/admin' ? '/admin/login' : `/admin/login?next=${encodeURIComponent(target)}`;
		return c.redirect(location, 303);
	}

	await next();
	try {
		c.res.headers.set('Cache-Control', 'no-store');
		c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
	} catch {
		// Immutable response (e.g. a proxied fetch): copy it so the headers can be set.
		c.res = new Response(c.res.body, c.res);
		c.res.headers.set('Cache-Control', 'no-store');
		c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
	}
};

// ─── Flash messages ─────────────────────────────────────────────────────────

export type FlashKind = 'ok' | 'err';

/** Seconds a flash survives: long enough for the redirect, short enough to be gone after. */
const FLASH_TTL_SECONDS = 60;

/** `__Host-admin-flash` on https; plain `admin-flash` on http (local wrangler dev). */
export function adminFlashCookieName(requestUrl: string | URL): string {
	return `${adminCookieName(requestUrl)}-flash`;
}

/**
 * Redirect (303) to an admin `path` (default /admin), carrying `message` in a short-lived,
 * HttpOnly, SameSite=Strict cookie for adminFlash() to render once. The text is never in the
 * URL, so nobody can link to an admin page with words of their choosing on it. Non-admin
 * paths fall back to /admin.
 */
export function flashRedirect(c: Context<AppEnv>, kind: FlashKind, message: string, path = '/admin'): Response {
	setCookie(c, adminFlashCookieName(c.req.url), `${kind}:${clampFlash(message)}`, cookieOptions(c, FLASH_TTL_SECONDS));
	return c.redirect(safeNextPath(path), 303);
}

/** Render (and clear) the flash cookie as an escaped .notice, or nothing. Never reads the URL. */
export function adminFlash(c: Context<AppEnv>): Html {
	const name = adminFlashCookieName(c.req.url);
	const value = getCookie(c, name);
	if (!value) return html``;
	setCookie(c, name, '', cookieOptions(c, 0));
	const kind = value.startsWith('err:') ? 'err' : value.startsWith('ok:') ? 'ok' : null;
	if (!kind) return html``;
	const message = clampFlash(value.slice(kind.length + 1));
	if (!message) return html``;
	return kind === 'err'
		? html`<div class="notice notice-error" role="alert"><p>${message}</p></div>`
		: html`<div class="notice notice-ok" role="status"><p>${message}</p></div>`;
}

// ─── Page shells ────────────────────────────────────────────────────────────

function adminNav(c: Context<AppEnv>): Html {
	const path = new URL(c.req.url).pathname.replace(/\/+$/, '') || '/';
	const current = (href: string) => (href === '/admin' ? path === '/admin' : path === href || path.startsWith(`${href}/`));
	return html`<nav class="admin-nav cluster" aria-label="Admin">
		<span class="kicker">Admin</span>
		${ADMIN_NAV.map((item) =>
			current(item.href)
				? html`<a class="pill" href="${item.href}" aria-current="page"><strong>${item.label}</strong></a>`
				: html`<a class="pill" href="${item.href}">${item.label}</a>`,
		)}
		<form method="post" action="/admin/logout" style="margin:0;margin-inline-start:auto">
			<button type="submit" class="btn btn-ghost">Log out</button>
		</form>
	</nav>`;
}

/**
 * Admin shell: noindex, no-store page with the admin sub-navigation. `body` is placed
 * inside a `.wrap.stack` container (don't add another .wrap). Loads /admin.js.
 */
export function renderAdminPage(c: Context<AppEnv>, opts: { title: string; body: Html; status?: number }): Promise<Response> {
	noStore(c);
	return renderPage(c, {
		title: `Admin · ${opts.title}`,
		body: html`<div class="wrap stack section admin">${adminNav(c)} ${opts.body}</div>`,
		noindex: true,
		status: opts.status,
		scripts: ['/admin.js'],
		bodyClass: 'admin',
	});
}

/** Shell for the logged-out admin pages (login, disabled): no admin nav. */
export function renderAdminPublicPage(
	c: Context<AppEnv>,
	opts: { title: string; body: Html; status?: number; turnstile?: boolean },
): Promise<Response> {
	noStore(c);
	return renderPage(c, {
		title: `Admin · ${opts.title}`,
		body: html`<div class="wrap stack section admin">${opts.body}</div>`,
		noindex: true,
		status: opts.status,
		turnstile: opts.turnstile,
		scripts: ['/admin.js'],
		bodyClass: 'admin',
	});
}
