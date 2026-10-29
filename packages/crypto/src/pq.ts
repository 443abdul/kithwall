/**
 * Post-quantum key encapsulation for sealed boxes (seal v2; docs/v2/roadmap-2026-11.md, batch 2).
 *
 * Each person's ML-KEM-768 key pair (FIPS 203) is DERIVED from their X25519 identity private key:
 *
 *   seed      = HKDF-SHA-256(ikm = kxPriv, info = "kithwall/v2/ml-kem-768-seed", 64 bytes)
 *   (pq, pqs) = ML-KEM-768.KeyGen(seed)
 *
 * so no new secret has to be stored, backed up or recovered: whoever can open the identity bundle has it,
 * and an identity key change gives a new one. The public key is published next to the X25519 key with an
 * Ed25519 signature by the identity key over (user, kxPub, pqPub), so clients only use a pqPub the person
 * really published. Sealing to it is hybrid (seal.ts): the box stays secret as long as EITHER X25519 or
 * ML-KEM-768 holds, so a wrong or substituted pqPub can never make it weaker than v1.
 */
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { assertBytes, assertString, b64u, canonicalJson, utf8 } from './encoding';
import { KEY_LEN, edSign, edVerifyB64, hkdfSha256 } from './primitives';

export const PQ_PUB_LEN = 1184;
export const PQ_CT_LEN = 1088;

const derived = new WeakMap<Uint8Array, { pub: Uint8Array; priv: Uint8Array }>();

/** The ML-KEM-768 key pair that belongs to an X25519 identity private key (cached per key object). */
export function pqKeysFromKx(kxPriv: Uint8Array): { pub: Uint8Array; priv: Uint8Array } {
  assertBytes(kxPriv, 'kxPriv', KEY_LEN);
  const hit = derived.get(kxPriv);
  if (hit) return hit;
  const seed = hkdfSha256(kxPriv, 'kithwall/v2/ml-kem-768-seed', 64);
  const k = ml_kem768.keygen(seed);
  seed.fill(0);
  const out = { pub: k.publicKey, priv: k.secretKey };
  derived.set(kxPriv, out);
  return out;
}

export function pqEncapsulate(pqPub: Uint8Array): { ct: Uint8Array; shared: Uint8Array } {
  assertBytes(pqPub, 'pqPub', PQ_PUB_LEN);
  const r = ml_kem768.encapsulate(pqPub);
  return { ct: r.cipherText, shared: r.sharedSecret };
}

export function pqDecapsulate(ct: Uint8Array, pqPriv: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(ct, pqPriv);
}

function pqPubMessage(userId: string, kxPub: Uint8Array, pqPub: Uint8Array): Uint8Array {
  return utf8(canonicalJson({ d: 'kithwall/v2/pq-pub', user: userId, kx: b64u.encode(kxPub), pq: b64u.encode(pqPub) }));
}

/** Signature that publishes pqPub as this person's (for their current X25519 key). */
export function signPqPub(args: { userId: string; kxPub: Uint8Array; pqPub: Uint8Array; signPriv: Uint8Array }): string {
  assertString(args.userId, 'userId', 64);
  assertBytes(args.pqPub, 'pqPub', PQ_PUB_LEN);
  return b64u.encode(edSign(pqPubMessage(args.userId, args.kxPub, args.pqPub), args.signPriv));
}

/** The person's published pqPub, if its signature checks out against their identity key; else null. */
export function verifiedPqPub(args: { userId: string; kxPub: Uint8Array; pqPub: string | null | undefined; sig: string | null | undefined; signPub: Uint8Array }): Uint8Array | null {
  if (!args.pqPub || !args.sig) return null;
  let pq: Uint8Array;
  try { pq = b64u.decode(args.pqPub); } catch { return null; }
  if (pq.length !== PQ_PUB_LEN) return null;
  return edVerifyB64(args.sig, pqPubMessage(args.userId, args.kxPub, pq), args.signPub) ? pq : null;
}
