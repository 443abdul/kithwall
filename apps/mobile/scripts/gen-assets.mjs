#!/usr/bin/env node
// Renders the native app icons and splash screens from the Kithwall 2 mark (components/shell/Logo.tsx:
// two people as rings, sealed in a rounded tile, in the default "warm" accent), with sharp (already
// installed for Next.js).
//   node apps/mobile/scripts/gen-assets.mjs
// Outputs are committed; rerun only when the logo changes.
//  Android: legacy + round launcher icons, adaptive-icon foreground/monochrome (108dp canvas, glyph inside
//           the 66dp safe zone); the splash icon, the background colour and the notification icon are
//           vector/XML resources written here too.
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

/** @param {{w:number,h?:number,scale?:number,bg?:string|null,fg?:string,shape?:'square'|'rounded'|'circle'}} o */
function svg({ w, h = w, scale = 1, bg = BLUE, fg = '#ffffff', shape = 'square' }) {
  // The glyph lives in a 512 box centred in the canvas, scaled to `scale` of the canvas's short side.
  const side = Math.min(w, h);
  const s = (side / 512) * scale;
  const tx = (w - 512 * s) / 2;
  const ty = (h - 512 * s) / 2;
  const back = !bg ? '' : shape === 'circle' ? `<circle cx="${w / 2}" cy="${h / 2}" r="${side / 2}" fill="${bg}"/>`
    : `<rect width="${w}" height="${h}" ${shape === 'rounded' ? `rx="${side * 0.14}"` : ''} fill="${bg}"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${back}<g transform="translate(${tx} ${ty}) scale(${s})">${glyph(fg)}</g></svg>`);
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

// Splash: Android 12+'s system splash screen (themes in res/values/styles.xml) shows a vector icon on the
// page colour, so no full-screen splash bitmaps are shipped (they were stretched and only used pre-12).
await writeFile(join(res, 'drawable', 'splash_icon.xml'), `<?xml version="1.0" encoding="utf-8"?>
<!-- Splash screen icon: the Kithwall 2 mark (two rings, components/shell/Logo.tsx) in white on an accent
     disc, like the launcher icon. Canvas = the splash icon's 240dp box, of which the system shows the inner
     160dp circle (r = 32 of 96 units). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="240dp" android:height="240dp" android:viewportWidth="96" android:viewportHeight="96">
    <path android:fillColor="#FFB4532A" android:pathData="M16,48a32,32 0,1 1,64 0a32,32 0,1 1,-64 0z"/>
    <group android:translateX="24" android:translateY="24" android:scaleX="1.5" android:scaleY="1.5">
        <path android:strokeColor="#FFFFFFFF" android:strokeWidth="2.4" android:fillColor="#00000000"
            android:pathData="M7,14a5.5,5.5 0,1 1,11 0a5.5,5.5 0,1 1,-11 0z"/>
        <path android:strokeColor="#FFFFFFFF" android:strokeWidth="2.4" android:fillColor="#00000000"
            android:pathData="M14,18a5.5,5.5 0,1 1,11 0a5.5,5.5 0,1 1,-11 0z"/>
    </group>
</vector>
`);

await writeFile(join(res, 'values', 'ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BLUE}</color>
</resources>
`);
await writeFile(join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive());
await writeFile(join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive());
function adaptive() {
  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
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
