/**
 * Key-transparency log entries (docs/v2/09-key-transparency.md). Every publication of an identity key
 * (sign-up, signed rotation) appends one leaf to a public, append-only Merkle log (./merkle.ts).
 *
 * The leaf must not reveal whose key it is, or the public log would list every account and keep that
 * list forever. So the leaf holds only a salted commitment:
 *
 *   commitment = SHA-256(lp("kithwall/v1/kt-commit", userId, signPub, kxPub, u64be(version), salt))
 *   leaf data  = lp("kithwall/v1/kt-leaf", commitment)
 *   leaf hash  = SHA-256(0x00 ‖ leaf data)                                          (RFC 9162)
 *
 *   userId    canonical lowercase UUID string
 *   signPub   base64url Ed25519 identity key, exactly as published in profiles.sign_pub (43 chars)
 *   kxPub     base64url X25519 key, as published in profiles.kx_pub (43 chars)
 *   version   profiles.key_version (1 at sign-up, +1 per signed rotation)
 *   salt      32 random bytes chosen by the server when the leaf is appended (the "opening")
 *
 * lp() is the length-prefixed encoding of ./encoding.ts (4-byte big-endian length before each part).
 * The salt is handed out only to signed-in people allowed to see that profile; deleting an account
 * deletes the salt, after which the leaf is an opaque random-looking hash. The server computes the same
 * bytes in SQL (kw.kt_commitment), and the test vectors in test/kt.test.ts pin both.
 */
import { invalid } from './errors';
import { assertBytes, assertString, lp, u64be } from './encoding';
import { sha256 } from './primitives';
import { merkleLeafHash } from './merkle';

export const KT_SALT_LEN = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;

export interface KtEntry {
  userId: string;
  signPub: string;
  kxPub: string;
  version: number;
  salt: Uint8Array;
}

/** The salted commitment to one identity-key publication. */
export function ktCommitment(e: KtEntry): Uint8Array {
  if (typeof e !== 'object' || e === null) invalid('entry must be an object');
  assertString(e.userId, 'userId', 36);
  if (!UUID.test(e.userId)) invalid('userId must be a lowercase UUID');
  if (typeof e.signPub !== 'string' || !KEY.test(e.signPub)) invalid('signPub must be a 43-character base64url key');
  if (typeof e.kxPub !== 'string' || !KEY.test(e.kxPub)) invalid('kxPub must be a 43-character base64url key');
  if (!Number.isSafeInteger(e.version) || e.version < 1) invalid('version must be a positive integer');
  assertBytes(e.salt, 'salt', KT_SALT_LEN);
  return sha256(lp('kithwall/v1/kt-commit', e.userId, e.signPub, e.kxPub, u64be(e.version), e.salt));
}

/** The bytes of a log entry: the domain tag and the commitment. */
export function ktLeafData(commitment: Uint8Array): Uint8Array {
  assertBytes(commitment, 'commitment', 32);
  return lp('kithwall/v1/kt-leaf', commitment);
}

/** The Merkle leaf hash of an identity-key publication (what inclusion proofs are checked against). */
export function ktLeafHash(e: KtEntry): Uint8Array {
  return merkleLeafHash(ktLeafData(ktCommitment(e)));
}
