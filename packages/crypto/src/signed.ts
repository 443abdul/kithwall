/**
 * Detached Ed25519 signatures over small text documents published by the operator (for example the
 * signed mirror list, docs/v2/08-censorship.md §2).
 *
 * The signed message is UTF-8("<context>\n<body>"): the context string separates document kinds, so a
 * signature made for one kind of document can never be replayed as another. The body is signed as the
 * exact string that was published (no re-serialisation, no canonicalisation step to get wrong); readers
 * verify first and only then JSON.parse it.
 *
 * Verification is strict RFC 8032 (see edVerify) and never throws.
 */
import { b64u, utf8 } from './encoding';
import { edPublicKey, edSign, edVerify, edVerifyB64, KEY_LEN } from './primitives';

const enc = new TextEncoder();

function message(context: string, body: string): Uint8Array {
  if (!/^[a-z0-9./-]{3,64}$/.test(context)) throw new TypeError('signed document: bad context');
  return enc.encode(`${context}\n${body}`);
}

/** Sign `body` under `context` with a 32-byte Ed25519 private key; returns the base64url signature. */
export function signDocument(context: string, body: string, signPriv: Uint8Array): string {
  return b64u.encode(edSign(message(context, body), signPriv));
}

/** The base64url public key for a 32-byte Ed25519 private key. */
export function documentPublicKey(signPriv: Uint8Array): string {
  return b64u.encode(edPublicKey(signPriv));
}

/** Verify a detached base64url signature; false on any problem (bad key, bad encoding, wrong context). */
export function verifyDocument(context: string, body: string, sig: string, signPub: string | Uint8Array): boolean {
  try {
    const pub = typeof signPub === 'string' ? b64u.decode(signPub) : signPub;
    if (pub.length !== KEY_LEN || typeof sig !== 'string' || typeof body !== 'string') return false;
    return edVerify(b64u.decode(sig), message(context, body), pub);
  } catch {
    return false;
  }
}

/**
 * Sign a UTF-8 message with an identity key (Ed25519), e.g. a Kit Drop file. The message must carry its own
 * domain tag (a "d" field in canonical JSON), so a signature can't be replayed as one for something else.
 */
export function signDetached(message: string, signPriv: Uint8Array): string {
  return b64u.encode(edSign(utf8(message), signPriv));
}

/** Never throws; false on any problem. */
export function verifyDetached(sig: unknown, message: string, signPub: Uint8Array): boolean {
  try { return edVerifyB64(sig, utf8(message), signPub); } catch { return false; }
}
