'use client';
// Appearance preference (per device): 'system' follows the OS, or force 'light' / 'dark'.
// public/theme.js applies it before first paint; this module changes it at runtime.
// Dark mode applies to the phone UI; the desktop keeps the 2010 look.
import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'kw.theme';
const listeners = new Set<() => void>();

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}

function systemDark() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(pref: ThemePref = getThemePref()) {
  const dark = pref === 'dark' || (pref === 'system' && systemDark());
  const root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-pref', pref);
  // Status-bar / browser chrome colour on phones.
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const narrow = window.matchMedia?.('(max-width: 767px)').matches;
  if (meta) meta.content = narrow ? (dark ? '#242526' : '#ffffff') : '#3b5998';
  listeners.forEach((l) => l());
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref);
  } catch { /* storage blocked: still apply for this page */ }
  applyTheme(pref);
}

/** Keep 'system' in sync with the OS while the app is open. */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return () => undefined;
  const on = () => { if (getThemePref() === 'system') applyTheme('system'); };
  mq.addEventListener('change', on);
  applyTheme();
  return () => mq.removeEventListener('change', on);
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    getThemePref,
    () => 'system',
  );
}
