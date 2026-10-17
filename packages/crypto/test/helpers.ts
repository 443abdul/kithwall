import { expect } from 'vitest';
import { KithwallCryptoError, b64u, type KdfParams, type KithwallCryptoErrorCode } from '../src/index';

export const FAST_KDF: KdfParams = { alg: 'argon2id', v: 1, m: 256, t: 1, p: 1 };
export const WEAK = { allowWeakParams: true } as const;

export function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function expectCode(fn: () => unknown, code: KithwallCryptoErrorCode): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, `expected KithwallCryptoError(${code})`).toBeInstanceOf(KithwallCryptoError);
  expect((err as KithwallCryptoError).code).toBe(code);
}

export async function expectCodeAsync(fn: () => Promise<unknown>, code: KithwallCryptoErrorCode): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err, `expected KithwallCryptoError(${code})`).toBeInstanceOf(KithwallCryptoError);
  expect((err as KithwallCryptoError).code).toBe(code);
}

/** Returns a copy of a base64url string with one bit of byte `i` flipped. */
export function flipB64(s: string, i: number): string {
  const b = b64u.decode(s);
  b[i] = b[i]! ^ 0x01;
  return b64u.encode(b);
}

export function flipBytes(b: Uint8Array, i: number): Uint8Array {
  const c = new Uint8Array(b);
  c[i] = c[i]! ^ 0x01;
  return c;
}

export function b64Len(s: string): number {
  return b64u.decode(s).length;
}
