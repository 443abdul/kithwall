#!/usr/bin/env node
// Renders the PNG app icons in public/icons/ from one vector "k" (drawn as shapes, so the result
// doesn't depend on installed fonts). Uses sharp, which Next.js already depends on.
//   node apps/web/scripts/gen-icons.mjs
// Outputs are committed; rerun only when the logo changes.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const BLUE = '#3b5998';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// Bold lowercase "k" in a 512 box, centred: stem, arm and leg as polygons.
const glyph = (fill) => `
  <g transform="translate(-42 0)" fill="${fill}">
    <rect x="146" y="84" width="84" height="344"/>
    <polygon points="230,300 338,200 446,200 230,400"/>
    <polygon points="250,330 330,262 452,428 342,428"/>
  </g>`;

/** @param {{size:number, rounded?:boolean, scale?:number, bg?:string|null, fg?:string}} o */
function svg({ size, rounded = false, scale = 1, bg = BLUE, fg = '#ffffff' }) {
  const s = scale;
  const t = 256 - 256 * s;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
    ${bg ? `<rect width="512" height="512" ${rounded ? 'rx="72"' : ''} fill="${bg}"/>` : ''}
    <g transform="translate(${t} ${t}) scale(${s})">${glyph(fg)}</g>
  </svg>`);
}

const jobs = [
  ['icon-192.png', { size: 192, rounded: true }],
  ['icon-512.png', { size: 512, rounded: true }],
  // Maskable: full-bleed background, glyph inside the 80% safe circle.
  ['icon-maskable-192.png', { size: 192, scale: 0.7 }],
  ['icon-maskable-512.png', { size: 512, scale: 0.7 }],
  // iOS rounds the corners itself and dislikes transparency.
  ['apple-touch-icon.png', { size: 180, scale: 0.86 }],
  // Android status-bar badge: monochrome, only the alpha channel is used.
  ['badge-72.png', { size: 72, bg: null, scale: 1.1 }],
];

await mkdir(out, { recursive: true });
for (const [name, o] of jobs) {
  await sharp(svg(o)).png({ compressionLevel: 9 }).toFile(join(out, name));
  console.log('wrote', name);
}
