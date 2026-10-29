'use client';
// Web Push on this device (spec §12 "Push notifications"): service worker registration, subscribing
// and unsubscribing, push preferences and the "send a test" call. Pushes say only who did what
// ("dan sent you a message"); the subscription itself is routing data, not content.
import { useSyncExternalStore } from 'react';
import { sb, must } from './supabase';
import { authedPost } from './auth/api';
import { isNative, nativePlatform } from './native';
import { isStandalone } from './install';

// Inside the Kithwall app, push goes through the native provider instead of the service worker
// (lib/native/push.ts, docs/v2/05-native.md §5). Loaded only there.
const nativePush = () => import('./native/push');
let nativePermission: NotificationPermission = 'default';

export const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';
const SW_URL = '/sw.js';
const ENABLED_KEY = (uid: string) => `kw.push.enabled.${uid}`;
const PROMPT_KEY = 'kw.push.prompt.dismissedAt';

// ---------------------------------------------------------------------------------------
// Platform
export interface PushSupport {
  /** The browser can do Web Push here and now. */
  supported: boolean;
  /** iPhone/iPad Safari that isn't running from the Home Screen: push needs installing first (iOS 16.4+). */
  iosNeedsInstall: boolean;
  ios: boolean;
  standalone: boolean;
  permission: NotificationPermission | 'unsupported';
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Installed-app detection lives with the rest of installing (lib/install.ts).
export { isStandalone } from './install';

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return { supported: false, iosNeedsInstall: false, ios: false, standalone: false, permission: 'unsupported' };
  if (isNative()) return { supported: true, iosNeedsInstall: false, ios: nativePlatform() === 'ios', standalone: true, permission: nativePermission };
  const ios = isIos();
  const standalone = isStandalone();
  const apis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
  return {
    supported: !!apis && !!VAPID_PUBLIC_KEY,
    iosNeedsInstall: ios && !standalone,
    ios, standalone,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
  };
}

/** Coarse device label stored with the subscription ("Chrome on Android") — never the raw user agent. */
export function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = isIos() ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'another system';
  return `${browser} on ${os}${isStandalone() ? ' (app)' : ''}`;
}

// ---------------------------------------------------------------------------------------
// Service worker
let regPromise: Promise<ServiceWorkerRegistration> | null = null;

/** Register /sw.js (no caching, push only). Safe to call repeatedly. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration> | null {
  if (isNative()) return null;   // the app delivers pushes natively; no service worker in the WebView
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  regPromise ??= navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' })
    .then(async (reg) => { await navigator.serviceWorker.ready; return reg; })
    .catch((e) => { regPromise = null; throw e; });
  return regPromise;
}

async function existingRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;
  return navigator.serviceWorker.getRegistration('/');
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await existingRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------------------
// Subscribing
const listeners = new Set<() => void>();
let version = 0;
function changed() { version++; listeners.forEach((l) => l()); }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** Re-render when this device's push state changes. */
export function usePushVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}
/**
 * Read a browser-only primitive (support, permission, install state) without a hydration mismatch:
 * `server` during SSR and hydration, the live value afterwards; re-read whenever push state changes.
 */
export function usePushValue<T extends string | number | boolean>(read: () => T, server: T): T {
  return useSyncExternalStore(subscribe, read, () => server);
}

function rememberEnabled(uid: string, on: boolean) {
  try { if (on) localStorage.setItem(ENABLED_KEY(uid), '1'); else localStorage.removeItem(ENABLED_KEY(uid)); } catch { /* storage blocked */ }
}
export function wasEnabled(uid: string): boolean {
  try { return localStorage.getItem(ENABLED_KEY(uid)) === '1'; } catch { return false; }
}

/**
 * Why turning push on didn't work, for the UI: 'blocked' (refused earlier or switched off in settings: only
 * the settings can undo it), 'pending' (the browser parked the request in its quiet UI, a bell in the
 * address bar, and the promise never settles until the person finds it), 'dismissed' (closed the prompt).
 */
export class PushError extends Error {
  constructor(public code: 'blocked' | 'pending' | 'dismissed', message: string) { super(message); }
}

/** Give up waiting for the permission prompt after this long (Chrome on Android's quiet prompt never answers). */
const PROMPT_WAIT_MS = 20_000;

/** The app's notification settings (native only); false where there is no such screen to open. */
export async function openNotificationSettings(): Promise<boolean> {
  if (!isNative()) return false;
  return (await nativePush()).nativeOpenSettings();
}

async function store(sub: PushSubscription) {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error('Your browser returned an incomplete push subscription.');
  const { error } = await sb().rpc('register_push_subscription', {
    p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_label: deviceLabel(),
  });
  if (error) {
    if (error.code === '23514') throw new Error('This browser uses a push service Kithwall doesn’t support yet.');
    if (error.code === 'P0429') throw new Error('Too many attempts today. Please try again tomorrow.');
    throw new Error(error.message);
  }
}

/**
 * Turn push on for this device. Call from a click/tap handler: browsers only show the permission
 * prompt in response to a user gesture.
 */
async function nativeRefreshPermission(): Promise<void> {
  const before = nativePermission;
  nativePermission = await (await nativePush()).refreshNativePermission();
  if (before !== nativePermission) changed();
}

