// OWNER: ledger agent.
// Live social preview image: the OG card (lib/og-card.ts) is rendered in a real
// headless Chromium via Browser Rendering, screenshotted at 1200×630 and kept in
// D1 `og_images` under key 'current'. /og.png (routes/ledger.ts) serves it while
// it is fresh and matches the current status, falling back to the static
// public/og/<status>.png otherwise.

import type { Browser } from '@cloudflare/puppeteer';
import { isStatus, type DeliveryResult, type Status } from '../types';
import { getCheckTotal } from './counters';
import { renderOgCardHtml } from './og-card';
import { getState } from './state';
import { londonDate, nowIso } from './time';

export const OG_KEY = 'current';
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
/** A rendered image older than this is considered stale and /og.png falls back to the static one. */
export const OG_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const SET_CONTENT_TIMEOUT_MS = 20_000;
/** D1 caps a single BLOB/row at 2,000,000 bytes; leave headroom for the other columns. */
export const OG_MAX_BYTES = 1_900_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface StoredOgImage {
	png: Uint8Array;
	status: Status;
	createdAt: string;
}

/** D1 hands BLOBs back as number[] (or ArrayBuffer, depending on the API); normalise to bytes. */
export function blobToBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (Array.isArray(value) && value.every((n) => typeof n === 'number')) return Uint8Array.from(value as number[]);
	return null;
}

export function isPng(bytes: Uint8Array): boolean {
	return bytes.byteLength > PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** True if a stored render may be served for `status` at time `now`. */
export function isOgImageUsable(image: Pick<StoredOgImage, 'status' | 'createdAt'>, status: Status, now = Date.now()): boolean {
	if (image.status !== status) return false;
	const created = Date.parse(image.createdAt);
	if (Number.isNaN(created)) return false;
	const age = now - created;
	return age >= -60_000 && age < OG_MAX_AGE_MS;
}

/** The stored 'current' render, if any. */
export async function getStoredOgImage(env: Env): Promise<StoredOgImage | null> {
	const row = await env.DB.prepare('SELECT png, status, created_at FROM og_images WHERE key = ?')
		.bind(OG_KEY)
		.first<{ png: unknown; status: string; created_at: string }>();
	if (!row || !isStatus(row.status)) return null;
	const png = blobToBytes(row.png);
	if (!png || !isPng(png)) return null;
	return { png, status: row.status, createdAt: row.created_at };
}

function errorMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

/** Turn a launch failure into something an admin can act on. */
export function describeLaunchFailure(err: unknown): string {
	const message = errorMessage(err);
	if (/\b429\b|too many|rate.?limit|limit exceeded|quota|time limit|concurren/i.test(message)) {
		return `Browser Rendering quota or rate limit hit; the static image will be used for now (${message})`;
	}
	return `Could not launch a browser: ${message}`;
}

/** Render the current OG card to PNG and store it as og_images 'current'. Never throws. */
export async function renderOgImage(env: Env): Promise<DeliveryResult> {
	if (!env.BROWSER) {
		return { ok: false, detail: 'Browser Rendering is not configured (no BROWSER binding); the static image will be used.' };
	}

	let browser: Browser | null = null;
	try {
		const state = await getState(env, { fresh: true });
		const checks = await getCheckTotal(env).catch((err: unknown) => {
			console.warn('og: check total unavailable, rendering with 0:', err);
			return 0;
		});
		const cardHtml = renderOgCardHtml({ state, checks, today: londonDate() });

		// Loaded lazily so the (large) puppeteer bundle is only evaluated when rendering.
		const { default: puppeteer } = await import('@cloudflare/puppeteer');
		try {
			browser = await puppeteer.launch(env.BROWSER);
		} catch (err) {
			console.error('og: browser launch failed:', err);
			return { ok: false, detail: describeLaunchFailure(err) };
		}

		const page = await browser.newPage();
		await page.setViewport({ width: OG_WIDTH, height: OG_HEIGHT, deviceScaleFactor: 1 });
		await page.setContent(cardHtml, { waitUntil: 'load', timeout: SET_CONTENT_TIMEOUT_MS });
		// Embedded web fonts finish decoding after 'load'; wait for them so the text isn't a fallback face.
		await page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => undefined);
		const shot: Uint8Array = await page.screenshot({
			type: 'png',
			clip: { x: 0, y: 0, width: OG_WIDTH, height: OG_HEIGHT },
		});

		const png = new Uint8Array(shot.byteLength);
		png.set(shot);
		if (!isPng(png)) return { ok: false, detail: 'The browser returned something that is not a PNG.' };
		if (png.byteLength > OG_MAX_BYTES) {
			return {
				ok: false,
				detail: `The rendered PNG is ${png.byteLength.toLocaleString('en-GB')} bytes, too big for D1; the static image will be used.`,
			};
		}

		await env.DB.prepare('INSERT OR REPLACE INTO og_images (key, png, status, created_at) VALUES (?, ?, ?, ?)')
			.bind(OG_KEY, png.buffer, state.status, nowIso())
			.run();
		return {
			ok: true,
			detail: `Rendered a ${OG_WIDTH}×${OG_HEIGHT} PNG (${png.byteLength.toLocaleString('en-GB')} bytes) for status '${state.status}'.`,
		};
	} catch (err) {
		console.error('og: render failed:', err);
		return { ok: false, detail: `OG render failed: ${errorMessage(err)}` };
	} finally {
		if (browser) {
			await browser.close().catch((err: unknown) => console.warn('og: browser close failed:', err));
		}
	}
}
