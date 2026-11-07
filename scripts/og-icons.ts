// Renders the PWA / home-screen icons in public/icons/ from inline SVG.
//
//   node scripts/og-icons.ts [workDir]
//
// Needs `rsvg-convert` (librsvg) on PATH. The SVG sources are written to workDir
// (default node_modules/.cache/og-icons) so they can be inspected or re-rendered
// with any other tool. Run it again after changing the artwork below.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repo, 'public', 'icons');
const workDir = resolve(process.argv[2] ?? join(repo, 'node_modules', '.cache', 'og-icons'));

const INK = '#17140f';
const PAPER = '#f1ece1';
const SIGNAL = '#e2491f';

/** The brand mark: an egg with a question mark. `scale` shrinks it for maskable safe zones. */
function iconSvg(opts: { rounded: boolean; scale: number }): string {
	const { rounded, scale } = opts;
	const marks = rounded
		? ''
		: `<g stroke="${PAPER}" stroke-width="6" opacity=".35" fill="none">
<path d="M40 70V40h30M472 70V40h-30M40 442v30h30M472 442v30h-30"/></g>`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="${INK}"/>
${marks}
<g transform="translate(256 262) scale(${scale}) translate(-256 -262)">
<path d="M256 66C168 66 108 212 108 304a148 148 0 0 0 296 0C404 212 344 66 256 66Z" fill="${PAPER}"/>
<path d="M164 262c6-48 26-92 56-120" fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round" opacity=".85"/>
<path d="M204 252c0-34 23-58 52-58s52 22 52 52c0 28-17 41-36 52-13 8-16 16-16 32v6" fill="none" stroke="${SIGNAL}" stroke-width="38" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="256" cy="392" r="23" fill="${SIGNAL}"/>
</g>
</svg>`;
}

const targets: Array<{ file: string; size: number; svg: string }> = [
	{ file: 'icon-192.png', size: 192, svg: iconSvg({ rounded: true, scale: 1 }) },
	{ file: 'icon-512.png', size: 512, svg: iconSvg({ rounded: true, scale: 1 }) },
	// Maskable: full bleed, artwork inside the central 80% safe zone.
	{ file: 'maskable-512.png', size: 512, svg: iconSvg({ rounded: false, scale: 0.78 }) },
	// iOS masks the corners itself and dislikes transparency.
	{ file: 'apple-touch-icon.png', size: 180, svg: iconSvg({ rounded: false, scale: 0.9 }) },
];

mkdirSync(workDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
for (const t of targets) {
	const svgPath = join(workDir, t.file.replace(/\.png$/, '.svg'));
	writeFileSync(svgPath, t.svg);
	execFileSync('rsvg-convert', ['-w', String(t.size), '-h', String(t.size), '-b', t.file === 'icon-192.png' || t.file === 'icon-512.png' ? 'none' : INK, svgPath, '-o', join(outDir, t.file)], {
		stdio: 'inherit',
	});
	console.log(`wrote public/icons/${t.file} (${t.size}×${t.size})`);
}
