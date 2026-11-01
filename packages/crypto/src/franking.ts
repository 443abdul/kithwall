/**
 * Message franking: abuse reports that can't be forged by the reporter or denied by the sender, while the
 * server still learns nothing about messages nobody reports. After Facebook's Messenger "Secret
 * Conversations" design and Grubbs, Lu & Ristenpart, "Message Franking via Committing Authenticated
 * Encryption" (CRYPTO 2017), with the attachment lesson of Dodis, Grubbs, Ristenpart & Woodage, "Fast
 * Message Franking: From Invisible Salamanders to Encryptment" (CRYPTO 2018).
 *
 *   fk     = fresh 32-byte franking key for every message (and every edit), carried INSIDE the sealed payload
 *   body   = canonicalJson({ v: 1, conv, id, sender, payload })     payload = the message payload without fk
 *   commit = HMAC-SHA-256(fk, "kithwall/v1/frank\n" ‖ utf8(body))    sent next to the ciphertext (32 bytes)
 *
 * The commitment is computed over the plaintext, not the ciphertext, so it doesn't matter that the AEAD
 * underneath (XChaCha20-Poly1305) isn't key-committing: a report carries the plaintext and fk, and the
 * recipient checked that very plaintext against `commit` when the message arrived. Attachments are bound by
 * their file reference, which includes the file key and the SHA-256 of the stored ciphertext
 * (`fileDigest`), so a sender can't swap the file behind a path after sending it.
 *
 * The database binds `commit` to the sender, conversation, message id and its own clock with a second
 * HMAC under a key only it holds (supabase/migrations/20261102000600_message_franking.sql), and checks both
 * when a report arrives. HMAC-SHA-256 keyed with a uniformly random 32-byte key is a PRF, so `commit`
 * reveals nothing about the message to the server, and it is binding: finding a second (fk', body') with the
 * same tag means finding a SHA-256 collision.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { invalid } from './errors';
import { assertBytes, assertString, b64u, canonicalJson, concat, ctEqual, randomBytes, utf8 } from './encoding';
import { KEY_LEN, sha256 } from './primitives';

const FRANK_DOMAIN = 'kithwall/v1/frank\n';

/** A fresh franking key (one per message and per edit; never reused). */
export function newFrankingKey(): Uint8Array {
  return randomBytes(KEY_LEN);
}

/** The exact string a franking commitment covers. `payload` must not contain the franking key. */
export function frankingBody(m: { conversationId: string; messageId: string; senderId: string; payload: unknown }): string {
  assertString(m.conversationId, 'conversationId');
  assertString(m.messageId, 'messageId');
  assertString(m.senderId, 'senderId');
  if (typeof m.payload !== 'object' || m.payload === null || Array.isArray(m.payload)) invalid('payload must be an object');
  return canonicalJson({ v: 1, conv: m.conversationId, id: m.messageId, sender: m.senderId, payload: m.payload });
}

function mac(fk: Uint8Array, body: string): Uint8Array {
  return hmac(nobleSha256, fk, concat(utf8(FRANK_DOMAIN), utf8(body)));
}

/** commit = HMAC-SHA-256(fk, "kithwall/v1/frank\n" ‖ body), base64url (43 characters). */
export function frankCommit(fk: Uint8Array, body: string): string {
  assertBytes(fk, 'franking key', KEY_LEN);
  if (typeof body !== 'string') invalid('body must be a string');
  return b64u.encode(mac(fk, body));
}

/**
 * True when `commit` is the franking commitment of `body` under `fk`. Never throws: anything malformed
 * (wrong length, bad base64url, a missing value) is simply false. Constant-time comparison.
 */
export function frankMatches(fk: unknown, body: unknown, commit: unknown): boolean {
  if (typeof body !== 'string' || typeof commit !== 'string') return false;
  let key: Uint8Array, want: Uint8Array;
  try {
    key = fk instanceof Uint8Array ? fk : b64u.decode(fk as string);
    want = b64u.decode(commit);
  } catch {
    return false;
  }
  if (key.length !== KEY_LEN || want.length !== 32) return false;
  return ctEqual(mac(key, body), want);
}

/** SHA-256 of a stored (encrypted) file, base64url: binds a file reference to the exact bytes behind it. */
export function fileDigest(ciphertext: Uint8Array): string {
  assertBytes(ciphertext, 'ciphertext');
  return b64u.encode(sha256(ciphertext));
}
