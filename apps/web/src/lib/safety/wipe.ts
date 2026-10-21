'use client';
// Panic wipe (docs/v2/03-safety.md §4): forget everything this browser keeps for Kithwall.
//  - push: unsubscribe this browser and remove its subscription row (so no more previews arrive here)
//  - session: sign this device out (Supabase revokes this session's refresh token)
//  - keys: the in-memory AMK is zeroed; the device store (remembered AMK, app PIN record, attempts)
//    and every other IndexedDB database of this origin are deleted
//  - caches: Cache Storage, the service worker registration, localStorage and sessionStorage
//  - in the Kithwall app (docs/v2/05-native.md §4): the Keystore/Keychain store (remembered AMK, PIN
//    record, biometric key), the push token and device push key, the hidden-chat mirror, shown
//    notifications, and the WebView's cookies and cache
// The account itself is untouched on the server: sign in again with a passkey, the passphrase or the
// recovery key. Each step is best effort and time-boxed, so a wipe finishes even offline.
import { getSession, signOut } from '../keys/session';
import { deleteDeviceDatabase } from '../keys/device';
import { sb } from '../supabase';
import { clearSwHidden } from './swmirror';
import { isNative } from '../native';

function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

async function dropNative(): Promise<void> {
  if (!isNative()) return;
  const [{ nativeDisablePush, nativeDropDevice, nativeClearHidden }, { nativeSecure }] = await Promise.all([import('../native/push'), import('../native/secure')]);
  if (getSession().userId) await within(nativeDisablePush(), 1500);
  await within(nativeDropDevice(), 1000);
  await within(nativeClearHidden(), 1000);
  await within(nativeSecure.clear(), 1500);
}

async function dropPush(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
  for (const reg of regs) {
    const sub = await reg.pushManager?.getSubscription().catch(() => null);
    if (sub) {
      if (getSession().userId) await within(Promise.resolve(sb().from('push_subscriptions').delete().eq('endpoint', sub.endpoint)), 1500);
      await sub.unsubscribe().catch(() => undefined);
    }
  }
}

async function dropStorage(): Promise<void> {
  // Known databases first (Firefox has no indexedDB.databases()).
  await deleteDeviceDatabase();
  await clearSwHidden();
  try {
    const dbs = await indexedDB.databases?.();
    await Promise.all((dbs ?? []).map((d) => d.name ? new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(d.name!);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    }) : Promise.resolve()));
  } catch { /* not supported */ }
  try {
    if ('caches' in self) for (const k of await caches.keys()) await caches.delete(k);
  } catch { /* not supported */ }
  try {
    const regs = await navigator.serviceWorker?.getRegistrations();
    await Promise.all((regs ?? []).map((r) => r.unregister()));
  } catch { /* not supported */ }
  try { localStorage.clear(); } catch { /* blocked */ }
  try { sessionStorage.clear(); } catch { /* blocked */ }
  // Again, in case a pending open re-created it while the rest was being cleared.
  await deleteDeviceDatabase();
  await clearSwHidden();
}

let running: Promise<void> | null = null;

/** Wipe this device. No navigation happens here; the caller decides what the screen shows next. */
export function wipeThisDevice(): Promise<void> {
  running ??= (async () => {
    await within(dropPush(), 2500);
    await within(dropNative(), 3000);
    await within(signOut(), 2500);
    await dropStorage();
    // signOut() may have run while the native store was being cleared: clear it once more.
    if (isNative()) await within(import('../native/secure').then((m) => m.nativeSecure.clear()), 1500);
  })().finally(() => { running = null; });
  return running;
}
