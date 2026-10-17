/**
 * Thin, validated wrappers around the audited primitives. Internal module:
 * other modules go through these so that key lengths, nonce generation and
 * error mapping are handled in exactly one place.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { fail, invalid } from './errors';
import { assertBytes, b64u, concat, randomBytes, utf8 } from './encoding';

export const KEY_LEN = 32;
export const NONCE_LEN = 24;
export const TAG_LEN = 16;
export const SIG_LEN = 64;

/** Version byte prefixed to every packed symmetric blob (wraps, vault/cache blobs). */
const BLOB_VERSION = 1;

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

/** HKDF-SHA-256. `info` strings are always full "kithwall/v1/…" labels. */
export function hkdfSha256(ikm: Uint8Array, info: string | Uint8Array, length = KEY_LEN, salt?: Uint8Array): Uint8Array {
  assertBytes(ikm, 'ikm');
  if (ikm.length === 0) invalid('ikm must not be empty');
  return hkdf(nobleSha256, ikm, salt, typeof info === 'string' ? utf8(info) : info, length);
}

/** XChaCha20-Poly1305 with a fresh random 24-byte nonce. */
export function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): { nonce: Uint8Array; ct: Uint8Array } {
  assertBytes(key, 'key', KEY_LEN);
  assertBytes(plaintext, 'plaintext');
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return { nonce, ct };
}

/** XChaCha20-Poly1305 decryption; any failure is `decrypt_failed`. */
export function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array, aad: Uint8Array): Uint8Array {
  assertBytes(key, 'key', KEY_LEN);
  if (nonce.length !== NONCE_LEN || ct.length < TAG_LEN) fail('decrypt_failed', 'malformed ciphertext');
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ct);
  } catch {
    return fail('decrypt_failed', 'authentication failed');
  }
}

/** Encrypt and pack as base64url( 0x01 ‖ nonce(24) ‖ ciphertext+tag ). */
export function packEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): string {
  const { nonce, ct } = aeadEncrypt(key, plaintext, aad);
  return b64u.encode(concat(Uint8Array.of(BLOB_VERSION), nonce, ct));
}

/**
 * Inverse of packEncrypt. A string that is not a well-formed blob is reported
 * as `decrypt_failed` (it is stored data, so malformation means tampering).
 */
export function packDecrypt(key: Uint8Array, blob: string, aad: Uint8Array): Uint8Array {
  assertBytes(key, 'key', KEY_LEN);
  let raw: Uint8Array;
  try {
    raw = b64u.decode(blob);
  } catch {
    return fail('decrypt_failed', 'malformed blob');
  }
  if (raw.length < 1 + NONCE_LEN + TAG_LEN || raw[0] !== BLOB_VERSION) fail('decrypt_failed', 'malformed blob');
  return aeadDecrypt(key, raw.subarray(1, 1 + NONCE_LEN), raw.subarray(1 + NONCE_LEN), aad);
}

/** Ed25519 signature (RFC 8032, deterministic). */
export function edSign(message: Uint8Array, signPriv: Uint8Array): Uint8Array {
  assertBytes(signPriv, 'signPriv', KEY_LEN);
  return ed25519.sign(message, signPriv);
}

/**
 * Strict Ed25519 verification (RFC 8032 / non-ZIP-215: rejects non-canonical
 * encodings and malleable S). Never throws; returns false on any problem.
 */
export function edVerify(sig: Uint8Array, message: Uint8Array, signPub: Uint8Array): boolean {
  if (!(sig instanceof Uint8Array) || sig.length !== SIG_LEN) return false;
  if (!(signPub instanceof Uint8Array) || signPub.length !== KEY_LEN) return false;
  try {
    return ed25519.verify(sig, message, signPub, { zip215: false });
  } catch {
    return false;
  }
}

/** Decode a base64url signature and verify it; false on any decoding problem. */
export function edVerifyB64(sig: unknown, message: Uint8Array, signPub: Uint8Array): boolean {
  if (typeof sig !== 'string') return false;
  let raw: Uint8Array;
  try {
    raw = b64u.decode(sig);
  } catch {
    return false;
  }
  return edVerify(raw, message, signPub);
}

export function edPublicKey(signPriv: Uint8Array): Uint8Array {
  assertBytes(signPriv, 'signPriv', KEY_LEN);
  return ed25519.getPublicKey(signPriv);
}

export function edKeygen(): { pub: Uint8Array; priv: Uint8Array } {
  const priv = randomBytes(KEY_LEN);
  return { pub: ed25519.getPublicKey(priv), priv };
}

export function xKeygen(): { pub: Uint8Array; priv: Uint8Array } {
  const priv = randomBytes(KEY_LEN);
  return { pub: x25519.getPublicKey(priv), priv };
}

export function xPublicKey(kxPriv: Uint8Array): Uint8Array {
  assertBytes(kxPriv, 'kxPriv', KEY_LEN);
  return x25519.getPublicKey(kxPriv);
}

/**
 * X25519. noble rejects low-order public keys (all-zero shared secret); that is
 * reported as `invalid_input`.
 */
export function xShared(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  assertBytes(priv, 'X25519 private key', KEY_LEN);
  assertBytes(pub, 'X25519 public key', KEY_LEN);
  try {
    return x25519.getSharedSecret(priv, pub);
  } catch {
    return invalid('invalid X25519 public key');
  }
}
