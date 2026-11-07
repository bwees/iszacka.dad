// Tokens, hashing, Turnstile, rate limiting, request helpers.

import type { Context } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../types';
import { getOrCreateSetting } from './state';

const b64url = (bytes: Uint8Array): string =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
	return b64url(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

export function base64UrlDecode(value: string): Uint8Array {
	const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** URL-safe random token (default 24 bytes → 32 chars). */
export function randomToken(bytes = 24): string {
	return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
	const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	const digest = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (for passwords / tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
	const ea = new TextEncoder().encode(a);
	const eb = new TextEncoder().encode(b);
	let diff = ea.length ^ eb.length;
	for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
	return diff === 0;
}

/**
 * The salt, per database, once read. It is created once and never changes, so each isolate
 * reads it from D1 at most once instead of on every hash (keyed by the D1 binding, so
 * tests with separate databases don't share one).
 */
const saltCache = new WeakMap<object, string>();

/** Salted hash of an IP (or any identifier). Raw IPs are never stored. */
export async function hashIdentifier(env: Env, value: string): Promise<string> {
	let salt = saltCache.get(env.DB);
	if (salt === undefined) {
		salt = await getOrCreateSetting(env, 'ip_salt', () => randomToken(32));
		saltCache.set(env.DB, salt);
	}
	return (await sha256Hex(`${salt}:${value}`)).slice(0, 32);
}

/** The real client IP. Use it for Turnstile's `remoteip`; use clientKey() for limits and caps. */
export function clientIp(c: Context<AppEnv>): string {
	return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
}

/**
 * Who an IP counts as for rate limits and "per person" caps. IPv4 is unchanged. Any IPv6 host
 * controls at least a /64 (phones rotate addresses inside theirs on their own), so IPv6 is
 * reduced to its /64 prefix: `2001:db8:1:2::/64`. IPv4-mapped IPv6 becomes the IPv4 address,
 * zone ids are dropped, and anything that doesn't parse is returned unchanged.
 */
export function rateLimitSubject(ip: string): string {
	const raw = ip.trim();
	if (!raw.includes(':')) return raw;
	const value = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
	const mapped = /^(?:0{0,4}:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
	if (mapped?.[1]) return mapped[1];
	const halves = value.split('::');
	if (halves.length > 2) return raw;
	// An embedded IPv4 tail ("::1.2.3.4") counts as two hextets; only the first four matter.
	const groups = (part: string | undefined) => (part ? part.split(':') : []).flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]));
	const head = groups(halves[0]);
	const tail = halves.length === 2 ? groups(halves[1]) : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return raw;
	const full = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...tail];
	if (!full.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return raw;
	return `${full
		.slice(0, 4)
		.map((g) => g.replace(/^0+(?=.)/, ''))
		.join(':')}::/64`;
}

/** The client's rate-limit subject (see rateLimitSubject): the key for allow() and identifier hashes. */
export function clientKey(c: Context<AppEnv>): string {
	return rateLimitSubject(clientIp(c));
}

/** True if the client asked for JSON (fetch with Accept: application/json). */
export function wantsJson(c: Context<AppEnv>): boolean {
	return (c.req.header('accept') ?? '').includes('application/json');
}

export function isValidEmail(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 254 &&
		/^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/i.test(value)
	);
}

/**
 * Rate-limit check. Returns true if the request is allowed. Fails open if the
 * limiter binding errors (e.g. unsupported in local dev).
 */
export async function allow(limiter: RateLimit | undefined, key: string): Promise<boolean> {
	if (!limiter) return true;
	try {
		const { success } = await limiter.limit({ key });
		return success;
	} catch {
		return true;
	}
}

export function turnstileEnabled(env: Env): boolean {
	return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

/**
 * The Turnstile widget for a form. Renders nothing when Turnstile isn't
 * configured. Pages that use it must pass `turnstile: true` to renderPage so the
 * Turnstile script is loaded. The token arrives as form field `cf-turnstile-response`.
 */
export function turnstileWidget(env: Env) {
	if (!turnstileEnabled(env)) return html``;
	return html`<div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}" data-theme="auto"></div>`;
}

/** Verify a Turnstile token. Returns true when Turnstile isn't configured. */
export async function verifyTurnstile(env: Env, token: unknown, ip?: string): Promise<boolean> {
	if (!turnstileEnabled(env)) return true;
	if (typeof token !== 'string' || !token) return false;
	const body = new FormData();
	body.append('secret', env.TURNSTILE_SECRET_KEY as string);
	body.append('response', token);
	if (ip) body.append('remoteip', ip);
	try {
		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
		const data = (await res.json()) as { success?: boolean };
		return data.success === true;
	} catch (err) {
		console.error('turnstile verify failed:', err);
		return false;
	}
}