export async function enablePush(userId: string): Promise<void> {
  if (isNative()) {
    const n = await nativePush();
    try { await n.nativeEnablePush(); }
    catch (e) {
      if (e instanceof n.NativePushError && e.code === 'denied') throw new PushError('blocked', 'Notifications are turned off for Kithwall on this phone.');
      throw e;
    } finally { await nativeRefreshPermission(); }
    rememberEnabled(userId, true);
    changed();
    return;
  }
  const s = pushSupport();
  if (s.iosNeedsInstall) throw new Error('On iPhone and iPad, add Kithwall to your Home Screen first, then turn on notifications from there.');
  if (!s.supported) throw new Error('This browser doesn’t support push notifications.');
  // Ask first, while we're still inside the user's gesture.
  let perm: NotificationPermission | 'pending' = Notification.permission;
  if (perm === 'default') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    perm = await Promise.race([
      Notification.requestPermission(),
      new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), PROMPT_WAIT_MS); }),
    ]).finally(() => clearTimeout(timer));
  }
  if (perm !== 'granted') {
    changed();
    if (perm === 'pending') throw new PushError('pending', 'Your browser is waiting for an answer: look for a bell icon next to the address.');
    throw perm === 'denied'
      ? new PushError('blocked', 'Notifications are blocked for Kithwall in your browser settings. Allow them there, then try again.')
      : new PushError('dismissed', 'You didn’t allow notifications.');
  }
  const reg = await registerServiceWorker();
  if (!reg) throw new Error('This browser doesn’t support service workers.');
  const key = keyBytes(VAPID_PUBLIC_KEY);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => undefined); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await store(sub);
  rememberEnabled(userId, true);
  changed();
}

/** Turn push off for this device: forget the subscription on the server and in the browser. */
export async function disablePush(userId: string): Promise<void> {
  if (isNative()) {
    await (await nativePush()).nativeDisablePush();
    rememberEnabled(userId, false);
    changed();
    return;
  }
  const sub = await currentSubscription();
  if (sub) {
    const { error } = await sb().from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe().catch(() => undefined);
    if (error) console.warn('push: could not remove subscription row', error.code);
  }
  rememberEnabled(userId, false);
  changed();
}

/** Is push on for this device and this account? (browser subscription + our row). */
export async function pushEnabledHere(): Promise<boolean> {
  if (isNative()) {
    const on = await (await nativePush()).nativePushEnabledHere();
    await nativeRefreshPermission();
    return on;
  }
  if (!pushSupport().supported || Notification.permission !== 'granted') return false;
  const sub = await currentSubscription();
  if (!sub) return false;
  const rows = must(await sb().from('push_subscriptions').select('id').eq('endpoint', sub.endpoint).limit(1)) as unknown[];
  return rows.length > 0;
}

/**
 * After sign-in: make sure the server still has this device's subscription when the person had
 * push on here (subscriptions rotate; a different account may have used the device in between).
 * Never prompts.
 */
export async function syncPush(userId: string): Promise<void> {
  if (isNative()) {
    await (await nativePush()).nativeSyncPush();
    await nativeRefreshPermission();
    changed();
    return;
  }
  if (!pushSupport().supported || Notification.permission !== 'granted' || !wasEnabled(userId)) return;
  const reg = await registerServiceWorker();
  if (!reg) return;
  const key = keyBytes(VAPID_PUBLIC_KEY);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => undefined); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await store(sub);
  changed();
}

/**
 * Nobody is signed in on this device any more: stop this browser receiving pushes for the previous
 * account. (Without a session we can't delete the server row; the push service answers 410 for the
 * dead endpoint next time and the server removes it then.)
 */
export async function dropDeviceSubscription(): Promise<void> {
  if (isNative()) { await (await nativePush()).nativeDropDevice().catch(() => undefined); changed(); return; }
  const sub = await currentSubscription().catch(() => null);
  if (sub) await sub.unsubscribe().catch(() => undefined);
  changed();
}

export async function sendTestPush(): Promise<{ sent: number }> {
  if (isNative()) return authedPost<{ sent: number }>('/api/push/test', { nativeToken: await (await nativePush()).nativeCurrentToken() });
  const sub = await currentSubscription();
  return authedPost<{ sent: number }>('/api/push/test', { endpoint: sub?.endpoint });
}

// ---------------------------------------------------------------------------------------
// Preferences (per account, all devices). Not content: just which kinds of activity to push.
export interface PushPrefs {
  messages: boolean;
  activity: boolean;
  friend_requests: boolean;
  invites: boolean;
  security: boolean;
}
export const DEFAULT_PUSH_PREFS: PushPrefs = { messages: true, activity: true, friend_requests: true, invites: true, security: true };

export async function loadPushPrefs(userId: string): Promise<PushPrefs> {
  const row = must(await sb().from('push_preferences').select('messages, activity, friend_requests, invites, security')
    .eq('user_id', userId).maybeSingle()) as Partial<PushPrefs> | null;
  return { ...DEFAULT_PUSH_PREFS, ...(row ?? {}) };
}

export async function savePushPrefs(userId: string, prefs: PushPrefs): Promise<void> {
  must(await sb().from('push_preferences').upsert({ user_id: userId, ...prefs, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }));
}

// ---------------------------------------------------------------------------------------
// News Feed prompt
export function promptDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(PROMPT_KEY) ?? 0);
    return at > 0 && Date.now() - at < 60 * 24 * 60 * 60_000; // ask again after 60 days
  } catch { return false; }
}
export function dismissPrompt(): void {
  try { localStorage.setItem(PROMPT_KEY, String(Date.now())); } catch { /* storage blocked */ }
  changed();
}

/** Clear the app-icon badge (installed app) — called when Kithwall is in front of the person. */
export function clearAppBadge(): void {
  const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { clearAppBadge?: () => Promise<void> });
  nav?.clearAppBadge?.().catch(() => undefined);
}
