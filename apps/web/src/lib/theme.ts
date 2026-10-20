'use client';
// Appearance preferences (per device): a style (warm | minimal | bold) and a mode (system | light | dark).
// Stored in localStorage as 'kw.style' and 'kw.mode' (not sensitive; never leaves the device; later also
// mirrored into encrypted settings). public/theme.js applies them before first paint, so there is no
// flash; this module changes them at runtime and keeps "system" in sync with the OS.
//
// <html data-style="warm" data-mode="dark" data-mode-pref="system">.
import { useSyncExternalStore } from 'react';
import type { ModePref, StylePref } from '@/lib/auth/account';

export type { ModePref, StylePref };
export type Mode = 'light' | 'dark';
export interface Prefs { style: StylePref; mode: ModePref }

export const STYLES: readonly StylePref[] = ['warm', 'minimal', 'bold'];
export const MODES: readonly ModePref[] = ['system', 'light', 'dark'];
export const STYLE_KEY = 'kw.style';
export const MODE_KEY = 'kw.mode';
/** v1 key ('system' | 'light' | 'dark'); migrated to kw.mode. */
export const LEGACY_THEME_KEY = 'kw.theme';
export const DEFAULT_PREFS: Prefs = { style: 'warm', mode: 'system' };

/** Browser-chrome colour (meta theme-color) per style and mode = the --chrome token in styles/v2/tokens.css. */
export const THEME_COLORS: Record<StylePref, Record<Mode, string>> = {
  warm: { light: '#fbf6f0', dark: '#1b1613' },
  minimal: { light: '#ffffff', dark: '#0a0a0a' },
  bold: { light: '#f8f4ff', dark: '#110925' },
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const isStyle = (v: unknown): v is StylePref => v === 'warm' || v === 'minimal' || v === 'bold';
const isMode = (v: unknown): v is ModePref => v === 'system' || v === 'light' || v === 'dark';

function storage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** Read preferences, migrating the v1 'kw.theme' value into 'kw.mode' once. */
export function readPrefs(s: StorageLike | null = storage()): Prefs {
  if (!s) return { ...DEFAULT_PREFS };
  try {
    const style = s.getItem(STYLE_KEY);
    let mode: string | null = s.getItem(MODE_KEY);
    if (!isMode(mode)) {
      const legacy = s.getItem(LEGACY_THEME_KEY);
      if (legacy === 'light' || legacy === 'dark') {
        mode = legacy;
        s.setItem(MODE_KEY, legacy);
      } else mode = 'system';
      if (legacy !== null) s.removeItem(LEGACY_THEME_KEY);
    }
    return { style: isStyle(style) ? style : DEFAULT_PREFS.style, mode: mode as ModePref };
  } catch { return { ...DEFAULT_PREFS }; }
}

export function writePrefs(p: Partial<Prefs>, s: StorageLike | null = storage()) {
  if (!s) return;
  try {
    if (p.style) s.setItem(STYLE_KEY, p.style);
    if (p.mode) s.setItem(MODE_KEY, p.mode);
  } catch { /* storage blocked: still applied for this page */ }
}

export function systemDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function resolveMode(mode: ModePref, isSystemDark: boolean): Mode {
  return mode === 'system' ? (isSystemDark ? 'dark' : 'light') : mode;
}

let current: Prefs = DEFAULT_PREFS;
let resolved: Mode = 'light';
const listeners = new Set<() => void>();

/** Write the attributes + theme-color for these preferences onto <html>. */
export function applyPrefs(p: Prefs = readPrefs()) {
  const mode = resolveMode(p.mode, systemDark());
  const root = document.documentElement;
  root.setAttribute('data-style', p.style);
  root.setAttribute('data-mode', mode);
  root.setAttribute('data-mode-pref', p.mode);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[p.style][mode];
  if (p.style !== current.style || p.mode !== current.mode || mode !== resolved) {
    current = p;
    resolved = mode;
    listeners.forEach((l) => l());
  }
}

export function setStyle(style: StylePref) {
  const next = { ...readPrefs(), style };
  writePrefs({ style });
  applyPrefs(next);
}

export function setMode(mode: ModePref) {
  const next = { ...readPrefs(), mode };
  writePrefs({ mode });
  applyPrefs(next);
}

let watching = 0;
let unwatch: (() => void) | null = null;
/** Follow OS light/dark changes (for mode 'system') and other tabs' changes. Ref-counted. */
export function watchSystemMode(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (watching++ === 0) {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onMq = () => applyPrefs();
    const onStorage = (e: StorageEvent) => { if (e.key === STYLE_KEY || e.key === MODE_KEY) applyPrefs(); };
    mq?.addEventListener('change', onMq);
    window.addEventListener('storage', onStorage);
    applyPrefs();
    unwatch = () => { mq?.removeEventListener('change', onMq); window.removeEventListener('storage', onStorage); };
  }
  return () => { if (--watching === 0) { unwatch?.(); unwatch = null; } };
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (typeof window !== 'undefined') applyPrefs();
  return () => { listeners.delete(l); };
}

/** Current preferences + the resolved mode. Server snapshot is the default (warm/system/light). */
export function usePrefs(): Prefs & { resolved: Mode } {
  const p = useSyncExternalStore(subscribe, () => current, () => DEFAULT_PREFS);
  const r = useSyncExternalStore(subscribe, () => resolved, () => 'light' as Mode);
  return { ...p, resolved: r };
}
