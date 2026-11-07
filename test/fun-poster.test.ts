import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Count QR encodings: the poster's code never changes, so the Worker ships it pre-made
// (src/lib/poster-qr.ts, written by scripts/poster-qr.ts) and never encodes one itself.
const qr = vi.hoisted(() => ({ made: 0 }));
vi.mock('qrcode-generator', async (importOriginal) => {
	const real = ((await importOriginal()) as { default: (...args: unknown[]) => { make: () => void } }).default;
	return {
		default: (...args: unknown[]) => {
			const code = real(...args);
			const make = code.make.bind(code);
			code.make = () => {
				qr.made++;
				make();
			};
			return code;
		},
	};
});

const { funRoutes } = await import('../src/routes/fun');
const { POSTER_QR_SVG, POSTER_QR_URL } = await import('../src/lib/poster-qr');
const { DOMAIN } = await import('../src/lib/site');
const { posterQrModule, posterQrSvg } = await import('../scripts/poster-qr');

describe('/poster', () => {
	it('serves the pre-made QR code without encoding one', async () => {
		const first = await (await funRoutes.request('https://iszacka.dad/poster', {}, {} as Env)).text();
		const second = await (await funRoutes.request('https://iszacka.dad/poster', {}, {} as Env)).text();
		expect(qr.made).toBe(0);
		expect(second).toBe(first);
		expect(first).toContain(`<div class="fun-poster-qr">${POSTER_QR_SVG}</div>`);
		expect(first).toMatch(/<div class="fun-poster-qr"><svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 (\d+) \1" shape-rendering="crispEdges" role="img" aria-label="QR code linking to https:\/\/iszacka.dad"><title>QR code linking to https:\/\/iszacka.dad<\/title><rect width="\1" height="\1" fill="#fff"\/><path fill="#111" d="M[^"]+"\/><\/svg><\/div>/);
	});

	it('ships the QR code qrcode-generator makes for the site URL (run node scripts/poster-qr.ts if not)', () => {
		expect(POSTER_QR_URL).toBe(`https://${DOMAIN}`);
		expect(POSTER_QR_SVG).toBe(posterQrSvg(`https://${DOMAIN}`));
		expect(readFileSync(join(__dirname, '..', 'src', 'lib', 'poster-qr.ts'), 'utf8')).toBe(posterQrModule(`https://${DOMAIN}`));
		expect(qr.made).toBeGreaterThan(0);
	});
});
