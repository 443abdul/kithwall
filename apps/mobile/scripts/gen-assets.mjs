#!/usr/bin/env node
// Renders the native app icons and splash screens from the Kithwall 2 mark (components/shell/Logo.tsx:
// two people as rings, sealed in a rounded tile, in the default "warm" accent), with sharp (already
// installed for Next.js).
//   node apps/mobile/scripts/gen-assets.mjs
// Outputs are committed; rerun only when the logo changes.
//  Android: legacy + round launcher icons, adaptive-icon foreground/monochrome (108dp canvas, glyph inside
//           the 66dp safe zone); the background colours and the notification icon are vector/XML resources
//           written here too. The same set again for each disguised launcher entry (Calculator, Notes,
//           Weather: KwIcons.java, docs/v2/03-safety.md §13), drawn below as simple original glyphs.
//           There is no splash image: the splash shows the launcher icon of the entry the app was opened
//           from (Android 12+) or the page colour alone (res/values/styles.xml).
//  iOS:     the 1024 px App Store icon (opaque, square: iOS rounds it) and the 2732 px splash images.
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'package.json'));
const sharp = require('sharp');

const BLUE = '#b4532a';   // --accent of the default warm style (styles/v2/tokens.css)
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'android', 'app', 'src', 'main', 'res');
const ios = join(root, 'ios', 'App', 'App', 'Assets.xcassets');

// LogoMark's rings (32-unit box: circles at 12.5,14 and 19.5,18, r 5.5, stroke 2.4) scaled ×16 to 512.
const glyph = (stroke) => `
  <g fill="none" stroke="${stroke}" stroke-width="38.4">
    <circle cx="200" cy="224" r="88"/>
    <circle cx="312" cy="288" r="88"/>
  </g>`;

/** @param {{w:number,h?:number,scale?:number,bg?:string|null,fg?:string,shape?:'square'|'rounded'|'circle',mark?:(fg:string,mono:boolean)=>string,mono?:boolean}} o */
function svg({ w, h = w, scale = 1, bg = BLUE, fg = '#ffffff', shape = 'square', mark = glyph, mono = false }) {
  // The glyph lives in a 512 box centred in the canvas, scaled to `scale` of the canvas's short side.
  const side = Math.min(w, h);
  const s = (side / 512) * scale;
  const tx = (w - 512 * s) / 2;
  const ty = (h - 512 * s) / 2;
  const back = !bg ? '' : shape === 'circle' ? `<circle cx="${w / 2}" cy="${h / 2}" r="${side / 2}" fill="${bg}"/>`
    : `<rect width="${w}" height="${h}" ${shape === 'rounded' ? `rx="${side * 0.14}"` : ''} fill="${bg}"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${back}<g transform="translate(${tx} ${ty}) scale(${s})">${mark(fg, mono)}</g></svg>`);
}

const png = (o, file) => sharp(svg(o)).png({ compressionLevel: 9 }).toFile(file).then(() => console.log('wrote', file.slice(root.length + 1)));

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(DENSITIES)) {
  const dir = join(res, `mipmap-${d}`);
  await mkdir(dir, { recursive: true });
  await png({ w: 48 * k, shape: 'rounded', scale: 0.9 }, join(dir, 'ic_launcher.png'));
  await png({ w: 48 * k, shape: 'circle', scale: 0.8 }, join(dir, 'ic_launcher_round.png'));
  // Adaptive icon layers: 108dp canvas; 66dp safe zone → glyph at ~0.6 of the canvas.
  await png({ w: 108 * k, bg: null, scale: 0.58 }, join(dir, 'ic_launcher_foreground.png'));
  await png({ w: 108 * k, bg: null, scale: 0.58, fg: '#000000' }, join(dir, 'ic_launcher_monochrome.png'));
}

