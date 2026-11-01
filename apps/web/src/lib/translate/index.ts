'use client';
// On-device translation (roadmap C1). Posts, comments and chat messages in another language get a small
// "Translate" action; the text is translated on this device by the browser's built-in model (desktop Chrome)
// or the Android app's ML Kit plugin (play build). Nothing is ever sent to a server for translation,
// Kithwall's included, and there is no cloud fallback: without an on-device engine the action isn't shown.
//
// Per-device preferences in localStorage (like Data Saver): whether to offer translation at all, and whether
// the first-use explanation was seen. Translations themselves live only in memory (core.ts).
import { useSyncExternalStore } from 'react';
import { isNative, nativePlatform, nativePlugin } from '@/lib/native';
import { onLock } from '@/lib/keys/session';
import { Translation } from './core';
import { selectEngine, type BrowserAi } from './engines';

export type { Offer, Plan } from './core';
export { NeedsDownload } from './engines';

export const translation = new Translation(() => selectEngine({
  native: async () => (isNative() && nativePlatform() === 'android' ? nativePlugin('KithwallTranslate') : null),
  browser: () => (typeof self === 'undefined' ? null : (self as unknown as BrowserAi)),
}));

onLock(() => translation.clear());

/** ML Kit doesn't publish pack sizes; its documentation gives "around 30 MB" per language. */
export const PACK_BYTES = 30 * 1024 * 1024;

// ------------------------------------------------------------------------------------- preferences
const OFFER_KEY = 'kw.translate';
const INTRO_KEY = 'kw.translate.intro';

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let wired = false;
const subscribe = (l: () => void) => {
  if (!wired && typeof window !== 'undefined') {
    wired = true;
    window.addEventListener('storage', (e) => { if (e.key === OFFER_KEY || e.key === INTRO_KEY) emit(); });
  }
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/** "Offer translation" (default on). */
export function translationOffered(): boolean {
  try { return localStorage.getItem(OFFER_KEY) !== 'off'; } catch { return true; }
}

export function setTranslationOffered(on: boolean) {
  try { if (on) localStorage.removeItem(OFFER_KEY); else localStorage.setItem(OFFER_KEY, 'off'); } catch { /* storage blocked */ }
  emit();
}

/** Has this device shown the "translated on this device" explanation? */
export function translationIntroSeen(): boolean {
  try { return localStorage.getItem(INTRO_KEY) === '1'; } catch { return false; }
}

export function setTranslationIntroSeen() {
  try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* storage blocked */ }
  emit();
}

export function useTranslationOffered(): boolean {
  return useSyncExternalStore(subscribe, translationOffered, () => false);
}

// ------------------------------------------------------------------------------------- engine
export type EngineKind = 'browser' | 'native';

let engineKind: EngineKind | 'none' | null = null;
let checking = false;
const engineKindNow = () => engineKind;
const subscribeEngine = (l: () => void) => {
  const off = subscribe(l);
  if (!checking) {
    checking = true;
    void translation.engine().then((e) => { engineKind = e?.kind ?? 'none'; emit(); });
  }
  return off;
};

/** The on-device engine available here ('none' when there is none), or null while still checking. */
export function useTranslationEngine(): EngineKind | 'none' | null {
  return useSyncExternalStore(subscribeEngine, engineKindNow, () => null);
}

/** A language's name in the reader's language ('ur' → "Urdu"), falling back to the code. */
export function languageName(code: string, uiTag: string): string {
  try { return new Intl.DisplayNames([uiTag], { type: 'language' }).of(code) ?? code; } catch { return code; }
}
