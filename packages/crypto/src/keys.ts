/**
 * Identity keys, the Account Master Key (AMK) and the key bundle (spec §3.1–3.4).
 *
 *   amkByPassword = wrap(passwordKEK, AMK,  aad "kithwall/v1/wrap/amk-password/<userId>")
 *   amkByRecovery = wrap(recoveryKEK, AMK,  aad "kithwall/v1/wrap/amk-recovery/<userId>")
 *   identityEnc   = wrap(identityKey, signPriv ‖ kxPriv, aad "kithwall/v1/wrap/identity/<userId>")
 *   recoveryKEK   = HKDF(RK,  "kithwall/v1/recovery-kek")
 *   identityKey   = HKDF(AMK, "kithwall/v1/identity-key")
 *   vaultKey      = HKDF(AMK, "kithwall/v1/vault")
 *   cacheKey      = HKDF(AMK, "kithwall/v1/cache")
 *   rkCommitment  = b64u(SHA-256("kithwall/v1/rk-commitment" ‖ RK))
 *
 * wrap = XChaCha20-Poly1305, packed as b64u(0x01 ‖ nonce ‖ ct).
 * RK is the 32-byte BIP-39 entropy of the 24-word recovery phrase.
 */
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { KithwallCryptoError, fail, invalid } from './errors';
import { assertBytes, assertString, b64u, concat, ctEqual, decodeFixed, randomBytes, utf8, wipe } from './encoding';
import { DEFAULT_KDF, type KdfParams, validateKdfParams } from './password';
import { KEY_LEN, edKeygen, edPublicKey, hkdfSha256, packDecrypt, packEncrypt, sha256, xKeygen, xPublicKey } from './primitives';

export interface Identity {
  signPub: Uint8Array;
  signPriv: Uint8Array;
  kxPub: Uint8Array;
  kxPriv: Uint8Array;
}

export interface KeyBundle {
  v: 1;
  kdf: KdfParams;
  signPub: string;
  kxPub: string;
  amkByPassword: string;
  amkByRecovery: string;
  identityEnc: string;
  rkCommitment: string;
}

export interface Unlocked {
  amk: Uint8Array;
  identity: Identity;
}

type WrapPurpose = 'amk-password' | 'amk-recovery' | 'identity';

/** Associated data for key wraps: "kithwall/v1/wrap/<purpose>/<userId>". */
export function wrapAad(purpose: WrapPurpose, userId: string): Uint8Array {
  assertString(userId, 'userId');
  return utf8(`kithwall/v1/wrap/${purpose}/${userId}`);
}

export function generateIdentity(): Identity {
  const s = edKeygen();
  const x = xKeygen();
  return { signPub: s.pub, signPriv: s.priv, kxPub: x.pub, kxPriv: x.priv };
}

export function deriveVaultKey(amk: Uint8Array): Uint8Array {
  assertBytes(amk, 'amk', KEY_LEN);
  return hkdfSha256(amk, 'kithwall/v1/vault');
}

export function deriveCacheKey(amk: Uint8Array): Uint8Array {
  assertBytes(amk, 'amk', KEY_LEN);
  return hkdfSha256(amk, 'kithwall/v1/cache');
}

function identityKey(amk: Uint8Array): Uint8Array {
  return hkdfSha256(amk, 'kithwall/v1/identity-key');
}

function recoveryKEK(rk: Uint8Array): Uint8Array {
  return hkdfSha256(rk, 'kithwall/v1/recovery-kek');
}

/** Commitment to RK stored in the bundle; lets a recovering device check a rebuilt RK. */
export function rkCommitmentOf(rk: Uint8Array): string {
  assertBytes(rk, 'rk', KEY_LEN);
  return b64u.encode(sha256(concat(utf8('kithwall/v1/rk-commitment'), rk)));
}

/** Constant-time check of RK against a stored commitment string. */
export function checkRkCommitment(rk: Uint8Array, commitment: string): boolean {
  let expected: Uint8Array;
  try {
    expected = decodeFixed(commitment, 'rkCommitment', 32);
  } catch {
    return false;
  }
  return ctEqual(b64u.decode(rkCommitmentOf(rk)), expected);
}

