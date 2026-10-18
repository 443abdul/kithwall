// Generates src/styles/mobile-dark.css: dark-mode overrides for the phone UI, derived from the 2010
// design system (app/kw2010.css) and the feature stylesheets (src/styles/*.css).
// Every light neutral colour is mapped onto the mobile theme variables (styles/mobile.css), so
// screens that were never hand-styled for phones still look right in dark mode.
// Re-run after changing any stylesheet:  node scripts/gen-dark.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const sources = [join(root, 'app', 'kw2010.css'),
  ...readdirSync(join(root, 'styles')).filter((f) => f.endsWith('.css') && !f.startsWith('mobile')).map((f) => join(root, 'styles', f))];

const PREFIX = ':where(html[data-theme="dark"]) body:has(.m-top)';
const SKIP_SELECTOR = /\.farm\b|\.plots?\b|\.fstat\b|\.xpbar\b|\.seeds?\b|#sblue|\.lform|\.sform|\.sbody|\.sin\b|\.sl\b|\.sr\b|\.sbot|::-webkit|@/;

// ---- colour helpers -------------------------------------------------------------
function hexToRgb(h) {
  let x = h.slice(1);
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  if (x.length !== 6) return null;
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const sat = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;

/** Map one colour, given what it's used for. Saturated brand/status colours are kept. */
function mapColor(rgb, use) {
  const L = lum(rgb), S = sat(rgb);
  if (use === 'text') {
    // The 2010 link/brand blues are too dark on a dark background: use the lighter link colour.
    if (S > 0.2 && rgb[2] > rgb[0] && rgb[2] >= rgb[1] && L < 0.5) return 'var(--m-link)';
    if (S > 0.3) return null;                       // reds, greens, oranges: keep
    if (L < 0.35) return 'var(--m-text)';
    if (L < 0.75) return 'var(--m-sub)';
    return null;                                    // already light text (e.g. on buttons)
  }
  if (use === 'surface') {
    if (rgb[0] > 250 && rgb[1] > 240 && rgb[2] > 200 && rgb[2] < 235) return '#3a3520'; // yellow notes
    if (rgb[0] > 250 && rgb[1] < 240 && rgb[2] < 240 && L > 0.85) return '#4a2622';     // error pink
    if (S > 0.12 && L < 0.85) return null;           // coloured surfaces (buttons, badges): keep
    if (L > 0.97) return 'var(--m-card)';
    if (L > 0.86) return S > 0.04 ? 'var(--m-blue-soft)' : 'var(--m-chip)';
    if (L > 0.7) return 'var(--m-chip)';
    return null;
  }
  // lines
  if (S > 0.3) return null;
  if (L > 0.55) return 'var(--m-line)';
  return null;
}

const COLOR_RE = /#[0-9a-fA-F]{3,6}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/g;
function toRgb(tok) {
  if (tok.startsWith('#')) return hexToRgb(tok);
  const m = tok.match(/\d+(\.\d+)?/g).map(Number);
  if (m.length === 4 && m[3] < 0.5) return null;   // translucent overlays: leave alone
  return m.slice(0, 3);
}
function useOf(prop) {
  if (prop === 'color' || prop === 'fill' || prop === '-webkit-text-fill-color') return 'text';
  if (prop.startsWith('background')) return 'surface';
  if (prop.startsWith('border') || prop.startsWith('outline') || prop === 'box-shadow' || prop === 'stroke') return 'line';
  return null;
}
/** Remove every `linear-gradient(...)` whose colours are all light (balanced-parenthesis scan). */
function stripLightGradients(value) {
  let out = '', i = 0, changed = false;
  while (i < value.length) {
    const k = value.indexOf('linear-gradient(', i);
    if (k < 0) { out += value.slice(i); break; }
    let depth = 0, j = k + 'linear-gradient'.length;
    for (; j < value.length; j++) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')') { depth--; if (depth === 0) { j++; break; } }
    }
    const grad = value.slice(k, j);
    const colors = (grad.match(COLOR_RE) ?? []).map(toRgb).filter(Boolean);
    const allLight = colors.length > 0 && colors.every((c) => lum(c) > 0.7 && sat(c) < 0.15);
    out += value.slice(i, k) + (allLight ? 'none' : grad);
    if (allLight) changed = true;
    i = j;
  }
  return { out, changed };
}

function mapValue(prop, value) {
  const use = useOf(prop);
  if (!use) return null;
  let changed = false;
  let src = value;
  if (use === 'surface' && src.includes('linear-gradient(')) {
    // Light 2010 gradients (buttons, bars) become flat surfaces in dark mode.
    const g = stripLightGradients(src);
    src = g.out; changed = g.changed;
  }
  const out = src.replace(COLOR_RE, (tok) => {
    const rgb = toRgb(tok);
    if (!rgb) return tok;
    const m = mapColor(rgb, use);
    if (!m) return tok;
    changed = true;
    return m;
  });
  return changed ? out.replace(/^none\s+none$/, 'none') : null;
}

// ---- tiny CSS walker (handles nested @media/@supports, skips @keyframes/@font-face) --------
function* rules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) return;
    const head = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const body = css.slice(open + 1, j - 1);
    if (head.startsWith('@media') || head.startsWith('@supports') || head.startsWith('@layer')) {
      if (/min-width:\s*(7[6-9]\d|[89]\d\d|\d{4,})px/.test(head)) { i = j; continue; } // desktop-only blocks
      yield* rules(body);
    } else if (!head.startsWith('@')) {
      yield { selector: head, body };
    }
    i = j;
  }
}

let out = `/* GENERATED by scripts/gen-dark.mjs — do not edit by hand. Re-run after changing any stylesheet.
   Dark mode for the phone UI: maps the light neutral colours of the 2010 design system and the feature
   stylesheets onto the theme variables defined in styles/mobile.css. Imported BEFORE mobile.css so the
   hand-written mobile rules win ties. */
@media (max-width: 767px) {
`;
let count = 0;
for (const file of sources) {
  const css = readFileSync(file, 'utf8');
  const lines = [];
  for (const { selector, body } of rules(css)) {
    const sels = selector.split(',').map((s) => s.trim()).filter((s) => s && !SKIP_SELECTOR.test(s));
    if (!sels.length) continue;
    const decls = [];
    for (const d of body.split(';')) {
      const k = d.indexOf(':');
      if (k < 0) continue;
      const prop = d.slice(0, k).trim().toLowerCase();
      const value = d.slice(k + 1).trim();
      const mapped = mapValue(prop, value);
      if (mapped) decls.push(`${prop}: ${mapped}`);
    }
    if (!decls.length) continue;
    const full = sels.map((s) => (s === 'body' || s === 'html' ? `${PREFIX}` : `${PREFIX} ${s}`)).join(',\n  ');
    lines.push(`  ${full} { ${decls.join('; ')}; }`);
    count++;
  }
  if (lines.length) out += `\n  /* ${file.split(/[\\/]/).slice(-2).join('/')} */\n${lines.join('\n')}\n`;
}
out += `
  /* Base text + page colours and form controls */
  ${PREFIX} { background: var(--m-bg); color: var(--m-text); }
  ${PREFIX} :is(input, textarea, select) { background: var(--m-input); color: var(--m-text); border-color: var(--m-input-line); }
  ${PREFIX} ::placeholder { color: var(--m-sub); }
  ${PREFIX} .av { filter: brightness(.92); }
}
`;
writeFileSync(join(root, 'styles', 'mobile-dark.css'), out);
console.log(`mobile-dark.css: ${count} rules from ${sources.length} stylesheets`);
