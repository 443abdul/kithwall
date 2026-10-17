/**
 * Chunked file encryption (spec §3.11).
 *
 *   ciphertext = 0x01 ‖ prefix(16 random bytes) ‖ chunk_0 ‖ … ‖ chunk_{N-1}
 *   chunk_i    = XChaCha20-Poly1305(fileKey, nonce_i, pt_i, aad_i)          (64 KiB plaintext, +16-byte tag)
 *   nonce_i    = prefix ‖ u64be(i)
 *   aad_i      = "kithwall/v1/file\n" ‖ u64be(i) ‖ final_i (0x00 | 0x01) ‖ utf8(fileId)
 *
 * There is always at least one chunk (an empty file is one empty final chunk),
 * and exactly the last chunk has final = 1. Truncation, extension, reordering,
 * splicing between files or a different fileId all fail authentication.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { fail, invalid } from './errors';
import { assertBytes, assertString, concat, randomBytes, u64be, utf8 } from './encoding';
import { KEY_LEN, TAG_LEN } from './primitives';

export const FILE_CHUNK_SIZE = 64 * 1024;
const FILE_VERSION = 1;
const PREFIX_LEN = 16;
const HEADER_LEN = 1 + PREFIX_LEN;
/** Maximum plaintext size (512 MiB): photos are ≤20 MB, video comes later. */
export const MAX_FILE_SIZE = 512 * 1024 * 1024;

function chunkNonce(prefix: Uint8Array, i: number): Uint8Array {
  return concat(prefix, u64be(i));
}

function chunkAad(fileId: string, i: number, final: boolean): Uint8Array {
  return concat(utf8('kithwall/v1/file\n'), u64be(i), Uint8Array.of(final ? 1 : 0), utf8(fileId));
}

export function encryptFile(data: Uint8Array, fileId: string): { key: Uint8Array; ciphertext: Uint8Array } {
  assertBytes(data, 'data');
  assertString(fileId, 'fileId');
  if (data.length > MAX_FILE_SIZE) invalid('file too large');
  const key = randomBytes(KEY_LEN);
  const prefix = randomBytes(PREFIX_LEN);
  const chunks = Math.max(1, Math.ceil(data.length / FILE_CHUNK_SIZE));
  const out = new Uint8Array(HEADER_LEN + data.length + chunks * TAG_LEN);
  out[0] = FILE_VERSION;
  out.set(prefix, 1);
  let o = HEADER_LEN;
  for (let i = 0; i < chunks; i++) {
    const pt = data.subarray(i * FILE_CHUNK_SIZE, Math.min(data.length, (i + 1) * FILE_CHUNK_SIZE));
    const ct = xchacha20poly1305(key, chunkNonce(prefix, i), chunkAad(fileId, i, i === chunks - 1)).encrypt(pt);
    out.set(ct, o);
    o += ct.length;
  }
  return { key, ciphertext: out };
}

export function decryptFile(ciphertext: Uint8Array, key: Uint8Array, fileId: string): Uint8Array {
  assertBytes(ciphertext, 'ciphertext');
  assertBytes(key, 'key', KEY_LEN);
  assertString(fileId, 'fileId');
  if (ciphertext.length < HEADER_LEN + TAG_LEN || ciphertext[0] !== FILE_VERSION) fail('decrypt_failed', 'malformed file');
  const prefix = ciphertext.subarray(1, HEADER_LEN);
  const body = ciphertext.subarray(HEADER_LEN);
  const sealedChunk = FILE_CHUNK_SIZE + TAG_LEN;
  const chunks = Math.ceil(body.length / sealedChunk);
  const lastLen = body.length - (chunks - 1) * sealedChunk;
  if (lastLen < TAG_LEN) fail('decrypt_failed', 'malformed file');
  const out = new Uint8Array(body.length - chunks * TAG_LEN);
  for (let i = 0; i < chunks; i++) {
    const ct = body.subarray(i * sealedChunk, Math.min(body.length, (i + 1) * sealedChunk));
    let pt: Uint8Array;
    try {
      pt = xchacha20poly1305(key, chunkNonce(prefix, i), chunkAad(fileId, i, i === chunks - 1)).decrypt(ct);
    } catch {
      out.fill(0);
      return fail('decrypt_failed', 'file chunk failed authentication');
    }
    out.set(pt, i * FILE_CHUNK_SIZE);
  }
  return out;
}
