'use client';
// "Keep me logged in" (spec §3.13): the account master key is stored in IndexedDB,
// encrypted with a NON-EXTRACTABLE WebCrypto AES-GCM key that also lives in IndexedDB.
// Script on this origin can use the key but cannot export it. That is NOT protection at rest (security
// review C1): Chromium and Firefox store the raw bytes of non-extractable keys in the profile's
// IndexedDB files, so anyone with the device or a copy of its disk can recover the AMK while "keep me
// unlocked" is on. The UI says so (keys.rememberedBody). Logging out deletes both.
//
// Safety centre (docs/v2/03-safety.md): the app-PIN record ('pin') sits in the same database, again
// under its own non-extractable key, with the local attempt counter ('pin-attempts'). While an app PIN
// is set, the plain "remember me" AMK is never stored: every open of the app asks for the PIN.
//
// Inside the Kithwall app (docs/v2/05-native.md §4) the same three records ('amk', 'pin', 'pin-attempts')
// live in Keystore / Keychain-backed storage (lib/native/secure.ts) instead, never in the WebView's
// IndexedDB.
import type { PinWrap } from '../safety/pin';
import { isAttemptState, type AttemptState } from '../safety/limiter';
import { isNative } from '../native';

const native = () => import('../native/secure');

const DB = 'kithwall-device';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally { db.close(); }
}

export const deviceStore = {
  async save(userId: string, amk: Uint8Array): Promise<void> {
    // An app PIN replaces "keep me signed in": never keep an AMK that opens without the PIN.
    if (await pinStore.has(userId).catch(() => false)) return;
    if (isNative()) {
      const n = await native();
      await n.nativeSetJson('amk', { userId, amk: n.toB64(amk), at: Date.now() });
      return;
    }
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`kithwall/v1/device/${userId}`) },
      key, amk as BufferSource);
    await tx('readwrite', (s) => s.put({ userId, key, iv, ct, at: Date.now() }, 'amk'));
  },
  async load(userId: string): Promise<Uint8Array | null> {
    if (isNative()) {
      const n = await native();
      const r = await n.nativeGetJson<{ userId: string; amk: string }>('amk');
      return r && r.userId === userId ? n.fromB64(r.amk) : null;
    }
    const rec = await tx<{ userId: string; key: CryptoKey; iv: Uint8Array; ct: ArrayBuffer } | undefined>(
      'readonly', (s) => s.get('amk'));
    if (!rec || rec.userId !== userId) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: rec.iv as BufferSource, additionalData: new TextEncoder().encode(`kithwall/v1/device/${userId}`) },
      rec.key, rec.ct);
    return new Uint8Array(pt);
  },
  async clear(): Promise<void> {
    if (isNative()) { await (await native()).nativeSecure.remove('amk').catch(() => undefined); return; }
    await tx('readwrite', (s) => s.delete('amk')).catch(() => undefined);
  },
};

// ---------------------------------------------------------------------------------------------
// App PIN record (Safety centre)

export type DuressAction = 'none' | 'wipe';

export interface PinRecord {
  userId: string;
  wrap: PinWrap;
  /** What a duress PIN does besides opening the decoy. */
  duressAction: DuressAction;
  /** Display name shown on the decoy profile (empty: the public @handle). */
  decoyName: string;
  /** The account's public @handle, for the decoy profile (no keys are loaded in decoy mode). */
  handle: string;
  /** Wipe this device after this many wrong PINs in a row (null: never). */
  wipeAfter: number | null;
}

async function sealRecord(value: unknown, aad: string) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key, new TextEncoder().encode(JSON.stringify(value)) as BufferSource);
  return { key, iv, ct };
}

async function openRecord<T>(rec: { key: CryptoKey; iv: Uint8Array; ct: ArrayBuffer }, aad: string): Promise<T> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as BufferSource, additionalData: new TextEncoder().encode(aad) }, rec.key, rec.ct);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

const pinAad = (userId: string) => `kithwall/v1/device-pin/${userId}`;

export const pinStore = {
  async save(rec: PinRecord): Promise<void> {
    if (isNative()) {
      const n = await native();
      await n.nativeSetJson('pin', rec);
      await n.nativeSecure.remove('amk').catch(() => undefined);
      return;
    }
    const sealed = await sealRecord(rec, pinAad(rec.userId));
    await tx('readwrite', (s) => s.put({ userId: rec.userId, ...sealed, at: Date.now() }, 'pin'));
    // The PIN now guards this device: drop any AMK kept by "keep me signed in".
    await tx('readwrite', (s) => s.delete('amk')).catch(() => undefined);
  },
  async load(userId: string): Promise<PinRecord | null> {
    if (isNative()) {
      const r = await (await native()).nativeGetJson<PinRecord>('pin');
      return r && r.userId === userId ? r : null;
    }
    const rec = await tx<{ userId: string; key: CryptoKey; iv: Uint8Array; ct: ArrayBuffer } | undefined>('readonly', (s) => s.get('pin'));
    if (!rec || rec.userId !== userId) return null;
    return openRecord<PinRecord>(rec, pinAad(userId));
  },
  /** Is an app PIN set on this device for this account? (no decryption) */
  async has(userId: string): Promise<boolean> {
    if (isNative()) return (await pinStore.load(userId)) !== null;
    const rec = await tx<{ userId: string } | undefined>('readonly', (s) => s.get('pin'));
    return !!rec && rec.userId === userId;
  },
  async clear(): Promise<void> {
    if (isNative()) {
      const n = await native();
      await n.nativeSecure.remove('pin').catch(() => undefined);
      await n.nativeSecure.remove('pin-attempts').catch(() => undefined);
      // Biometric unlock is an alternative to the PIN: it goes with it.
      await n.disableBiometric().catch(() => undefined);
      return;
    }
    await tx('readwrite', (s) => s.delete('pin')).catch(() => undefined);
    await tx('readwrite', (s) => s.delete('pin-attempts')).catch(() => undefined);
  },
  attempts: {
    async load(userId: string): Promise<AttemptState> {
      if (isNative()) {
        const r = await (await native()).nativeGetJson<{ userId: string; state: unknown }>('pin-attempts').catch(() => null);
        return r && r.userId === userId && isAttemptState(r.state) ? r.state : { failures: 0, lockedUntil: 0 };
      }
      const rec = await tx<{ userId: string; state: unknown } | undefined>('readonly', (s) => s.get('pin-attempts')).catch(() => undefined);
      return rec && rec.userId === userId && isAttemptState(rec.state) ? rec.state : { failures: 0, lockedUntil: 0 };
    },
    async save(userId: string, state: AttemptState): Promise<void> {
      if (isNative()) { await (await native()).nativeSetJson('pin-attempts', { userId, state }); return; }
      await tx('readwrite', (s) => s.put({ userId, state }, 'pin-attempts'));
    },
  },
};

/** Delete this database outright (panic wipe). */
export function deleteDeviceDatabase(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
}
