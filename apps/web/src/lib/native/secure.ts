'use client';
// Keystore / Keychain-backed storage for the device secrets in lib/keys/device.ts when running in the app
// (docs/v2/05-native.md §4). In a browser those records sit in IndexedDB under a non-extractable WebCrypto
// key; in the app they are encrypted by a hardware-backed, non-exportable key instead (Android Keystore,
// StrongBox when present; iOS Keychain, this-device-only, excluded from backups), so a copy of the app's
// data directory is useless on any other device.
//
// Biometric unlock keeps a second copy of the AMK under a key that only opens after a strong biometric
// check. It is a REAL unlock only: the duress PIN stays on the PIN pad, and biometrics never open the decoy.
import { nativeErrorCode, nativePlugin } from './index';

export const nativeSecure = {
  async get(key: string): Promise<string | null> {
    return (await (await nativePlugin('KithwallSecure')).get({ key })).value ?? null;
  },
  async set(key: string, value: string): Promise<void> {
    await (await nativePlugin('KithwallSecure')).set({ key, value });
  },
  async remove(key: string): Promise<void> {
    await (await nativePlugin('KithwallSecure')).remove({ key });
  },
  async clear(): Promise<void> {
    await (await nativePlugin('KithwallSecure')).clear();
  },
};

/** JSON helpers (records are small: an AMK, a PIN wrap, an attempt counter). */
export async function nativeGetJson<T>(key: string): Promise<T | null> {
  const v = await nativeSecure.get(key);
  if (!v) return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}
export function nativeSetJson(key: string, value: unknown): Promise<void> {
  return nativeSecure.set(key, JSON.stringify(value));
}

export const toB64 = (b: Uint8Array): string => { let s = ''; b.forEach((x) => { s += String.fromCharCode(x); }); return btoa(s); };
export const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------------------------------------
// Biometric unlock

const BIO_KEY = 'bio-amk';
const BIO_USER = 'bio-user';

export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'biometric' | 'none';

export async function biometricStatus(): Promise<{ available: boolean; enrolled: boolean; kind: BiometricKind }> {
  try { return await (await nativePlugin('KithwallSecure')).biometricStatus(); } catch { return { available: false, enrolled: false, kind: 'none' }; }
}

/** Is biometric unlock set up on this device for this account? (no prompt) */
export async function biometricEnabledFor(userId: string): Promise<boolean> {
  try { return (await nativeSecure.get(BIO_USER)) === userId; } catch { return false; }
}

export class BiometricError extends Error {
  constructor(public code: string) { super(code); }
}

/** Store the AMK behind biometrics (prompts once: the key must be unlocked to encrypt). */
export async function enableBiometric(userId: string, amk: Uint8Array, text: { title: string; cancel: string }): Promise<void> {
  try {
    await (await nativePlugin('KithwallSecure')).bioSet({ key: BIO_KEY, value: JSON.stringify({ userId, amk: toB64(amk) }), ...text });
    await nativeSecure.set(BIO_USER, userId);
  } catch (e) { throw new BiometricError(nativeErrorCode(e) || 'failed'); }
}

/** Prompt and return the AMK, or null if biometric unlock isn't set up for this account. */
export async function biometricAmk(userId: string, text: { title: string; cancel: string }): Promise<Uint8Array | null> {
  let raw: string | null;
  try {
    raw = (await (await nativePlugin('KithwallSecure')).bioGet({ key: BIO_KEY, ...text })).value;
  } catch (e) {
    const code = nativeErrorCode(e) || 'failed';
    // New fingerprints / faces were enrolled: the key is gone for good. Turn biometric unlock off.
    if (code === 'invalidated') await disableBiometric().catch(() => undefined);
    throw new BiometricError(code);
  }
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as { userId?: string; amk?: string };
    return rec.userId === userId && rec.amk ? fromB64(rec.amk) : null;
  } catch { return null; }
}

export async function disableBiometric(): Promise<void> {
  const p = await nativePlugin('KithwallSecure');
  await p.bioRemove({ key: BIO_KEY }).catch(() => undefined);
  await nativeSecure.remove(BIO_USER).catch(() => undefined);
}
