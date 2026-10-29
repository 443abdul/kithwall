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
 *
 * v2 (hybrid post-quantum, pq.ts): when the recipient has a published ML-KEM-768 key, the sender also
 * encapsulates to it and both secrets feed the key:
 *
 *   kem, ss    = ML-KEM-768.Encaps(recipientPqPub)
 *   key        = HKDF-SHA-256(ikm = shared ‖ ss, salt = eph.pub ‖ recipientKxPub ‖ kem, info = "kithwall/v2/seal")
 *   aad        = "kithwall/v2/seal/" + context
 *   sig        = Ed25519 over { d:"kithwall/v2/seal-sig", v:2, context, recipient, pq: b64u(SHA-256(recipientPqPub)), eph, kem, n, ct }
 *
 * The recipient's ML-KEM private key is derived from their X25519 private key, so openSealed needs nothing
 * new. Breaking a v2 box needs both X25519 and ML-KEM-768 broken ("harvest now, decrypt later" defence).
 */
import { fail, invalid } from './errors';
import { assertBytes, assertString, b64u, canonicalJson, concat, ctEqual, utf8, wipe } from './encoding';
import { KEY_LEN, NONCE_LEN, TAG_LEN, aeadDecrypt, aeadEncrypt, edSign, edVerifyB64, hkdfSha256, sha256, xKeygen, xPublicKey, xShared } from './primitives';
import { PQ_CT_LEN, pqDecapsulate, pqEncapsulate, pqKeysFromKx } from './pq';

export interface Sealed {
  v: 1 | 2;
  eph: string;
  /** v2: the ML-KEM-768 ciphertext. */
  kem?: string;
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

function sealKeyV2(shared: Uint8Array, ss: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array, kem: Uint8Array): Uint8Array {
  const ikm = concat(shared, ss);
  try { return hkdfSha256(ikm, 'kithwall/v2/seal', KEY_LEN, concat(ephPub, recipientPub, kem)); } finally { wipe(ikm); }
}

function sealAad(context: string, v: 1 | 2 = 1): Uint8Array {
  return utf8(`kithwall/v${v}/seal/${context}`);
}

function sealSigMessageV2(context: string, recipientPub: Uint8Array, pqPub: Uint8Array, eph: string, kem: string, n: string, ct: string): Uint8Array {
  return utf8(canonicalJson({ d: 'kithwall/v2/seal-sig', v: 2, context, recipient: b64u.encode(recipientPub), pq: b64u.encode(sha256(pqPub)), eph, kem, n, ct }));
}

function sealSigMessage(context: string, recipientPub: Uint8Array, eph: string, n: string, ct: string): Uint8Array {
  return utf8(canonicalJson({ d: 'kithwall/v1/seal-sig', v: 1, context, recipient: b64u.encode(recipientPub), eph, n, ct }));
}

/** `recipientPqPub`: the recipient's verified ML-KEM-768 key (pq.ts verifiedPqPub) makes a hybrid v2 box. */
export function seal(args: { recipientKxPub: Uint8Array; senderSignPriv: Uint8Array; context: string; plaintext: Uint8Array; recipientPqPub?: Uint8Array | null }): Sealed {
  const { recipientKxPub, senderSignPriv, context, plaintext, recipientPqPub } = args;
  assertBytes(recipientKxPub, 'recipientKxPub', KEY_LEN);
  assertBytes(senderSignPriv, 'senderSignPriv', KEY_LEN);
  assertString(context, 'context', MAX_CONTEXT);
  assertBytes(plaintext, 'plaintext');
  if (plaintext.length === 0 || plaintext.length > MAX_SEALED_PLAINTEXT) invalid('plaintext must be 1..64 KiB');

  const e = xKeygen();
  const shared = xShared(e.priv, recipientKxPub);
  if (recipientPqPub) {
    const k = pqEncapsulate(recipientPqPub);
    const key2 = sealKeyV2(shared, k.shared, e.pub, recipientKxPub, k.ct);
    wipe(e.priv, shared, k.shared);
    let box: { nonce: Uint8Array; ct: Uint8Array };
    try { box = aeadEncrypt(key2, plaintext, sealAad(context, 2)); } finally { wipe(key2); }
    const eph2 = b64u.encode(e.pub), kem = b64u.encode(k.ct), n2 = b64u.encode(box.nonce), ct2 = b64u.encode(box.ct);
    const sig2 = b64u.encode(edSign(sealSigMessageV2(context, recipientKxPub, recipientPqPub, eph2, kem, n2, ct2), senderSignPriv));
    return { v: 2, eph: eph2, kem, n: n2, ct: ct2, sig: sig2 };
  }
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

  if (typeof sealed !== 'object' || sealed === null || (sealed.v !== 1 && sealed.v !== 2)) fail('bad_signature', 'malformed sealed box');
  const { eph, n, ct, sig } = sealed;
  if (typeof eph !== 'string' || typeof n !== 'string' || typeof ct !== 'string') fail('bad_signature', 'malformed sealed box');
  const v2 = sealed.v === 2;
  const kem = sealed.kem;
  if (v2 && typeof kem !== 'string') fail('bad_signature', 'malformed sealed box');
  const pq = v2 ? pqKeysFromKx(recipientKxPriv) : null;

  // 1. Authenticity first.
  const msg = v2 ? sealSigMessageV2(context, recipientKxPub, pq!.pub, eph, kem!, n, ct) : sealSigMessage(context, recipientKxPub, eph, n, ct);
  if (!edVerifyB64(sig, msg, senderSignPub)) {
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
  let key: Uint8Array;
  if (v2) {
    let kemBytes: Uint8Array;
    try { kemBytes = b64u.decode(kem!); } catch { wipe(shared); return fail('decrypt_failed', 'malformed sealed box'); }
    if (kemBytes.length !== PQ_CT_LEN) { wipe(shared); fail('decrypt_failed', 'malformed sealed box'); }
    const ss = pqDecapsulate(kemBytes, pq!.priv);
    key = sealKeyV2(shared, ss, ephPub, recipientKxPub, kemBytes);
    wipe(ss);
  } else key = sealKey(shared, ephPub, recipientKxPub);
  wipe(shared);
  try {
    return aeadDecrypt(key, nonce, ctBytes, sealAad(context, v2 ? 2 : 1));
  } finally {
    wipe(key);
  }
}
