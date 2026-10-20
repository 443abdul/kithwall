// Tiny ICU-style message formatter (no dependency). Supports:
//   {name}                                   interpolation (numbers are localised)
//   {count, plural, =0 {…} one {# item} other {# items}}   via Intl.PluralRules; # = the number
//   {kind, select, a {…} b {…} other {…}}
// Branches may nest. Apostrophes are plain text (no ICU quoting) so copy like "you're" just works.

export type Vars = Record<string, string | number>;

const pluralCache = new Map<string, Intl.PluralRules>();
const numberCache = new Map<string, Intl.NumberFormat>();

function plural(locale: string): Intl.PluralRules {
  let p = pluralCache.get(locale);
  if (!p) { p = new Intl.PluralRules(locale); pluralCache.set(locale, p); }
  return p;
}
function num(locale: string): Intl.NumberFormat {
  let n = numberCache.get(locale);
  if (!n) { n = new Intl.NumberFormat(locale); numberCache.set(locale, n); }
  return n;
}

/** Index of the "}" that closes the "{" at `open`. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Parse "=0 {..} one {..} other {..}" into a map. */
function options(s: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    const start = i;
    while (i < s.length && s[i] !== '{' && !/\s/.test(s[i]!)) i++;
    const key = s.slice(start, i);
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] !== '{') break;
    const end = closing(s, i);
    if (end < 0) break;
    out.set(key, s.slice(i + 1, end));
    i = end + 1;
  }
  return out;
}

function fmt(template: string, vars: Vars, locale: string, hash: string | null): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch === '#' && hash !== null) { out += hash; i++; continue; }
    if (ch !== '{') { out += ch; i++; continue; }
    const end = closing(template, i);
    if (end < 0) { out += template.slice(i); break; }
    const body = template.slice(i + 1, end);
    i = end + 1;
    const c1 = body.indexOf(',');
    if (c1 < 0) {
      const name = body.trim();
      const v = vars[name];
      out += v === undefined ? `{${name}}` : typeof v === 'number' ? num(locale).format(v) : v;
      continue;
    }
    const name = body.slice(0, c1).trim();
    const rest = body.slice(c1 + 1);
    const c2 = rest.indexOf(',');
    const type = (c2 < 0 ? rest : rest.slice(0, c2)).trim();
    const opts = options(c2 < 0 ? '' : rest.slice(c2 + 1));
    const v = vars[name];
    if (type === 'plural') {
      const n = typeof v === 'number' ? v : Number(v);
      const branch = opts.get(`=${n}`) ?? opts.get(Number.isFinite(n) ? plural(locale).select(n) : 'other') ?? opts.get('other') ?? '';
      out += fmt(branch, vars, locale, Number.isFinite(n) ? num(locale).format(n) : String(v));
    } else if (type === 'select') {
      const branch = opts.get(String(v)) ?? opts.get('other') ?? '';
      out += fmt(branch, vars, locale, hash);
    } else {
      out += v === undefined ? '' : String(v);
    }
  }
  return out;
}

export function formatMessage(template: string, vars: Vars = {}, locale = 'en'): string {
  if (!template.includes('{')) return template;
  return fmt(template, vars, locale, null);
}

/** Variable names a template uses (for the catalogue consistency test). */
export function placeholders(template: string): string[] {
  const names = new Set<string>();
  const walk = (s: string) => {
    let i = 0;
    while (i < s.length) {
      if (s[i] !== '{') { i++; continue; }
      const end = closing(s, i);
      if (end < 0) return;
      const body = s.slice(i + 1, end);
      const c1 = body.indexOf(',');
      if (c1 < 0) names.add(body.trim());
      else {
        names.add(body.slice(0, c1).trim());
        const rest = body.slice(c1 + 1);
        const c2 = rest.indexOf(',');
        if (c2 >= 0) for (const branch of options(rest.slice(c2 + 1)).values()) walk(branch);
      }
      i = end + 1;
    }
  };
  walk(template);
  return [...names].sort();
}
