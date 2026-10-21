#!/usr/bin/env node
// Renders the website / PWA icons from the Kithwall 2 mark (components/shell/Logo.tsx: two people as
// rings, sealed in a rounded tile, in the default "warm" accent), drawn as shapes so the result doesn't
// depend on installed fonts. Uses sharp, which Next.js already depends on. The native app icons come
// from apps/mobile/scripts/gen-assets.mjs, which uses the same geometry.
//   node apps/web/scripts/gen-icons.mjs
// Writes public/icons/*.png, public/icon.svg, public/icon-maskable.svg and src/app/favicon.ico.
// Outputs are committed; rerun only when the logo changes.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ACCENT = '#b4532a';   // --accent of the default warm style (styles/v2/tokens.css)
const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(web, 'public', 'icons');

// LogoMark's rings (32-unit box: circles at 12.5,14 and 19.5,18, r 5.5, stroke 2.4) scaled ×16 to 512.
const rings = (stroke) => `<g fill="none" stroke="${stroke}" stroke-width="38.4">
    <circle cx="200" cy="224" r="88"/>
    <circle cx="312" cy="288" r="88"/>
  </g>`;

/**
 * @param {{ scale?: number, bg?: string|null, fg?: string, shape?: 'tile'|'square' }} o
 *  tile: the logo's rounded tile (rx 10/32) on a transparent canvas; square: full-bleed background.
 */
function svgText({ scale = 1, bg = ACCENT, fg = '#ffffff', shape = 'tile' }, size = 512) {
  const t = 256 - 256 * scale;
  const back = !bg ? '' : shape === 'tile' ? `<rect width="512" height="512" rx="160" fill="${bg}"/>` : `<rect width="512" height="512" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <title>Kithwall</title>
  ${back}
  <g transform="translate(${t} ${t}) scale(${scale})">${rings(fg)}</g>
</svg>
`;
}

const jobs = [
  ['icon-192.png', 192, { shape: 'tile' }],
  ['icon-512.png', 512, { shape: 'tile' }],
  // Maskable: full-bleed background, mark inside the 80% safe circle.
  ['icon-maskable-192.png', 192, { shape: 'square', scale: 0.78 }],
  ['icon-maskable-512.png', 512, { shape: 'square', scale: 0.78 }],
  // iOS rounds the corners itself and dislikes transparency.
  ['apple-touch-icon.png', 180, { shape: 'square', scale: 0.86 }],
  // Android status-bar badge: monochrome, only the alpha channel is used.
  ['badge-72.png', 72, { bg: null, scale: 1.25 }],
];

await mkdir(out, { recursive: true });
for (const [name, size, o] of jobs) {
  await sharp(Buffer.from(svgText(o, size))).png({ compressionLevel: 9 }).toFile(join(out, name));
  console.log('wrote public/icons/' + name);
}

// Vector icons (favicon for modern browsers, manifest "any" size).
await writeFile(join(web, 'public', 'icon.svg'), svgText({ shape: 'tile' }));
await writeFile(join(web, 'public', 'icon-maskable.svg'), svgText({ shape: 'square', scale: 0.78 }));
console.log('wrote public/icon.svg, public/icon-maskable.svg');

// favicon.ico for old browsers and tools that ask for /favicon.ico: PNG images in an ICO container.
const sizes = [16, 32, 48];
const pngs = await Promise.all(sizes.map((s) => sharp(Buffer.from(svgText({ shape: 'tile' }, s))).png({ compressionLevel: 9 }).toBuffer()));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s, 0); e.writeUInt8(s, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
await writeFile(join(web, 'src', 'app', 'favicon.ico'), Buffer.concat([header, ...dir, ...pngs]));
console.log('wrote src/app/favicon.ico');
