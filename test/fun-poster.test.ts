import { describe, expect, it, vi } from 'vitest';

// Count QR encodings: the poster's code never changes, so it should be made once per isolate.
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

describe('/poster', () => {
	it('draws the QR code once and reuses it', async () => {
		const first = await (await funRoutes.request('https://iszacka.dad/poster', {}, {} as Env)).text();
		const second = await (await funRoutes.request('https://iszacka.dad/poster', {}, {} as Env)).text();
		expect(qr.made).toBe(1);
		expect(second).toBe(first);
		expect(first).toMatch(/<div class="fun-poster-qr"><svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 (\d+) \1" shape-rendering="crispEdges" role="img" aria-label="QR code linking to https:\/\/iszacka.dad"><title>QR code linking to https:\/\/iszacka.dad<\/title><rect width="\1" height="\1" fill="#fff"\/><path fill="#111" d="M[^"]+"\/><\/svg><\/div>/);
	});
});
