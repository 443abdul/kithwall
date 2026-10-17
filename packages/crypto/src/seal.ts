/**
 * Signed sealed box (spec §3.6): seal a key to a person.
 *
 *   eph        = fresh X25519 key pair
 *   shared     = X25519(eph.priv, recipientKxPub)
 *   key        = HKDF-SHA-256(ikm = shared, salt = eph.pub ‖ recipientKxPub, info = "kithwall/v1/seal")
 *   n, ct      = XChaCha20-Poly1305(key, random 24-byte n, pt, aad = "kithwall/v1/seal/" + context)
 *   sig        = Ed25519(senderSignPriv, canonicalJson({ d:"kithwall/v1/seal-sig", v:1, context,
 *                                                       recipient: b64u(recipientKxPub), eph, n, ct }))
 *
 * The opener verifies the signature first, then decrypts. Context strings bind
 * purpose and ids, e.g. "audience-key/<audienceId>/<epoch>/<recipientId>".
 */
import { fail, invalid } from './errors';
import { assertBytes, assertString, b64u, canonicalJson, concat, ctEqual, utf8, wipe } from './encoding';
import { KEY_LEN, NONCE_LEN, TAG_LEN, aeadDecrypt, aeadEncrypt, edSign, edVerifyB64, hkdfSha256, xKeygen, xPublicKey, xShared } from './primitives';

export interface Sealed {
  v: 1;
  eph: string;
  n: string;
  ct: string;
  sig: string;
}

/** Sealed plaintexts are keys or key shares; cap them. */
export const MAX_SEALED_PLAINTEXT = 64 * 1024;
const MAX_CONTEXT = 512;

function sealKey(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  return hkdfSha256(shared, 'kithwall/v1/seal', KEY_LEN, concat(ephPub, recipientPub));
}

function sealAad(context: string): Uint8Array {
  return utf8(`kithwall/v1/seal/${context}`);
}

function sealSigMessage(context: string, recipientPub: Uint8Array, eph: string, n: string, ct: string): Uint8Array {
  return utf8(canonicalJson({ d: 'kithwall/v1/seal-sig', v: 1, context, recipient: b64u.encode(recipientPub), eph, n, ct }));
}

export function seal(args: { recipientKxPub: Uint8Array; senderSignPriv: Uint8Array; context: string; plaintext: Uint8Array }): Sealed {
  const { recipientKxPub, senderSignPriv, context, plaintext } = args;
  assertBytes(recipientKxPub, 'recipientKxPub', KEY_LEN);
  assertBytes(senderSignPriv, 'senderSignPriv', KEY_LEN);
  assertString(context, 'context', MAX_CONTEXT);
  assertBytes(plaintext, 'plaintext');
  if (plaintext.length === 0 || plaintext.length > MAX_SEALED_PLAINTEXT) invalid('plaintext must be 1..64 KiB');

  const e = xKeygen();
  const shared = xShared(e.priv, recipientKxPub);
  const key = sealKey(shared, e.pub, recipientKxPub);
  wipe(e.priv, shared);
  let nonce: Uint8Array;
  let ctBytes: Uint8Array;
  try {
    ({ nonce, ct: ctBytes } = aeadEncrypt(key, plaintext, sealAad(context)));
  } finally {
    wipe(key);
  }
  const eph = b64u.encode(e.pub);
  const n = b64u.encode(nonce);
  const ct = b64u.encode(ctBytes);
  const sig = b64u.encode(edSign(sealSigMessage(context, recipientKxPub, eph, n, ct), senderSignPriv));
  return { v: 1, eph, n, ct, sig };
}

export function openSealed(args: {
  sealed: Sealed;
  recipientKxPriv: Uint8Array;
  recipientKxPub: Uint8Array;
  senderSignPub: Uint8Array;
  context: string;
}): Uint8Array {
  const { sealed, recipientKxPriv, recipientKxPub, senderSignPub, context } = args;
  assertBytes(recipientKxPriv, 'recipientKxPriv', KEY_LEN);
  assertBytes(recipientKxPub, 'recipientKxPub', KEY_LEN);
  assertBytes(senderSignPub, 'senderSignPub', KEY_LEN);
  assertString(context, 'context', MAX_CONTEXT);
  if (!ctEqual(xPublicKey(recipientKxPriv), recipientKxPub)) invalid('recipientKxPub does not match recipientKxPriv');

  if (typeof sealed !== 'object' || sealed === null || sealed.v !== 1) fail('bad_signature', 'malformed sealed box');
  const { eph, n, ct, sig } = sealed;
  if (typeof eph !== 'string' || typeof n !== 'string' || typeof ct !== 'string') fail('bad_signature', 'malformed sealed box');

  // 1. Authenticity first.
  if (!edVerifyB64(sig, sealSigMessage(context, recipientKxPub, eph, n, ct), senderSignPub)) {
    fail('bad_signature', 'sealed box signature invalid');
  }

  // 2. Then confidentiality. A validly signed but malformed box is still a decrypt failure.
  let ephPub: Uint8Array, nonce: Uint8Array, ctBytes: Uint8Array;
  try {
    ephPub = b64u.decode(eph);
    nonce = b64u.decode(n);
    ctBytes = b64u.decode(ct);
  } catch {
    return fail('decrypt_failed', 'malformed sealed box');
  }
  if (ephPub.length !== KEY_LEN || nonce.length !== NONCE_LEN || ctBytes.length < TAG_LEN) fail('decrypt_failed', 'malformed sealed box');
  let shared: Uint8Array;
  try {
    shared = xShared(recipientKxPriv, ephPub);
  } catch {
    return fail('decrypt_failed', 'invalid ephemeral key');
  }
  const key = sealKey(shared, ephPub, recipientKxPub);
  wipe(shared);
  try {
    return aeadDecrypt(key, nonce, ctBytes, sealAad(context));
  } finally {
    wipe(key);
  }
}
