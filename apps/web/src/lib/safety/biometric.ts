'use client';
// Biometric unlock in the Kithwall app (docs/v2/05-native.md §4). An alternative to typing the app PIN:
// a second copy of the AMK is kept under a Keystore / Keychain key that only opens after a strong
// biometric check (BiometricPrompt class 3 / Face ID or Touch ID), and is invalidated when the phone's
// biometrics are re-enrolled.
//
// It is a REAL unlock only. It never opens the decoy, and the duress PIN keeps working on the PIN pad:
// under pressure, type the duress PIN instead. Someone who can force a finger or a face onto the phone
// can open the real account, so people at that kind of risk should leave this off (the screen says so).
// Only offered while an app PIN is set; turning the PIN off turns this off too (lib/keys/device.ts).
import { getSession, amk as currentAmk, unlockWithDeviceAmk } from '../keys/session';
import { isNative } from '../native';
import { pinStore } from '../keys/device';
import { noteSuccess } from './limiter';

const secure = () => import('../native/secure');

export interface BioText { title: string; cancel: string }

export async function biometricSupport(): Promise<{ available: boolean; kind: 'face' | 'fingerprint' | 'iris' | 'biometric' | 'none' }> {
  if (!isNative()) return { available: false, kind: 'none' };
  const s = await (await secure()).biometricStatus();
  return { available: s.available && s.enrolled, kind: s.kind };
}

export async function biometricOn(): Promise<boolean> {
  const uid = getSession().userId;
  if (!isNative() || !uid) return false;
  return (await secure()).biometricEnabledFor(uid);
}

/** Turn biometric unlock on (needs the keys unlocked and an app PIN on this device). Prompts once. */
export async function enableBiometricUnlock(text: BioText): Promise<void> {
  const uid = getSession().userId;
  if (!uid) throw new Error('not signed in');
  if (!(await pinStore.has(uid))) throw new Error('pin_not_set');
  await (await secure()).enableBiometric(uid, currentAmk(), text);
}

export async function disableBiometricUnlock(): Promise<void> {
  await (await secure()).disableBiometric();
}

export type BioUnlockResult = 'ok' | 'cancelled' | 'invalidated' | 'lockout' | 'unavailable' | 'failed';

/** The lock screen's "Unlock with biometrics". */
export async function unlockWithBiometrics(text: BioText): Promise<BioUnlockResult> {
  const uid = getSession().userId;
  if (!uid || !isNative()) return 'unavailable';
  const s = await secure();
  let a: Uint8Array | null;
  try { a = await s.biometricAmk(uid, text); } catch (e) {
    const code = e instanceof s.BiometricError ? e.code : 'failed';
    return code === 'cancelled' || code === 'invalidated' || code === 'lockout' || code === 'unavailable' ? code : 'failed';
  }
  if (!a) return 'unavailable';
  await pinStore.attempts.save(uid, noteSuccess());
  await unlockWithDeviceAmk(a);
  a.fill(0);
  return 'ok';
}
