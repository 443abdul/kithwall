'use client';
// Kithwall i18n: typed keys from the English source catalogue, lazy-loaded locale catalogues, ICU-style
// plurals via Intl.PluralRules, and Intl number/date formatting.
//
//   const t = useT();          t('nav.home')   t('activity.count', { count: 3 })
//   t('…') outside React:      import { t } from '@/i18n'
//
// The active language is: the user's choice (localStorage 'kw.locale', later mirrored into encrypted
// settings) or else the first supported language in navigator.languages. public/theme.js applies
// <html lang dir> before first paint; this module loads the catalogue and keeps the two in sync.
import { useMemo, useSyncExternalStore } from 'react';
import en from './messages/en.json';
import { formatMessage, type Vars } from './format';
import { DEFAULT_LOCALE, dirOf, isLocale, langTag, matchLocale, type Locale } from './locales';

export * from './locales';
export { formatMessage, type Vars } from './format';

export type MessageKey = Exclude<keyof typeof en, '_meta'>;
export type Catalog = Partial<Record<MessageKey, string>> & { _meta?: unknown };

export const LOCALE_KEY = 'kw.locale';

const loaders: Record<Exclude<Locale, 'en'>, () => Promise<{ default: Catalog }>> = {
  ur: () => import('./messages/ur.json'),
  ar: () => import('./messages/ar.json'),
  fa: () => import('./messages/fa.json'),
  hi: () => import('./messages/hi.json'),
  bn: () => import('./messages/bn.json'),
  zh: () => import('./messages/zh.json'),
  ru: () => import('./messages/ru.json'),
  es: () => import('./messages/es.json'),
  fr: () => import('./messages/fr.json'),
  pt: () => import('./messages/pt.json'),
  tr: () => import('./messages/tr.json'),
};

const catalogs = new Map<Locale, Catalog>([['en', en as Catalog]]);

interface I18nState { locale: Locale; messages: Catalog; pref: Locale | null }
const SERVER_STATE: I18nState = { locale: DEFAULT_LOCALE, messages: en as Catalog, pref: null };
let state: I18nState = SERVER_STATE;
let started = false;
const listeners = new Set<() => void>();

function emit() { listeners.forEach((l) => l()); }

export function readLocalePref(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    return isLocale(v) ? v : null;
  } catch { return null; }
}

export function detectLocale(): Locale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  return matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

function applyToDocument(l: Locale) {
  const root = document.documentElement;
  root.lang = langTag(l);
  root.dir = dirOf(l);
}

async function load(l: Locale): Promise<Catalog> {
  const have = catalogs.get(l);
  if (have) return have;
  if (l === 'en') return en as Catalog;
  const mod = await loaders[l]();
  catalogs.set(l, mod.default);
  return mod.default;
}

async function activate(l: Locale, pref: Locale | null) {
  let messages: Catalog;
  try { messages = await load(l); } catch { messages = en as Catalog; }
  applyToDocument(l);
  state = { locale: l, messages, pref };
  document.documentElement.removeAttribute('data-i18n-pending');
  emit();
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const pref = readLocalePref();
  void activate(pref ?? detectLocale(), pref);
  window.addEventListener('storage', (e) => {
    if (e.key === LOCALE_KEY) { const p = readLocalePref(); void activate(p ?? detectLocale(), p); }
  });
  window.addEventListener('languagechange', () => {
    if (!readLocalePref()) void activate(detectLocale(), null);
  });
}

/** Re-apply <html lang dir> for the active language (after visiting a v1 page, which forces en/ltr). */
export function reapplyLocale() {
  if (typeof document === 'undefined') return;
  if (!started) { start(); return; } // first load: theme.js already set lang/dir
  if (state !== SERVER_STATE) applyToDocument(state.locale);
}

/** Choose a language (null = follow the device). Persists on this device. */
export async function setLocale(l: Locale | null): Promise<void> {
  try {
    if (l) localStorage.setItem(LOCALE_KEY, l); else localStorage.removeItem(LOCALE_KEY);
  } catch { /* storage blocked: still switch for this page */ }
  await activate(l ?? detectLocale(), l);
}

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useI18nState(): I18nState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}

function translate(s: I18nState, key: MessageKey, vars?: Vars): string {
  const template = s.messages[key] ?? (en as Record<string, string>)[key] ?? key;
  return formatMessage(template, vars, langTag(s.locale));
}

export type TFunction = (key: MessageKey, vars?: Vars) => string;

/** Translate outside React (uses the active language). */
export const t: TFunction = (key, vars) => translate(state, key, vars);

export function useT(): TFunction {
  const s = useI18nState();
  return useMemo<TFunction>(() => (key, vars) => translate(s, key, vars), [s]);
}

export function useLocale(): { locale: Locale; pref: Locale | null; dir: 'ltr' | 'rtl'; tag: string } {
  const s = useI18nState();
  return { locale: s.locale, pref: s.pref, dir: dirOf(s.locale), tag: langTag(s.locale) };
}

/** Intl formatters for the active language. */
export function useFormat() {
  const { tag } = useLocale();
  return useMemo(() => ({
    number: (n: number, o?: Intl.NumberFormatOptions) => new Intl.NumberFormat(tag, o).format(n),
    date: (d: Date | number, o: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }) => new Intl.DateTimeFormat(tag, o).format(d),
    relative: (value: number, unit: Intl.RelativeTimeFormatUnit) => new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }).format(value, unit),
    list: (items: string[]) => new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' }).format(items),
  }), [tag]);
}
