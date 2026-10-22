'use client';
// Installing Kithwall as an app (PWA): the browser's install offer, whether we're already installed,
// which instructions fit this browser, and the calm "install the app" nudge for returning visitors.
//
// Privacy: everything here stays on this device. Visit counts and "not now" / "don't ask again" live in
// localStorage under kw.install.* and are never sent anywhere (no server tracking, no analytics).
//
// Chrome, Edge and other Chromium browsers fire `beforeinstallprompt` once, early — possibly before React
// has hydrated. public/theme.js (a synchronous script in <head>) therefore catches it first and parks it on
// window.__kwInstall; this module picks it up and keeps listening afterwards.
// Inside the Kithwall Android/iOS app (Capacitor, lib/native) nothing here ever offers an install.
import { useSyncExternalStore } from 'react';
import { isNative } from './native';

// ---------------------------------------------------------------------------------------
// Platform detection (pure; unit-tested in install.test.ts)
export type InstallPlatform =
  | 'ios-safari'        // Share → Add to Home Screen (needed for notifications on iPhone/iPad)
  | 'ios-other'         // Chrome/Firefox/in-app browsers on iOS: open in Safari
  | 'android-chromium'  // Chrome, Edge, Brave, Opera…: menu → Install app (or the install prompt)
  | 'android-samsung'   // Samsung Internet: menu → Add page to → Home screen
  | 'android-firefox'   // Firefox: menu → Install
  | 'desktop-chromium'  // Chrome/Edge on a computer: address-bar icon or the prompt
  | 'desktop-safari'    // Safari on macOS Sonoma+: File → Add to Dock
  | 'desktop-firefox'   // no install on most systems
  | 'unknown';

export type InstallGroup = 'ios' | 'android' | 'desktop';

export interface UaInfo { ua: string; platform?: string; maxTouchPoints?: number }

