/**
 * Password stretching (spec §3.1–3.3).
 *
 *   salt       = SHA-256("kithwall/v1/salt" ‖ NFKC(lowercase(trim(email))))[0..16]
 *   stretched  = Argon2id(NFKC(password), salt, m, t, p, 32 bytes)
 *   authKey    = b64u(HKDF-SHA-256(stretched, info "kithwall/v1/auth", 32))   → Supabase password
 *   passwordKEK= HKDF-SHA-256(stretched, info "kithwall/v1/kek", 32)          → never leaves device
 */
import { argon2id } from 'hash-wasm';
import { invalid } from './errors';
import { b64u, concat, utf8, wipe } from './encoding';
import { hkdfSha256, sha256 } from './primitives';

export interface KdfParams {
  alg: 'argon2id';
  v: 1;
  /** Memory in KiB. */
  m: number;
  /** Passes. */
  t: number;
  /** Lanes. */
  p: number;
}

export const DEFAULT_KDF: KdfParams = Object.freeze({ alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 }) as KdfParams;

/** Parameters below this floor are refused unless `allowWeakParams` is set (tests only). */
export const MIN_KDF = Object.freeze({ m: 65536, t: 3 });
/** Upper bounds so that a hostile server-supplied KdfParams cannot exhaust the device. */
export const MAX_KDF = Object.freeze({ m: 1048576, t: 16, p: 4 });

export interface DeriveOptions {
  /**
   * Accept parameters below MIN_KDF. For tests only: authKey is sent to the
   * server, so weak parameters would let the server brute-force the password.
   */
  allowWeakParams?: boolean;
}

/** Validates KdfParams (structure, bounds and, unless allowed, the security floor). */
export function validateKdfParams(params: KdfParams, opts: DeriveOptions = {}): KdfParams {
  if (typeof params !== 'object' || params === null) invalid('kdf params must be an object');
  const { alg, v, m, t, p } = params;
  if (alg !== 'argon2id' || v !== 1) invalid('unsupported kdf');
  for (const [name, val] of [['m', m], ['t', t], ['p', p]] as const) {
    if (!Number.isSafeInteger(val) || val < 1) invalid(`kdf.${name} must be a positive integer`);
  }
  if (p > MAX_KDF.p || t > MAX_KDF.t || m > MAX_KDF.m) invalid('kdf params exceed maximum');
  if (m < 8 * p) invalid('kdf.m must be at least 8 * p');
  if (!opts.allowWeakParams && (m < MIN_KDF.m || t < MIN_KDF.t)) invalid('kdf params below security floor');
  return { alg, v, m, t, p };
}

/** Email → canonical form used for the salt. */
export function normalizeEmail(email: string): string {
  if (typeof email !== 'string') invalid('email must be a string');
  const e = email.trim().toLowerCase().normalize('NFKC');
  if (e.length === 0 || e.length > 320) invalid('email must be 1..320 characters');
  return e;
}

/** First 16 bytes of SHA-256("kithwall/v1/salt" ‖ normalized email). */
export function passwordSalt(email: string): Uint8Array {
  return sha256(concat(utf8('kithwall/v1/salt'), utf8(normalizeEmail(email)))).slice(0, 16);
}

/** Maximum password length in UTF-16 code units, to bound work. */
const MAX_PASSWORD = 1024;

export async function deriveFromPassword(
  email: string,
  password: string,
  params: KdfParams = DEFAULT_KDF,
  opts: DeriveOptions = {},
): Promise<{ authKey: string; passwordKEK: Uint8Array }> {
  const kdf = validateKdfParams(params, opts);
  const salt = passwordSalt(email);
  if (typeof password !== 'string' || password.length === 0) invalid('password must be a non-empty string');
  if (password.length > MAX_PASSWORD) invalid('password too long');
  // NFKC so the same password typed on different keyboards/OSes derives the same key.
  const pw = utf8(password.normalize('NFKC'));
  const stretched = await argon2id({
    password: pw,
    salt,
    iterations: kdf.t,
    memorySize: kdf.m,
    parallelism: kdf.p,
    hashLength: 32,
    outputType: 'binary',
  });
  try {
    const authKey = b64u.encode(hkdfSha256(stretched, 'kithwall/v1/auth'));
    const passwordKEK = hkdfSha256(stretched, 'kithwall/v1/kek');
    return { authKey, passwordKEK };
  } finally {
    wipe(stretched, pw);
  }
}
