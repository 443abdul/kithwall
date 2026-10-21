// App PIN and duress PIN (docs/v2/03-safety.md §2). Pure crypto, no browser APIs: unit-tested in Node.
//
//   pinKey  = HKDF(Argon2id(PIN, salt), "kithwall/v1/kek")        (deriveFromPassword with a per-device
//                                                                  random salt string in place of the email)
//   amk     = encryptBlob(pinKey(PIN), AMK, "kithwall/v1/app-pin/amk/<userId>")
//   duress  = encryptBlob(pinKey(duressPIN), "duress", "kithwall/v1/app-pin/duress/<userId>")
//             — or the same thing under a random key when no duress PIN is set, so the record looks
//               the same either way.
//
// The whole PinWrap is then encrypted again on the device with a NON-EXTRACTABLE WebCrypto key
// (lib/keys/device.ts pinStore). That stops other web pages and a copy of the PIN record alone, but NOT
// someone with the whole device or a disk image (security review C1): browsers keep the raw bytes of
// "non-extractable" keys in their profile files, so such an attacker can unwrap the outer layer, skip the
// attempt limiter and guess the PIN offline, and can tell the real PIN from the duress PIN. The only
// defence there is the PIN's own strength times the Argon2id cost below, which is why new PINs use a
// heavier setting than account passwords and the UI asks for 8+ digits (docs/v2/03-safety.md §8).
//
// Entering a PIN costs one Argon2id run whatever the outcome: the duress check is a cheap decryption
// under the same derived key, so a real unlock, a duress unlock and a wrong PIN take the same time.
import { b64u, decryptBlob, deriveFromPassword, encryptBlob, randomBytes, type KdfParams } from '@kithwall/crypto';

export const PIN_MIN = 6;
export const PIN_MAX = 16;
/** Length the UI recommends: each extra digit multiplies an offline guesser's work by 10. */
export const PIN_RECOMMENDED = 8;

/**
 * Argon2id for NEW app PINs: 128 MiB, 3 passes (twice the memory, so twice the time and memory per guess,
 * of the account password default). Existing wraps keep the parameters they were made with (stored in
 * the wrap; changing them would invalidate the duress verifier), so they upgrade when the PIN is set up
 * again.
 */
export const PIN_KDF: KdfParams = Object.freeze({ alg: 'argon2id', v: 1, m: 131072, t: 3, p: 1 }) as KdfParams;

export interface PinWrap {
  v: 1;
  /** Random per device (and kept across PIN changes so the duress verifier stays valid). */
  salt: string;
  kdf: KdfParams;
  /** The AMK under the app PIN. */
  amk: string;
  /** Duress verifier (or an indistinguishable decoy when no duress PIN is set). */
  duress: string;
}

export type PinOutcome = { kind: 'real'; amk: Uint8Array } | { kind: 'duress' } | { kind: 'wrong' };

export interface PinOptions {
  /** Tests only: allows Argon2id parameters below the security floor. */
  allowWeakParams?: boolean;
  kdf?: KdfParams;
}

export type PinProblem = 'short' | 'long' | 'digits' | 'simple';

/** Digits only, PIN_MIN..PIN_MAX long, and not a trivial pattern (000000, 123456, 654321). */
export function pinProblem(pin: string): PinProblem | null {
  if (!/^\d*$/.test(pin)) return 'digits';
  if (pin.length < PIN_MIN) return 'short';
  if (pin.length > PIN_MAX) return 'long';
  const d = [...pin].map(Number);
  const same = d.every((x) => x === d[0]);
  const up = d.every((x, i) => i === 0 || x === (d[i - 1] + 1) % 10);
  const down = d.every((x, i) => i === 0 || x === (d[i - 1] + 9) % 10);
  return same || up || down ? 'simple' : null;
}

const aadAmk = (userId: string) => `kithwall/v1/app-pin/amk/${userId}`;
const aadDuress = (userId: string) => `kithwall/v1/app-pin/duress/${userId}`;
const DURESS_MARK = new TextEncoder().encode('duress');

async function pinKey(pin: string, salt: string, kdf: KdfParams, opts: PinOptions): Promise<Uint8Array> {
  const { passwordKEK } = await deriveFromPassword(`kithwall/v1/app-pin/${salt}`, pin, kdf, { allowWeakParams: !!opts.allowWeakParams });
  return passwordKEK;
}

function tryDecrypt(key: Uint8Array, blob: string, aad: string): Uint8Array | null {
  try { return decryptBlob(key, blob, aad); } catch { return null; }
}

/**
 * Wrap the AMK under a (new) app PIN. Pass `previous` to change the PIN while keeping the salt and the
 * duress verifier; the new PIN must then differ from the duress PIN.
 */
export async function createPinWrap(userId: string, amk: Uint8Array, pin: string, opts: PinOptions = {}, previous?: PinWrap): Promise<PinWrap> {
  const problem = pinProblem(pin);
  if (problem) throw new Error(`pin_${problem}`);
  const salt = previous?.salt ?? b64u.encode(randomBytes(16));
  const kdf = previous?.kdf ?? opts.kdf ?? PIN_KDF;
  const k = await pinKey(pin, salt, kdf, opts);
  try {
    if (previous && tryDecrypt(k, previous.duress, aadDuress(userId))) throw new Error('pin_same_as_duress');
    return {
      v: 1, salt, kdf,
      amk: encryptBlob(k, amk, aadAmk(userId)),
      duress: previous?.duress ?? encryptBlob(randomBytes(32), DURESS_MARK, aadDuress(userId)),
    };
  } finally { k.fill(0); }
}

/** Set (or with null, clear) the duress PIN. It must differ from the app PIN. */
export async function setDuressPin(userId: string, wrap: PinWrap, duressPin: string | null, opts: PinOptions = {}): Promise<PinWrap> {
  if (duressPin === null) return { ...wrap, duress: encryptBlob(randomBytes(32), DURESS_MARK, aadDuress(userId)) };
  const problem = pinProblem(duressPin);
  if (problem) throw new Error(`pin_${problem}`);
  const k = await pinKey(duressPin, wrap.salt, wrap.kdf, opts);
  try {
    const opened = tryDecrypt(k, wrap.amk, aadAmk(userId));
    if (opened) { opened.fill(0); throw new Error('pin_same_as_app_pin'); }
    return { ...wrap, duress: encryptBlob(k, DURESS_MARK, aadDuress(userId)) };
  } finally { k.fill(0); }
}

/** Check a PIN: the real one opens the AMK, the duress one says so, anything else is wrong. */
export async function openPinWrap(userId: string, wrap: PinWrap, pin: string, opts: PinOptions = {}): Promise<PinOutcome> {
  if (!/^\d{1,32}$/.test(pin)) return { kind: 'wrong' };
  const k = await pinKey(pin, wrap.salt, wrap.kdf, opts);
  try {
    const amk = tryDecrypt(k, wrap.amk, aadAmk(userId));
    const duress = tryDecrypt(k, wrap.duress, aadDuress(userId));
    if (amk) return { kind: 'real', amk };
    if (duress) return { kind: 'duress' };
    return { kind: 'wrong' };
  } finally { k.fill(0); }
}

export function isPinWrap(v: unknown): v is PinWrap {
  const w = v as PinWrap | null;
  return !!w && w.v === 1 && typeof w.salt === 'string' && typeof w.amk === 'string' && typeof w.duress === 'string'
    && typeof w.kdf === 'object' && w.kdf !== null;
}
