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

async function store(): Promise<string> {
  const p = await nativePlugin('KithwallPush');
  let reg;
  // The VAPID key lets UnifiedPush distributors accept pushes from our server only.
  try { reg = await p.register({ vapid: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || undefined }); } catch (e) { throw new NativePushError(nativeErrorCode(e) || 'failed'); }
  const { error } = await sb().rpc('register_native_push', {
    p_provider: reg.provider, p_token: reg.token, p_p256dh: reg.p256dh, p_auth: reg.auth,
    p_label: await label(), p_apns_env: reg.apnsEnv ?? null,
  });
  if (error) {
    if (error.code === 'P0429') throw new NativePushError('rate_limited');
    if (error.code === '23514') throw new NativePushError('unsupported_endpoint');
    throw new NativePushError('failed');
  }
  return reg.token;
}

/** Turn notifications on for this app install (asks for the permission first). */
export async function nativeEnablePush(): Promise<void> {
  const p = await nativePlugin('KithwallPush');
  let { state } = await p.permission();
  if (state === 'prompt') state = (await p.requestPermission()).state;
  permissionCache = state === 'prompt' ? 'default' : state;
  if (state !== 'granted') throw new NativePushError('denied');
  await store();
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

/** After sign-in: re-register (tokens rotate; another account may have used this phone). Never prompts for permission. */
export async function nativeSyncPush(): Promise<void> {
  if ((await refreshNativePermission()) !== 'granted') return;
  const cur = await (await nativePlugin('KithwallPush')).current().catch(() => ({} as { token?: string }));
  if (!cur.token) return;   // never turned on here (or turned off): nothing to sync
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
