/**
 * Symmetric blobs for vault / cache data (spec §3.13).
 *
 *   blob = b64u(0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(key, nonce, data, aad = "kithwall/v1/blob/" + aad))
 *
 * The fixed "kithwall/v1/blob/" prefix keeps blob AADs disjoint from key-wrap AADs
 * ("kithwall/v1/wrap/…") even when the same key were ever used for both.
 */
import { invalid } from './errors';
import { assertBytes, assertString, utf8 } from './encoding';
import { KEY_LEN, packDecrypt, packEncrypt } from './primitives';

/** Maximum blob plaintext (64 MiB). */
export const MAX_BLOB = 64 * 1024 * 1024;

function blobAad(aad: string): Uint8Array {
  assertString(aad, 'aad', 512);
  return utf8(`kithwall/v1/blob/${aad}`);
}

export function encryptBlob(key: Uint8Array, data: Uint8Array, aad: string): string {
  assertBytes(key, 'key', KEY_LEN);
  assertBytes(data, 'data');
  if (data.length > MAX_BLOB) invalid('blob too large');
  return packEncrypt(key, data, blobAad(aad));
}

/** Throws `decrypt_failed` on wrong key, wrong aad or any tampering. */
export function decryptBlob(key: Uint8Array, blob: string, aad: string): Uint8Array {
  assertBytes(key, 'key', KEY_LEN);
  return packDecrypt(key, blob, blobAad(aad));
}
