// Language tags for on-device translation (lib/translate): which language a text is in, whether it is worth
// offering a translation into the reader's language, and a cheap script check for when the browser can't
// detect languages yet. Pure functions, no I/O.
import type { Locale } from '@/i18n/locales';

/** Below this many letters a detection is a guess (names, "ok", "haha"), so nothing is offered. */
export const MIN_LETTERS = 12;
/** Detections below this confidence are treated as "don't know". */
export const MIN_CONFIDENCE = 0.5;

export interface Detection { lang: string; confidence: number }

/** Lower-case language subtag: 'ur-PK' → 'ur', 'zh-Hant' → 'zh', 'hi-Latn' → 'hi'. */
export function baseLang(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/** The legacy Norwegian / Hebrew / Indonesian codes some detectors still emit, mapped to current ones. */
const ALIASES: Record<string, string> = { iw: 'he', in: 'id', ji: 'yi', jw: 'jv', nb: 'no', fil: 'tl' };

/**
 * A detector's tag as a translation source, or null when it can't be one: 'und', empty, or a romanised
 * variant (ML Kit reports Roman Urdu/Hindi as 'hi-Latn'; translation models expect the native script,
 * so offering would produce nonsense).
 */
export function sourceLang(tag: string): string | null {
  const t = tag.trim();
  if (!t || /^und\b/i.test(t)) return null;
  const parts = t.split(/[-_]/);
  const base = baseLang(t);
  if (parts.slice(1).some((p) => p.toLowerCase() === 'latn') && !LATIN_LANGS.has(base)) return null;
  // Traditional Chinese is a separate model in Chrome ('zh-Hant'); keep that script subtag.
  if (base === 'zh' && parts.slice(1).some((p) => p.toLowerCase() === 'hant')) return 'zh-Hant';
  return ALIASES[base] ?? base;
}

/** The detection worth acting on: the most likely language, if it is confident enough. */
export function pickDetection(results: readonly Detection[] | null | undefined): Detection | null {
  if (!results?.length) return null;
  const best = [...results].sort((a, b) => b.confidence - a.confidence)[0]!;
  if (!(best.confidence >= MIN_CONFIDENCE)) return null;
  const lang = sourceLang(best.lang);
  return lang ? { lang, confidence: best.confidence } : null;
}

/** Same language for reading purposes ('pt-BR' and 'pt', 'zh' and 'zh-Hant' are not translated between). */
export function sameLanguage(a: string, b: string): boolean {
  return baseLang(a) === baseLang(b);
}

/** Letters only (links, @handles, emoji, digits and punctuation removed): what detection looks at. */
export function letters(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(^|\s)@[\w.-]+/g, ' ')
    .replace(/[^\p{L}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Is there enough text to detect a language at all? */
export function detectable(text: string): boolean {
  return letters(text).replace(/\s/g, '').length >= MIN_LETTERS;
}

// ------------------------------------------------------------------------------------- scripts
// When the browser's language detector still needs a download (which only a tap may start), text in a
// script the reader's language doesn't use is clearly in another language: offer "Translate" for that,
// and let the real detector decide after the tap.

type Script = 'latin' | 'arabic' | 'devanagari' | 'bengali' | 'han' | 'cyrillic' | 'other';

const LATIN_LANGS = new Set(['en', 'es', 'fr', 'pt', 'tr', 'de', 'it', 'nl', 'pl', 'id', 'ms', 'vi', 'sw', 'tl', 'ro', 'cs', 'sv', 'da', 'no', 'fi', 'hu', 'sk', 'sl', 'hr', 'lt', 'lv', 'et', 'sq', 'ga', 'cy', 'is', 'mt', 'af', 'ca', 'gl', 'eo', 'ht']);
const SCRIPT_OF_LOCALE: Record<Locale, Script> = {
  en: 'latin', es: 'latin', fr: 'latin', pt: 'latin', tr: 'latin',
  ur: 'arabic', ar: 'arabic', fa: 'arabic',
  hi: 'devanagari', bn: 'bengali', zh: 'han', ru: 'cyrillic',
};

const SCRIPT_RE: [Script, RegExp][] = [
  ['latin', /\p{Script=Latin}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['han', /\p{Script=Han}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
];

/** The script most of the letters are written in. */
export function dominantScript(text: string): Script | null {
  const counts = new Map<Script, number>();
  let total = 0;
  for (const ch of letters(text)) {
    if (ch === ' ' || /\p{M}/u.test(ch)) continue;
    total++;
    const s = SCRIPT_RE.find(([, re]) => re.test(ch))?.[0] ?? 'other';
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  if (!total) return null;
  const [script, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return n / total >= 0.6 ? script : null;
}

/** Text clearly written in a script the reader's language doesn't use (a hint only, never a detection). */
export function foreignScript(text: string, locale: Locale): boolean {
  if (!detectable(text)) return false;
  const s = dominantScript(text);
  return !!s && s !== SCRIPT_OF_LOCALE[locale];
}