/** Trims, lower-cases and collapses whitespace; NFKD as BIP-39 requires. */
export function normalizePhrase(phrase: string): string {
  if (typeof phrase !== 'string') fail('bad_phrase', 'phrase must be a string');
  if (phrase.length > 1024) fail('bad_phrase', 'phrase too long');
  return phrase.normalize('NFKD').toLowerCase().trim().split(/\s+/u).join(' ');
}

/** RK (32 bytes) from a 24-word BIP-39 English phrase; `bad_phrase` on any problem. */
export function recoveryKeyFromPhrase(phrase: string): Uint8Array {
  const norm = normalizePhrase(phrase);
  if (norm.split(' ').length !== 24 || !validateMnemonic(norm, wordlist)) fail('bad_phrase', 'invalid recovery phrase');
  return mnemonicToEntropy(norm, wordlist);
}

function newRecovery(userId: string, amk: Uint8Array): { recoveryPhrase: string; amkByRecovery: string; rkCommitment: string; rk: Uint8Array } {
  const rk = randomBytes(KEY_LEN);
  const kek = recoveryKEK(rk);
  try {
    return {
      recoveryPhrase: entropyToMnemonic(rk, wordlist),
      amkByRecovery: packEncrypt(kek, amk, wrapAad('amk-recovery', userId)),
      rkCommitment: rkCommitmentOf(rk),
      rk,
    };
  } finally {
    wipe(kek);
  }
}

export function createKeyBundle(
  userId: string,
  passwordKEK: Uint8Array,
  kdf: KdfParams = DEFAULT_KDF,
): { bundle: KeyBundle; unlocked: Unlocked; recoveryPhrase: string } {
  assertString(userId, 'userId');
  assertBytes(passwordKEK, 'passwordKEK', KEY_LEN);
  // Bundles may carry reduced params in tests; the floor is enforced at derivation time.
  const params = validateKdfParams(kdf, { allowWeakParams: true });
  const amk = randomBytes(KEY_LEN);
  const identity = generateIdentity();
  const rec = newRecovery(userId, amk);
  wipe(rec.rk);
  const bundle: KeyBundle = {
    v: 1,
    kdf: params,
    signPub: b64u.encode(identity.signPub),
    kxPub: b64u.encode(identity.kxPub),
    amkByPassword: rewrapPassword(userId, amk, passwordKEK),
    amkByRecovery: rec.amkByRecovery,
    identityEnc: encryptIdentity(userId, amk, identity),
    rkCommitment: rec.rkCommitment,
  };
  return { bundle, unlocked: { amk, identity }, recoveryPhrase: rec.recoveryPhrase };
}

function encryptIdentity(userId: string, amk: Uint8Array, identity: Identity): string {
  const key = identityKey(amk);
  const pt = concat(identity.signPriv, identity.kxPriv);
  try {
    return packEncrypt(key, pt, wrapAad('identity', userId));
  } finally {
    wipe(key, pt);
  }
}

function validateBundle(bundle: KeyBundle): void {
  if (typeof bundle !== 'object' || bundle === null || bundle.v !== 1) invalid('unsupported key bundle');
  for (const f of ['signPub', 'kxPub', 'amkByPassword', 'amkByRecovery', 'identityEnc', 'rkCommitment'] as const) {
    if (typeof bundle[f] !== 'string') invalid(`bundle.${f} must be a string`);
  }
}

/**
 * Decrypts the identity keys and checks they match the bundle's public keys,
 * so a server cannot pair our private keys with substituted public keys.
 */
function openIdentity(userId: string, bundle: KeyBundle, amk: Uint8Array): Identity {
  const key = identityKey(amk);
  let pt: Uint8Array;
  try {
    pt = packDecrypt(key, bundle.identityEnc, wrapAad('identity', userId));
  } finally {
    wipe(key);
  }
  if (pt.length !== 2 * KEY_LEN) fail('decrypt_failed', 'malformed identity');
  const signPriv = pt.slice(0, KEY_LEN);
  const kxPriv = pt.slice(KEY_LEN);
  wipe(pt);
  const signPub = edPublicKey(signPriv);
  const kxPub = xPublicKey(kxPriv);
  let okSign = false;
  let okKx = false;
  try {
    okSign = ctEqual(signPub, b64u.decode(bundle.signPub));
    okKx = ctEqual(kxPub, b64u.decode(bundle.kxPub));
  } catch {
    // malformed public key fields fall through to the failure below
  }
  if (!okSign || !okKx) fail('decrypt_failed', 'bundle public keys do not match identity');
  return { signPub, signPriv, kxPub, kxPriv };
}

