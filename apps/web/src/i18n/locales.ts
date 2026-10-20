// Supported languages (docs/v2/00-brief.md §7). Keep in sync with public/theme.js (LOCALES / RTL), which
// applies <html lang dir> before first paint; i18n.test.ts checks that they match.

export const LOCALES = ['en', 'ur', 'ar', 'fa', 'hi', 'bn', 'zh', 'ru', 'es', 'fr', 'pt', 'tr'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ur', 'ar', 'fa']);

/** Language names, always shown in the language itself (plus English for the picker's secondary line). */
export const LOCALE_NAMES: Record<Locale, { native: string; english: string }> = {
  en: { native: 'English', english: 'English' },
  ur: { native: 'اردو', english: 'Urdu' },
  ar: { native: 'العربية', english: 'Arabic' },
  fa: { native: 'فارسی', english: 'Persian' },
  hi: { native: 'हिन्दी', english: 'Hindi' },
  bn: { native: 'বাংলা', english: 'Bengali' },
  zh: { native: '简体中文', english: 'Chinese (Simplified)' },
  ru: { native: 'Русский', english: 'Russian' },
  es: { native: 'Español', english: 'Spanish' },
  fr: { native: 'Français', english: 'French' },
  pt: { native: 'Português', english: 'Portuguese' },
  tr: { native: 'Türkçe', english: 'Turkish' },
};

/** BCP 47 tag used for <html lang> and Intl formatters. */
export function langTag(l: Locale): string {
  return l === 'zh' ? 'zh-Hans' : l;
}

export function dirOf(l: Locale): 'ltr' | 'rtl' {
  return RTL_LOCALES.has(l) ? 'rtl' : 'ltr';
}

export function isLocale(x: unknown): x is Locale {
  return typeof x === 'string' && (LOCALES as readonly string[]).includes(x);
}

/** First supported language from the device's preference list (navigator.languages), else English. */
export function matchLocale(tags: readonly string[] | undefined | null): Locale {
  for (const raw of tags ?? []) {
    if (typeof raw !== 'string') continue;
    const base = raw.toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
