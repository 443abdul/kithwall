#!/usr/bin/env node
// WCAG 2.2 AA contrast check for every Kithwall 2 style × mode (src/styles/v2/tokens.css).
// Usage: node scripts/check-contrast.mjs   (exits 1 if any pair fails)
//
// Text pairs need 4.5:1 (normal text). Non-text UI pairs (focus ring, input borders, accent as a
// control fill against the page) need 3:1 (WCAG 1.4.11).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../src/styles/v2/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

export const STYLES = ['warm', 'minimal', 'bold'];
export const MODES = ['light', 'dark'];

/** [foreground, background, minimum ratio, what it is] */
export const PAIRS = [
  ['text', 'bg', 4.5, 'body text on page'],
  ['text', 'surface', 4.5, 'body text on cards'],
  ['text', 'surface-2', 4.5, 'body text on raised areas'],
  ['text', 'surface-3', 4.5, 'body text on hover/pressed rows'],
  ['text-muted', 'bg', 4.5, 'secondary text on page'],
  ['text-muted', 'surface', 4.5, 'secondary text on cards'],
  ['text-muted', 'surface-2', 4.5, 'secondary text on raised areas'],
  ['accent-contrast', 'accent', 4.5, 'primary button label'],
  ['accent-contrast', 'accent-hover', 4.5, 'primary button label (hover)'],
  ['accent-text', 'bg', 4.5, 'links on page'],
  ['accent-text', 'surface', 4.5, 'links on cards'],
  ['accent-text', 'accent-soft', 4.5, 'selected item / soft badge text'],
  ['danger', 'surface', 4.5, 'error text on cards'],
  ['danger', 'bg', 4.5, 'error text on page'],
  ['danger', 'danger-soft', 4.5, 'error banner text'],
  ['danger-contrast', 'danger', 4.5, 'destructive button label'],
  ['success', 'surface', 4.5, 'success text on cards'],
  ['success', 'success-soft', 4.5, 'success banner text'],
  ['warning', 'warning-soft', 4.5, 'warning banner text'],
  ['warning', 'surface', 4.5, 'warning text on cards'],
  ['focus', 'bg', 3, 'focus ring vs page'],
  ['focus', 'surface', 3, 'focus ring vs cards'],
  ['border-strong', 'surface', 3, 'input / switch outline'],
  ['border-strong', 'bg', 3, 'input outline on page'],
  ['accent', 'surface', 3, 'accent control (switch on, tab indicator) vs card'],
  ['accent', 'bg', 3, 'accent control vs page'],
];

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]) {
  const f = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function ratio(a, b) {
  const la = luminance(hexToRgb(a)), lb = luminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Collect custom properties from blocks whose selector names this exact style and mode. */
export function paletteFor(style, mode) {
  const out = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (!selectors.includes(`:root[data-style="${style}"][data-mode="${mode}"]`)) continue;
    for (const decl of m[2].split(';')) {
      const d = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(decl);
      if (d) out[d[1].slice(2)] = d[2];
    }
  }
  return out;
}

function main() {
  let failures = 0;
  for (const style of STYLES) {
    for (const mode of MODES) {
      const p = paletteFor(style, mode);
      const rows = [];
      for (const [fg, bg, min, what] of PAIRS) {
        if (!p[fg] || !p[bg] || !hexToRgb(p[fg]) || !hexToRgb(p[bg])) {
          rows.push(`  MISSING  ${fg} on ${bg} (${what})`);
          failures++;
          continue;
        }
        const r = ratio(p[fg], p[bg]);
        const ok = r >= min;
        if (!ok) failures++;
        rows.push(`  ${ok ? 'ok  ' : 'FAIL'}  ${r.toFixed(2).padStart(5)} ≥ ${min}  ${fg} on ${bg}  (${what})`);
      }
      console.log(`${style} / ${mode}`);
      console.log(rows.join('\n'));
    }
  }
  if (failures) {
    console.error(`\n${failures} contrast check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${STYLES.length * MODES.length * PAIRS.length} pairs pass WCAG 2.2 AA.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
