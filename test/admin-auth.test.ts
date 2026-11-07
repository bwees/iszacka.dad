import { describe, expect, it, vi } from 'vitest';

// Keep the test hermetic: the page shell and D1-backed settings belong to other modules
// and aren't needed for the pure auth logic under test.
vi.mock('../src/lib/layout', () => ({ renderPage: vi.fn() }));
vi.mock('../src/lib/state', () => ({
	getOrCreateSetting: vi.fn(),
	setSetting: vi.fn(),
	getSetting: vi.fn(),
}));

import { Hono } from 'hono';
import {
	CONFIRM_WORDS,
	SESSION_TTL_SECONDS,
	adminCookieName,
	adminFlash,
	adminFlashCookieName,
	flashRedirect,
	adminEnabled,
	clampFlash,
	confirmMatches,
	confirmWordFor,
	formatDuration,
	isSameOriginRequest,
	normaliseConfirmWord,
	passwordMatches,
	safeNextPath,
	sessionExpiry,
	signSession,
	verifySession,
} from '../src/lib/admin';
import { base64UrlDecode, base64UrlEncode } from '../src/lib/security';
import { STATUSES } from '../src/types';

const secret = { password: 'correct horse battery staple', salt: 'test-salt-0001' };
const NOW = 1_800_000_000; // a fixed "now" in Unix seconds

describe('session cookies: sign and verify', () => {
	it('produces "<exp>.<sig>" with a 32-byte base64url HMAC', async () => {
		const exp = NOW + SESSION_TTL_SECONDS;
		const value = await signSession(secret, exp);
		expect(value).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
		expect(value.split('.')[0]).toBe(String(exp));
		expect(base64UrlDecode(value.split('.')[1] as string)).toHaveLength(32);
		expect(sessionExpiry(value)).toBe(exp);
	});

	it('verifies a freshly signed session', async () => {
		const value = await signSession(secret, NOW + SESSION_TTL_SECONDS);
		await expect(verifySession(secret, value, NOW)).resolves.toBe(true);
	});

	it('is deterministic for the same secret and expiry', async () => {
		const exp = NOW + 60;
		expect(await signSession(secret, exp)).toBe(await signSession(secret, exp));
	});

	it('lasts 30 days', () => {
		expect(SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
	});

	it('rejects missing and malformed values', async () => {
		for (const bad of [undefined, null, '', 'nope', '123', '123.', '.abc', 'abc.def', '-5.xyz', `${NOW + 60}.${'A'.repeat(42)}`]) {
			await expect(verifySession(secret, bad, NOW)).resolves.toBe(false);
		}
	});

	it('rejects an empty password outright', async () => {
		const value = await signSession(secret, NOW + 60);
		await expect(verifySession({ ...secret, password: '' }, value, NOW)).resolves.toBe(false);
	});

	it('refuses to sign nonsense expiries', async () => {
		await expect(signSession(secret, 0)).rejects.toThrow();
		await expect(signSession(secret, 1.5)).rejects.toThrow();
		await expect(signSession(secret, Number.NaN)).rejects.toThrow();
	});
});

describe('session cookies: expiry', () => {
	it('rejects an expired session', async () => {
		const value = await signSession(secret, NOW - 1);
		await expect(verifySession(secret, value, NOW)).resolves.toBe(false);
	});

	it('rejects a session at exactly its expiry second', async () => {
		const value = await signSession(secret, NOW);
		await expect(verifySession(secret, value, NOW)).resolves.toBe(false);
	});

	it('accepts a session one second before expiry', async () => {
		const value = await signSession(secret, NOW + 1);
		await expect(verifySession(secret, value, NOW)).resolves.toBe(true);
	});

	it('expires 30 days after login', async () => {
		const loginAt = NOW;
		const value = await signSession(secret, loginAt + SESSION_TTL_SECONDS);
		await expect(verifySession(secret, value, loginAt + SESSION_TTL_SECONDS - 1)).resolves.toBe(true);
		await expect(verifySession(secret, value, loginAt + SESSION_TTL_SECONDS)).resolves.toBe(false);
	});

	it('rejects validly signed sessions that claim to last far longer than 30 days', async () => {
		const value = await signSession(secret, NOW + SESSION_TTL_SECONDS * 10);
		await expect(verifySession(secret, value, NOW)).resolves.toBe(false);
	});
});

describe('session cookies: tampering', () => {
	it('rejects a different expiry glued onto a valid signature', async () => {
		const value = await signSession(secret, NOW + 60);
		const sig = value.split('.')[1];
		await expect(verifySession(secret, `${NOW + 61}.${sig}`, NOW)).resolves.toBe(false);
		await expect(verifySession(secret, `${NOW + SESSION_TTL_SECONDS}.${sig}`, NOW)).resolves.toBe(false);
	});

	it('rejects a flipped signature bit', async () => {
		const value = await signSession(secret, NOW + 60);
		const [exp, sig] = value.split('.') as [string, string];
		const bytes = base64UrlDecode(sig);
		bytes[0] = (bytes[0] as number) ^ 0x01;
		await expect(verifySession(secret, `${exp}.${base64UrlEncode(bytes)}`, NOW)).resolves.toBe(false);
	});

	it('rejects a non-canonical spelling of a valid signature', async () => {
		const value = await signSession(secret, NOW + 60);
		const [exp, sig] = value.split('.') as [string, string];
		// The final base64url character carries 2 padding bits; setting them decodes to the
		// same bytes but must not be accepted as a second valid cookie.
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
		const last = alphabet.indexOf(sig.at(-1) as string);
		const variant = `${sig.slice(0, -1)}${alphabet[last | 0b01]}`;
		if (variant !== sig) await expect(verifySession(secret, `${exp}.${variant}`, NOW)).resolves.toBe(false);
	});

	it('rejects a session signed with another password (password change logs everyone out)', async () => {
		const value = await signSession(secret, NOW + 60);
		await expect(verifySession({ ...secret, password: 'new password' }, value, NOW)).resolves.toBe(false);
	});

	it('rejects a session signed with another salt (log out everywhere)', async () => {
		const value = await signSession(secret, NOW + 60);
		await expect(verifySession({ ...secret, salt: 'rotated-salt' }, value, NOW)).resolves.toBe(false);
	});

	it('rejects a session forged with a plain HMAC of the password (key must be derived)', async () => {
		const exp = NOW + 60;
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret.password),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(exp)));
		await expect(verifySession(secret, `${exp}.${base64UrlEncode(sig)}`, NOW)).resolves.toBe(false);
	});
});