export function detectPlatform({ ua, platform = '', maxTouchPoints = 0 }: UaInfo): InstallPlatform {
  // iPadOS 13+ reports itself as a Mac; a Mac has no touch screen.
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh|MacIntel/.test(platform || ua) && maxTouchPoints > 1 && /Safari\//.test(ua));
  if (ios) {
    // Other iOS browsers and in-app web views (Facebook, Instagram, Line, Google app…).
    if (/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|YaBrowser|DuckDuckGo|Brave|FBAN|FBAV|Instagram|Line\/|Twitter|Snapchat|TikTok/i.test(ua)) return 'ios-other';
    return /Safari\//.test(ua) ? 'ios-safari' : 'ios-other';
  }
  if (/Android/i.test(ua)) {
    if (/Firefox\//.test(ua)) return 'android-firefox';
    if (/SamsungBrowser/.test(ua)) return 'android-samsung';
    if (/Chrome\//.test(ua)) return 'android-chromium';
    return 'unknown';
  }
  if (/Mobile|Tablet|KaiOS/i.test(ua)) return 'unknown';
  if (/Firefox\//.test(ua)) return 'desktop-firefox';
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'desktop-chromium';
  if (/Macintosh/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua)) return 'desktop-safari';
  return 'unknown';
}

export function groupOf(p: InstallPlatform): InstallGroup | null {
  if (p === 'ios-safari' || p === 'ios-other') return 'ios';
  if (p.startsWith('android-')) return 'android';
  if (p.startsWith('desktop-')) return 'desktop';
  return null;
}

/** Can a person on this platform install Kithwall by following our steps? */
export function hasInstructions(p: InstallPlatform): boolean {
  return p !== 'unknown' && p !== 'desktop-firefox';
}

// ---------------------------------------------------------------------------------------
// Returning visitors, snooze and "don't ask again" (pure over a Storage; unit-tested)
export const INSTALL_KEYS = {
  firstSeen: 'kw.install.firstSeen',
  sessions: 'kw.install.sessions',
  snoozedUntil: 'kw.install.snoozedUntil',
  never: 'kw.install.never',
  installed: 'kw.install.installed',
  /** sessionStorage: this browser session was already counted. */
  counted: 'kw.install.counted',
} as const;

const DAY = 24 * 60 * 60_000;
export const SNOOZE_MS = 30 * DAY;
export const RETURNING_AFTER_MS = 3 * DAY;
export const RETURNING_SESSIONS = 2;

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface Visits { firstSeen: number; sessions: number; snoozedUntil: number; never: boolean; installedBefore: boolean }

function num(s: KV | null, k: string): number {
  try { const v = Number(s?.getItem(k) ?? 0); return Number.isFinite(v) && v > 0 ? v : 0; } catch { return 0; }
}
function put(s: KV | null, k: string, v: string | null) {
  try { if (!s) return; if (v === null) s.removeItem(k); else s.setItem(k, v); } catch { /* storage blocked */ }
}

export function readVisits(s: KV | null): Visits {
  let never = false;
  let installedBefore = false;
  try { never = s?.getItem(INSTALL_KEYS.never) === '1'; installedBefore = !!s?.getItem(INSTALL_KEYS.installed); } catch { /* blocked */ }
  return { firstSeen: num(s, INSTALL_KEYS.firstSeen), sessions: num(s, INSTALL_KEYS.sessions), snoozedUntil: num(s, INSTALL_KEYS.snoozedUntil), never, installedBefore };
}

/** Count this browser session once (a new tab after closing the browser is a new session). */
export function noteVisit(local: KV | null, session: KV | null, now: number): Visits {
  const v = readVisits(local);
  if (!v.firstSeen) put(local, INSTALL_KEYS.firstSeen, String(now));
  let counted = false;
  try { counted = session?.getItem(INSTALL_KEYS.counted) === '1'; } catch { /* blocked */ }
  if (!counted) {
    put(local, INSTALL_KEYS.sessions, String(v.sessions + 1));
    put(session, INSTALL_KEYS.counted, '1');
  }
  return readVisits(local);
}

/** Never on a first visit: from the second session on, or three days after the first visit. */
export function isReturning(v: Visits, now: number): boolean {
  if (!v.firstSeen) return false;
  return v.sessions >= RETURNING_SESSIONS || now - v.firstSeen >= RETURNING_AFTER_MS;
}

export interface NudgeInput { visits: Visits; now: number; native: boolean; installed: boolean; canInstall: boolean; platform: InstallPlatform }

export function nudgeEligible({ visits, now, native, installed, canInstall, platform }: NudgeInput): boolean {
  if (native || installed || visits.installedBefore || visits.never) return false;
  if (now < visits.snoozedUntil) return false;
  if (!isReturning(visits, now)) return false;
  return canInstall || hasInstructions(platform);
}

export function snoozeNudge(s: KV | null, now: number): void { put(s, INSTALL_KEYS.snoozedUntil, String(now + SNOOZE_MS)); }
export function neverNudge(s: KV | null): void { put(s, INSTALL_KEYS.never, '1'); }

// ---------------------------------------------------------------------------------------
// Runtime: the browser's install offer and the installed state
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
interface InstallWindow { __kwInstall?: BeforeInstallPromptEvent | null; __kwInstalled?: boolean }

export interface InstallSnapshot {
  /** Client values are known (false during SSR and hydration). */
  ready: boolean;
  /** The browser offered an install we can show with promptInstall(). */
  canInstall: boolean;
  /** Running as the installed app (or installed during this visit). */
  isInstalled: boolean;
  /** Inside the Kithwall Android/iOS app: never offer installing. */
  native: boolean;
  platform: InstallPlatform;
}

const SERVER: InstallSnapshot = { ready: false, canInstall: false, isInstalled: false, native: false, platform: 'unknown' };
let snap: InstallSnapshot = SERVER;
let deferred: BeforeInstallPromptEvent | null = null;
let installedNow = false;
let started = false;
const listeners = new Set<() => void>();

function localStore(): KV | null { try { return window.localStorage; } catch { return null; } }
function sessionStore(): KV | null { try { return window.sessionStorage; } catch { return null; } }

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  const mm = (q: string) => !!window.matchMedia?.(q).matches;
  // (Not display-mode: fullscreen — a browser tab in F11 fullscreen matches it too.)
  return nav.standalone === true || mm('(display-mode: standalone)') || mm('(display-mode: minimal-ui)')
    || mm('(display-mode: window-controls-overlay)');
}

function compute(): InstallSnapshot {
  const native = isNative();
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const next: InstallSnapshot = {
    ready: true,
    native,
    canInstall: !native && !!deferred,
    isInstalled: native || installedNow || isStandalone(),
    platform: native ? 'unknown' : detectPlatform({ ua: nav.userAgent, platform: nav.userAgentData?.platform || nav.platform, maxTouchPoints: nav.maxTouchPoints }),
  };
  const same = (Object.keys(next) as (keyof InstallSnapshot)[]).every((k) => next[k] === snap[k]);
  return same ? snap : next;
}

function changed() { snap = compute(); listeners.forEach((l) => l()); }

function onPrompt(e: Event) {
  e.preventDefault(); // no browser mini-infobar: we offer installing calmly, when it fits
  deferred = e as BeforeInstallPromptEvent;
  changed();
}
function onInstalled() {
  deferred = null;
  installedNow = true;
  put(localStore(), INSTALL_KEYS.installed, String(Date.now()));
  changed();
}

/** Start listening (idempotent). Mounted from Providers via components/install/InstallRuntime. */
export function initInstall(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  if (isNative()) { changed(); return; }
  const w = window as unknown as InstallWindow;
  if (w.__kwInstall) deferred = w.__kwInstall;
  if (w.__kwInstalled) { installedNow = true; put(localStore(), INSTALL_KEYS.installed, String(Date.now())); }
  window.addEventListener('beforeinstallprompt', onPrompt);
  window.addEventListener('appinstalled', onInstalled);
  window.addEventListener('kw:install', () => { if (w.__kwInstall) deferred = w.__kwInstall; changed(); });
  // Opened as the installed app: remember it so this device's browser tab doesn't nudge later.
  if (isStandalone()) put(localStore(), INSTALL_KEYS.installed, String(Date.now()));
  noteVisit(localStore(), sessionStore(), Date.now());
  changed();
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/** Install state; SSR/hydration render the neutral server snapshot, then the live one (no mismatch). */
export function useInstall(): InstallSnapshot {
  return useSyncExternalStore(subscribe, () => snap, () => SERVER);
}

/** Show the browser's install dialog. Call from a click/tap. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const ev = deferred;
  if (!ev || isNative()) return 'unavailable';
  deferred = null; // the event can be used only once
  const w = typeof window === 'undefined' ? null : (window as unknown as InstallWindow);
  if (w) w.__kwInstall = null;
  try {
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === 'accepted') { installedNow = true; put(localStore(), INSTALL_KEYS.installed, String(Date.now())); }
    return outcome;
  } catch {
    return 'unavailable';
  } finally {
    changed();
  }
}

// ---------------------------------------------------------------------------------------
// The in-app nudge
const nudgeListeners = new Set<() => void>();
function nudgeChanged() { nudgeListeners.forEach((l) => l()); }
function subscribeNudge(l: () => void) {
  listeners.add(l);
  nudgeListeners.add(l);
  return () => { listeners.delete(l); nudgeListeners.delete(l); };
}
function nudgeNow(): boolean {
  if (!snap.ready) return false;
  return nudgeEligible({ visits: readVisits(localStore()), now: Date.now(), native: snap.native, installed: snap.isInstalled, canInstall: snap.canInstall, platform: snap.platform });
}

/** Should the "install the app" card show now? (false on the server and during hydration) */
export function useInstallNudge(): boolean {
  return useSyncExternalStore(subscribeNudge, nudgeNow, () => false);
}

export function snoozeInstallNudge(): void { snoozeNudge(localStore(), Date.now()); nudgeChanged(); }
export function neverInstallNudge(): void { neverNudge(localStore()); nudgeChanged(); }
