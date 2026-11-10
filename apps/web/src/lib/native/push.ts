'use client';
// Native push in the app (docs/v2/05-native.md §5). The app makes a P-256 key pair on the device (Android:
// private key wrapped by a Keystore key; iOS: Keychain, shared with the Notification Service Extension)
// and registers {provider, token, public key, auth secret} with register_native_push(). Pushes arrive
// encrypted to that key; the app decrypts and shows them, so FCM / APNs / the UnifiedPush distributor
// only carry ciphertext. Hidden chats are matched on the device against the same salted hashes the
// service worker uses.
import { sb, must } from '../supabase';
import { nativeErrorCode, nativePlatform, nativePlugin } from './index';
import { shellInfo } from './shell';

export type NativePermission = 'granted' | 'denied' | 'default';

let permissionCache: NativePermission = 'default';
/** Last known notification permission (pushSupport() is synchronous). */
export const nativePermissionNow = () => permissionCache;

export async function refreshNativePermission(): Promise<NativePermission> {
  try {
    const { state } = await (await nativePlugin('KithwallPush')).permission();
    permissionCache = state === 'prompt' ? 'default' : state;
  } catch { permissionCache = 'default'; }
  return permissionCache;
}

async function label(): Promise<string> {
  const info = await shellInfo();
  const os = nativePlatform() === 'ios' ? 'iOS' : 'Android';
  return info?.flavor === 'foss' ? `Kithwall app on ${os} (UnifiedPush)` : `Kithwall app on ${os}`;
}

export class NativePushError extends Error {
  constructor(public code: string) { super(code); }
}

/** Getting a push token can stall for minutes on a bad network (FCM retries with back-off): give up after this. */
const REGISTER_TIMEOUT_MS = 45_000;

async function store(): Promise<string> {
  const p = await nativePlugin('KithwallPush');
  let reg;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The VAPID key lets UnifiedPush distributors accept pushes from our server only.
    reg = await Promise.race([
      p.register({ vapid: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || undefined }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), REGISTER_TIMEOUT_MS); }),
    ]);
  } catch (e) { throw new NativePushError(nativeErrorCode(e) || 'failed'); } finally { clearTimeout(timer); }
  const { error } = await sb().rpc('register_native_push', {
    p_provider: reg.provider, p_token: reg.token, p_p256dh: reg.p256dh, p_auth: reg.auth,
    p_label: await label(), p_apns_env: reg.apnsEnv ?? null,
  });
  if (error) {
    if (error.code === 'P0429') throw new NativePushError('rate_limited');
    if (error.code === '42501') throw new NativePushError('not_allowed');
    if (error.code === '23514') throw new NativePushError('unsupported_endpoint');
    throw new NativePushError('failed');
  }
  return reg.token;
}

/**
 * Turn notifications on for this app install.
 *
 * App 2.4.0 and later (`api` 2): Android itself is asked whenever notifications aren't on, and every request is
 * answered: granted, a plain "Don't allow" (code 'declined'), or `blocked` when Android refused without
 * showing its dialog (it stops asking after two refusals; Android 12 and older have no dialog). Blocked opens
 * the app's notification settings: code 'settings'; lib/push.ts finishes switching on when the person returns.
 *
 * App 2.0.0 to 2.3.0 (no `api`): their release builds could not ask at all. R8 had emptied the permission
 * list Capacitor requests from, so no dialog appeared and the call never answered ("Turn on notifications"
 * waited forever). Never call requestPermission() there: go straight to the settings page, and where the app
 * is too old to open it (2.0.0), say where to find it: code 'blocked'.
 */
export async function nativeEnablePush(): Promise<void> {
  const p = await nativePlugin('KithwallPush');
  const perm = await p.permission();
  if (perm.state !== 'granted') {
    let blocked = true;
    if (Number(perm.api) >= 2) {
      const r = await p.requestPermission();
      if (r.state === 'granted') blocked = false;
      else if (r.blocked !== true) { permissionCache = 'denied'; throw new NativePushError('declined'); }
    }
    if (blocked) {
      permissionCache = 'denied';
      if (await nativeOpenSettings()) throw new NativePushError('settings');
      throw new NativePushError('blocked');
    }
  }
  permissionCache = 'granted';
  await store();
}

/** Open the system's notification settings for this app (older app builds don't have it: false). */
export async function nativeOpenSettings(): Promise<boolean> {
  const p = await nativePlugin('KithwallPush');
  if (typeof p.openSettings !== 'function') return false;
  try { await p.openSettings(); return true; } catch { return false; }
}

/** Turn them off: delete the server row, forget the token and the device key. */
export async function nativeDisablePush(): Promise<void> {
  const p = await nativePlugin('KithwallPush');
  const cur = await p.current().catch(() => ({} as { token?: string }));
  if (cur.token) {
    const { error } = await sb().from('native_push_devices').delete().eq('token', cur.token);
    if (error) console.warn('push: could not remove the device row', error.code);
  }
  await p.unregister().catch(() => undefined);
}

export async function nativePushEnabledHere(): Promise<boolean> {
  if ((await refreshNativePermission()) !== 'granted') return false;
  const cur = await (await nativePlugin('KithwallPush')).current().catch(() => ({} as { token?: string }));
  if (!cur.token) return false;
  const rows = must(await sb().from('native_push_devices').select('id').eq('token', cur.token).limit(1)) as unknown[];
  return rows.length > 0;
}

/**
 * After sign-in: re-register (tokens rotate; another account may have used this phone). Never prompts for
 * permission. `wasOn`: this account turned notifications on here before; if the phone has lost its token
 * since (older app versions dropped it whenever a session failed to load at start-up), register again
 * instead of silently staying off.
 */
export async function nativeSyncPush(opts: { wasOn?: boolean } = {}): Promise<void> {
  if ((await refreshNativePermission()) !== 'granted') return;
  const cur = await (await nativePlugin('KithwallPush')).current().catch(() => ({} as { token?: string }));
  if (!cur.token && !opts.wasOn) return;   // never turned on here (or turned off): nothing to sync
  await store();
}

/** Nobody is signed in: stop this phone receiving the last person's notifications. */
export async function nativeDropDevice(): Promise<void> {
  const p = await nativePlugin('KithwallPush');
  await p.unregister().catch(() => undefined);
  await p.clearNotifications().catch(() => undefined);
}

export async function nativeCurrentToken(): Promise<string | null> {
  const cur = await (await nativePlugin('KithwallPush')).current().catch(() => ({} as { token?: string }));
  return cur.token ?? null;
}

export async function nativeSetHidden(salt: string, hashes: string[]): Promise<void> {
  const p = await nativePlugin('KithwallPush');
  if (hashes.length) await p.setHidden({ salt, hashes }); else await p.clearHidden();
}

export async function nativeClearHidden(): Promise<void> {
  await (await nativePlugin('KithwallPush')).clearHidden();
}

/** Notification taps while the app runs → in-app navigation (keeps the unlocked keys). */
export async function onNativeOpen(fn: (path: string) => void): Promise<() => void> {
  const h = await (await nativePlugin('KithwallPush')).addListener('open', (e) => {
    if (typeof e.url === 'string' && e.url.startsWith('/') && !e.url.startsWith('//')) fn(e.url);
  });
  return () => { void h.remove(); };
}