describe('password check', () => {
	it('accepts only the exact password', async () => {
		await expect(passwordMatches('dev', 'dev')).resolves.toBe(true);
		await expect(passwordMatches('dev', 'Dev')).resolves.toBe(false);
		await expect(passwordMatches('dev', 'dev ')).resolves.toBe(false);
		await expect(passwordMatches('dev', '')).resolves.toBe(false);
		await expect(passwordMatches('dev', undefined)).resolves.toBe(false);
		await expect(passwordMatches('dev', 42)).resolves.toBe(false);
	});

	it('never matches when no password is configured', async () => {
		await expect(passwordMatches('', '')).resolves.toBe(false);
		await expect(passwordMatches(undefined, 'anything')).resolves.toBe(false);
		expect(adminEnabled({ ADMIN_PASSWORD: '' })).toBe(false);
		expect(adminEnabled({ ADMIN_PASSWORD: 'dev' })).toBe(true);
	});

	it('rejects absurdly long candidates without hashing them', async () => {
		await expect(passwordMatches('dev', 'x'.repeat(5000))).resolves.toBe(false);
	});
});

describe('confirmation words', () => {
	it('maps yes → DAD, soon → SOON, no → NO', () => {
		expect(CONFIRM_WORDS).toEqual({ yes: 'DAD', soon: 'SOON', no: 'NO' });
		expect(confirmWordFor('yes')).toBe('DAD');
		expect(confirmWordFor('soon')).toBe('SOON');
		expect(confirmWordFor('no')).toBe('NO');
	});

	it('has a distinct word for every status', () => {
		const words = STATUSES.map(confirmWordFor);
		expect(new Set(words).size).toBe(STATUSES.length);
	});

	it('accepts the right word, ignoring case and surrounding whitespace', () => {
		expect(confirmMatches('yes', 'DAD')).toBe(true);
		expect(confirmMatches('yes', ' dad ')).toBe(true);
		expect(confirmMatches('soon', 'Soon')).toBe(true);
		expect(confirmMatches('no', 'no')).toBe(true);
	});

	it('rejects the wrong word for the pressed button', () => {
		expect(confirmMatches('yes', 'YES')).toBe(false);
		expect(confirmMatches('yes', 'SOON')).toBe(false);
		expect(confirmMatches('yes', 'NO')).toBe(false);
		expect(confirmMatches('soon', 'DAD')).toBe(false);
		expect(confirmMatches('no', 'DAD')).toBe(false);
		expect(confirmMatches('no', 'NOPE')).toBe(false);
		expect(confirmMatches('yes', 'DA D')).toBe(false);
	});

	it('rejects empty and non-string input', () => {
		expect(confirmMatches('no', '')).toBe(false);
		expect(confirmMatches('no', '   ')).toBe(false);
		expect(confirmMatches('no', undefined)).toBe(false);
		expect(confirmMatches('no', ['NO'])).toBe(false);
		expect(normaliseConfirmWord(null)).toBe('');
	});
});