export function unlockWithPassword(userId: string, bundle: KeyBundle, passwordKEK: Uint8Array): Unlocked {
  assertString(userId, 'userId');
  assertBytes(passwordKEK, 'passwordKEK', KEY_LEN);
  validateBundle(bundle);
  let amk: Uint8Array;
  try {
    amk = packDecrypt(passwordKEK, bundle.amkByPassword, wrapAad('amk-password', userId));
  } catch (e) {
    if (e instanceof KithwallCryptoError && e.code === 'decrypt_failed') fail('bad_password', 'wrong password');
    throw e;
  }
  if (amk.length !== KEY_LEN) fail('decrypt_failed', 'malformed AMK');
  return { amk, identity: openIdentity(userId, bundle, amk) };
}

export function unlockWithRecoveryPhrase(userId: string, bundle: KeyBundle, phrase: string): Unlocked {
  assertString(userId, 'userId');
  validateBundle(bundle);
  const rk = recoveryKeyFromPhrase(phrase);
  try {
    return unlockWithRecoveryKey(userId, bundle, rk);
  } finally {
    wipe(rk);
  }
}

/**
 * Unlock with a raw RK (e.g. rebuilt from trusted-friend shares). RK is checked
 * against the bundle's commitment first; a mismatch is `bad_phrase`.
 */
export function unlockWithRecoveryKey(userId: string, bundle: KeyBundle, rk: Uint8Array): Unlocked {
  assertString(userId, 'userId');
  assertBytes(rk, 'rk', KEY_LEN);
  validateBundle(bundle);
  if (!checkRkCommitment(rk, bundle.rkCommitment)) fail('bad_phrase', 'recovery key does not match this account');
  const kek = recoveryKEK(rk);
  let amk: Uint8Array;
  try {
    amk = packDecrypt(kek, bundle.amkByRecovery, wrapAad('amk-recovery', userId));
  } finally {
    wipe(kek);
  }
  if (amk.length !== KEY_LEN) fail('decrypt_failed', 'malformed AMK');
  return { amk, identity: openIdentity(userId, bundle, amk) };
}

/**
 * Unlock with an AMK restored from a device-bound store ("keep me logged in").
 * Decrypts identityEnc and checks the keys against bundle.signPub / kxPub;
 * any failure or mismatch is `decrypt_failed`.
 */
export function unlockWithAmk(userId: string, bundle: KeyBundle, amk: Uint8Array): Unlocked {
  assertString(userId, 'userId');
  assertBytes(amk, 'amk', KEY_LEN);
  validateBundle(bundle);
  return { amk: new Uint8Array(amk), identity: openIdentity(userId, bundle, amk) };
}

/** New `amkByPassword` (password change, email change, or after recovery). */
export function rewrapPassword(userId: string, amk: Uint8Array, passwordKEK: Uint8Array): string {
  assertBytes(amk, 'amk', KEY_LEN);
  assertBytes(passwordKEK, 'passwordKEK', KEY_LEN);
  return packEncrypt(passwordKEK, amk, wrapAad('amk-password', userId));
}

/**
 * Fresh recovery phrase for the same AMK. The caller must replace both
 * `amkByRecovery` and `rkCommitment` in the stored bundle (and re-split RK to
 * trustees, then wipe `rk`); after that the old phrase no longer unlocks.
 */
export function rotateRecovery(userId: string, amk: Uint8Array): { recoveryPhrase: string; amkByRecovery: string; rkCommitment: string; rk: Uint8Array } {
  assertString(userId, 'userId');
  assertBytes(amk, 'amk', KEY_LEN);
  return newRecovery(userId, amk);
}
