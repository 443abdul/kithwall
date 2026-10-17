/**
 * Trusted-friend recovery (spec §3.5).
 *
 * - RK is split with Shamir over GF(2^8) (shamir-secret-sharing). Each share is
 *   33 bytes: 32 bytes of share data followed by its x-coordinate. Shares are
 *   delivered with seal() using context "recovery-share/<ownerId>/<trusteeId>"
 *   (or similar), so they are encrypted to the trustee and signed by the owner.
 * - Combining checks the rebuilt RK against the bundle's rkCommitment in constant time.
 * - The verification phrase is 6 BIP-39 words taken from the first 66 bits of
 *   SHA-256(lp("kithwall/v1/verification-phrase", requestId, ephPub)).
 */
import { combine, split } from 'shamir-secret-sharing';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { fail, invalid } from './errors';
import { assertBytes, assertString, lp, wipe } from './encoding';
import { checkRkCommitment } from './keys';
import { KEY_LEN, sha256, xKeygen } from './primitives';

export const SHARE_LEN = KEY_LEN + 1;
export const MIN_TRUSTEES = 2;
export const MAX_TRUSTEES = 5;

export async function splitRecoveryKey(rk: Uint8Array, n: number, k: number): Promise<Uint8Array[]> {
  assertBytes(rk, 'rk', KEY_LEN);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || k < MIN_TRUSTEES || k > n || n > MAX_TRUSTEES) {
    invalid('need integers with 2 <= k <= n <= 5');
  }
  // The library checks `constructor === Uint8Array`, so pass plain copies.
  return split(new Uint8Array(rk), n, k);
}

export async function combineRecoveryShares(shares: Uint8Array[], rkCommitment: string): Promise<Uint8Array> {
  if (!Array.isArray(shares) || shares.length < MIN_TRUSTEES || shares.length > MAX_TRUSTEES) {
    invalid('need between 2 and 5 shares');
  }
  const xs = new Set<number>();
  for (const s of shares) {
    if (!(s instanceof Uint8Array) || s.length !== SHARE_LEN) fail('bad_share', 'share has wrong length');
    const x = s[SHARE_LEN - 1]!;
    if (x === 0 || xs.has(x)) fail('bad_share', 'duplicate or invalid share');
    xs.add(x);
  }
  let rk: Uint8Array;
  try {
    rk = await combine(shares.map((s) => new Uint8Array(s)));
  } catch {
    return fail('bad_share', 'shares could not be combined');
  }
  if (rk.length !== KEY_LEN || !checkRkCommitment(rk, rkCommitment)) {
    wipe(rk);
    fail('bad_share', 'recombined key does not match commitment');
  }
  return rk;
}

/** Ephemeral X25519 key pair for a recovery request (E in spec §3.5). */
export function generateEphemeral(): { pub: Uint8Array; priv: Uint8Array } {
  return xKeygen();
}

/** 6 BIP-39 words that the trustee and the owner compare out of band. */
export function verificationPhrase(requestId: string, ephPub: Uint8Array): string[] {
  assertString(requestId, 'requestId');
  assertBytes(ephPub, 'ephPub', KEY_LEN);
  const h = sha256(lp('kithwall/v1/verification-phrase', requestId, ephPub));
  const words: string[] = [];
  // Read 6 × 11 bits, most significant bit first.
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (words.length < 6) {
    acc = ((acc << 8) | h[i++]!) & 0xffffff;
    bits += 8;
    if (bits >= 11) {
      bits -= 11;
      words.push(wordlist[(acc >> bits) & 0x7ff]!);
    }
  }
  return words;
}