// Disguised launcher entries (KwIcons.java): the same app under another name and icon, for people who need
// to hide that they use Kithwall. Original glyphs in the same 512 box, white on one flat colour; the parts
// drawn in black inside a <mask> are cut out, so they show the background (and stay see-through in the
// adaptive and monochrome layers).
const DISGUISES = {
  // A pocket calculator: body, display and a 3×3 keypad.
  calculator: {
    bg: '#37474f',
    mark: (fg) => `
  <mask id="cut"><rect width="512" height="512" fill="#fff"/>
    <rect x="182" y="134" width="148" height="58" rx="10" fill="#000"/>
    ${[244, 300, 356].map((y) => [196, 256, 316].map((x) => `<circle cx="${x}" cy="${y}" r="17" fill="#000"/>`).join('')).join('')}
  </mask>
  <rect x="148" y="100" width="216" height="312" rx="30" fill="${fg}" mask="url(#cut)"/>`,
  },
  // A sheet of paper with a turned corner and four lines of writing.
  notes: {
    bg: '#f57f17',
    mark: (fg) => `
  <mask id="cut"><rect width="512" height="512" fill="#fff"/>
    ${[204, 252, 300].map((y) => `<rect x="190" y="${y}" width="132" height="18" rx="9" fill="#000"/>`).join('')}
    <rect x="190" y="348" width="78" height="18" rx="9" fill="#000"/>
  </mask>
  <path d="M176 100h108l80 80v204a28 28 0 0 1-28 28H176a28 28 0 0 1-28-28V128a28 28 0 0 1 28-28z" fill="${fg}" mask="url(#cut)"/>`,
  },
  // A sun behind a cloud.
  weather: {
    bg: '#1e88e5',
    mark: (fg, mono) => `
  <mask id="cut"><rect width="512" height="512" fill="#fff"/>
    <circle cx="226" cy="318" r="70" fill="#000"/><circle cx="296" cy="290" r="86" fill="#000"/>
    <circle cx="352" cy="330" r="62" fill="#000"/><rect x="226" y="304" width="126" height="88" fill="#000"/>
  </mask>
  <circle cx="204" cy="204" r="66" fill="${mono ? fg : '#ffd54f'}" mask="url(#cut)"/>
  <g fill="${fg}">
    <circle cx="226" cy="318" r="54"/><circle cx="296" cy="290" r="70"/><circle cx="352" cy="330" r="46"/>
    <rect x="226" y="318" width="126" height="58"/>
  </g>`,
  },
};
for (const [id, { bg, mark }] of Object.entries(DISGUISES)) {
  for (const [d, k] of Object.entries(DENSITIES)) {
    const dir = join(res, `mipmap-${d}`);
    await png({ w: 48 * k, shape: 'rounded', scale: 0.98, bg, mark }, join(dir, `ic_alt_${id}.png`));
    await png({ w: 48 * k, shape: 'circle', scale: 0.86, bg, mark }, join(dir, `ic_alt_${id}_round.png`));
    await png({ w: 108 * k, bg: null, scale: 0.68, mark }, join(dir, `ic_alt_${id}_foreground.png`));
    await png({ w: 108 * k, bg: null, scale: 0.68, fg: '#000000', mark, mono: true }, join(dir, `ic_alt_${id}_monochrome.png`));
  }
  await writeFile(join(res, 'mipmap-anydpi-v26', `ic_alt_${id}.xml`), adaptive(`ic_alt_${id}`));
  await writeFile(join(res, 'mipmap-anydpi-v26', `ic_alt_${id}_round.xml`), adaptive(`ic_alt_${id}`));
}

await writeFile(join(res, 'values', 'ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BLUE}</color>
${Object.entries(DISGUISES).map(([id, { bg }]) => `    <color name="ic_alt_${id}_background">${bg}</color>`).join('\n')}
</resources>
`);
await writeFile(join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive());
await writeFile(join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive());
function adaptive(name = 'ic_launcher') {
  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/${name}_background"/>
    <foreground android:drawable="@mipmap/${name}_foreground"/>
    <monochrome android:drawable="@mipmap/${name}_monochrome"/>
</adaptive-icon>
`;
}

// Status-bar notification icon: white glyph, alpha only (a vector, so one file serves every density).
await writeFile(join(res, 'drawable', 'ic_stat_kithwall.xml'), `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="32" android:viewportHeight="32">
    <path android:strokeColor="#FFFFFFFF" android:strokeWidth="2.6" android:fillColor="#00000000"
        android:pathData="M7,14a5.5,5.5 0,1 1,11 0a5.5,5.5 0,1 1,-11 0z"/>
    <path android:strokeColor="#FFFFFFFF" android:strokeWidth="2.6" android:fillColor="#00000000"
        android:pathData="M14,18a5.5,5.5 0,1 1,11 0a5.5,5.5 0,1 1,-11 0z"/>
</vector>
`);
console.log('wrote android/app/src/main/res/drawable/ic_stat_kithwall.xml');

// iOS
if (existsSync(ios)) {
  await png({ w: 1024, scale: 0.86 }, join(ios, 'AppIcon.appiconset', 'AppIcon-512@2x.png'));
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    await png({ w: 2732, scale: 0.2 }, join(ios, 'Splash.imageset', f));
  }
}