describe('CSRF origin check', () => {
	const url = 'https://iszacka.dad/admin/status';

	it('accepts a same-origin Origin header', () => {
		expect(isSameOriginRequest(url, { origin: 'https://iszacka.dad' })).toBe(true);
		expect(isSameOriginRequest(url, { origin: 'https://iszacka.dad', secFetchSite: 'same-origin' })).toBe(true);
	});

	it('falls back to Referer when Origin is absent', () => {
		expect(isSameOriginRequest(url, { referer: 'https://iszacka.dad/admin?ok=1' })).toBe(true);
		expect(isSameOriginRequest(url, { referer: 'https://evil.example/admin' })).toBe(false);
	});

	it('rejects foreign, null, downgraded and missing origins', () => {
		expect(isSameOriginRequest(url, { origin: 'https://evil.example' })).toBe(false);
		expect(isSameOriginRequest(url, { origin: 'https://iszacka.dad.evil.example' })).toBe(false);
		expect(isSameOriginRequest(url, { origin: 'http://iszacka.dad' })).toBe(false);
		expect(isSameOriginRequest(url, { origin: 'null', referer: 'https://iszacka.dad/admin' })).toBe(false);
		expect(isSameOriginRequest(url, {})).toBe(false);
	});

	it('trusts Sec-Fetch-Site when it says cross-site', () => {
		expect(isSameOriginRequest(url, { origin: 'https://iszacka.dad', secFetchSite: 'cross-site' })).toBe(false);
		expect(isSameOriginRequest(url, { origin: 'https://iszacka.dad', secFetchSite: 'same-site' })).toBe(false);
	});
});

describe('cookie name', () => {
	it('uses the __Host- prefix on https and a plain name on http dev', () => {
		expect(adminCookieName('https://iszacka.dad/admin')).toBe('__Host-admin');
		expect(adminCookieName('http://localhost:8787/admin')).toBe('admin');
	});
});

describe('safeNextPath', () => {
	it('keeps same-site admin paths', () => {
		expect(safeNextPath('/admin')).toBe('/admin');
		expect(safeNextPath('/admin/wall')).toBe('/admin/wall');
		expect(safeNextPath('/admin/pool?page=2')).toBe('/admin/pool?page=2');
	});

	it('refuses everything else', () => {
		for (const bad of [
			undefined,
			'',
			'https://evil.example/admin',
			'//evil.example/admin',
			'/\\evil.example',
			'/admin\\..\\x',
			'/',
			'/pool',
			'/administrator',
			'/admin/login',
			'/admin/logout',
			'/admin/../pool',
			'javascript:alert(1)',
			'/admin\n/x',
		]) {
			expect(safeNextPath(bad), String(bad)).toBe('/admin');
		}
	});
});

describe('flash messages', () => {
	it('strips free-text flash parameters from the next path', () => {
		expect(safeNextPath('/admin?err=x&tab=1')).toBe('/admin?tab=1');
		expect(safeNextPath('/admin/wall?ok=Log+in+at+evil.example')).toBe('/admin/wall');
	});

	function app() {
		const a = new Hono();
		a.post('/admin/thing', (c) => flashRedirect(c as never, 'err', 'Could not do the thing.'));
		a.get('/admin', async (c) => c.html(`<main>${String(await adminFlash(c as never))}</main>`));
		return a;
	}

	it('carries the message in a one-shot cookie, never in the URL', async () => {
		const res = await app().request('https://iszacka.dad/admin/thing', { method: 'POST' });
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('/admin');
		const cookie = res.headers.get('set-cookie') ?? '';
		expect(cookie).toContain(`${adminFlashCookieName('https://iszacka.dad/')}=`);
		expect(cookie).toMatch(/HttpOnly/i);
		expect(cookie).toMatch(/SameSite=Strict/i);

		const page = await app().request('https://iszacka.dad/admin', { headers: { cookie: cookie.split(';')[0] ?? '' } });
		const body = await page.text();
		expect(body).toContain('Could not do the thing.');
		expect(page.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
	});

	it('ignores ?ok= and ?err= in the URL', async () => {
		const res = await app().request('https://iszacka.dad/admin?err=Planned%20maintenance&ok=hello');
		const body = await res.text();
		expect(body).not.toContain('Planned maintenance');
		expect(body).not.toContain('hello');
	});
});

describe('formatting helpers', () => {
	it('formats durations with the two most significant units', () => {
		expect(formatDuration(0)).toBe('0 seconds');
		expect(formatDuration(1_000)).toBe('1 second');
		expect(formatDuration(59_000)).toBe('59 seconds');
		expect(formatDuration(60_000)).toBe('1 minute');
		expect(formatDuration(3_660_000)).toBe('1 hour, 1 minute');
		expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000 + 5 * 60_000)).toBe('3 days, 4 hours');
		expect(formatDuration(2 * 86_400_000 + 5 * 60_000)).toBe('2 days');
		expect(formatDuration(-5_000)).toBe('0 seconds');
	});

	it('clamps flash messages', () => {
		expect(clampFlash('  hello\nworld  ')).toBe('hello world');
		expect(clampFlash('x'.repeat(1000))).toHaveLength(300);
	});
});
