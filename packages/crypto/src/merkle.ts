/**
 * Merkle tree hashing and proofs for append-only logs, exactly as in RFC 9162 §2.1 (the same tree as
 * RFC 6962, Certificate Transparency), with SHA-256:
 *
 *   MTH({})       = SHA-256()
 *   MTH({d0})     = SHA-256(0x00 ‖ d0)                                   leaf hash
 *   MTH(D[n])     = SHA-256(0x01 ‖ MTH(D[0:k]) ‖ MTH(D[k:n]))             k = largest power of 2 < n
 *
 * The 0x00 / 0x01 prefixes keep a leaf from ever being confused with an interior node (second-preimage
 * resistance). Used by the key-transparency log (./kt.ts, docs/v2/09-key-transparency.md); the server
 * builds the same tree in SQL (supabase/migrations/20261102000500_key_transparency.sql).
 *
 * Verification follows the RFC 9162 algorithms (§2.1.3.2 inclusion, §2.1.4.2 consistency) and never
 * throws on bad proofs: it returns false. Tree sizes are JavaScript safe integers; the bit operations are
 * done arithmetically so sizes above 2^31 work.
 *
 * The generators (merkleRoot, inclusionProof, consistencyProof) work on an in-memory list of leaf hashes:
 * they are the reference the tests (and anyone auditing a full download of the log) check against.
 */
import { invalid } from './errors';
import { assertBytes, concat, ctEqual } from './encoding';
import { sha256 } from './primitives';

export const MERKLE_HASH_LEN = 32;
/** Longest proof we accept: one hash per level of a tree with 2^63 leaves is far more than enough. */
const MAX_PROOF = 64;

const LEAF = new Uint8Array([0x00]);
const NODE = new Uint8Array([0x01]);

/** SHA-256(0x00 ‖ data): the hash of one log entry. */
export function merkleLeafHash(data: Uint8Array): Uint8Array {
  assertBytes(data, 'data');
  return sha256(concat(LEAF, data));
}

/** SHA-256(0x01 ‖ left ‖ right): an interior node. */
export function merkleNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  assertBytes(left, 'left', MERKLE_HASH_LEN);
  assertBytes(right, 'right', MERKLE_HASH_LEN);
  return sha256(concat(NODE, left, right));
}

/** The root of the empty tree, SHA-256 of the empty string. */
export function merkleEmptyRoot(): Uint8Array {
  return sha256(new Uint8Array(0));
}

const isSize = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isHash = (h: unknown): h is Uint8Array => h instanceof Uint8Array && h.length === MERKLE_HASH_LEN;
const odd = (n: number) => n % 2 === 1;
const half = (n: number) => Math.floor(n / 2);

function isPowerOfTwo(n: number): boolean {
  let k = 1;
  while (k < n) k *= 2;
  return k === n;
}

/** Largest power of two strictly smaller than n (n ≥ 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function checkLeaves(leaves: readonly Uint8Array[]): void {
  if (!Array.isArray(leaves)) invalid('leaves must be an array of leaf hashes');
  for (const l of leaves) if (!isHash(l)) invalid('every leaf hash must be 32 bytes');
}

function mth(leaves: readonly Uint8Array[], lo: number, hi: number): Uint8Array {
  const n = hi - lo;
  if (n === 0) return merkleEmptyRoot();
  if (n === 1) return leaves[lo]!;
  const k = split(n);
  return merkleNodeHash(mth(leaves, lo, lo + k), mth(leaves, lo + k, hi));
}

/** MTH over a list of LEAF HASHES (merkleLeafHash of each entry). */
export function merkleRoot(leafHashes: readonly Uint8Array[]): Uint8Array {
  checkLeaves(leafHashes);
  return mth(leafHashes, 0, leafHashes.length);
}

/** RFC 9162 PATH(m, D[n]): the audit path of leaf `index` in the tree made of these leaf hashes. */
export function inclusionProof(leafHashes: readonly Uint8Array[], index: number): Uint8Array[] {
  checkLeaves(leafHashes);
  if (!isSize(index) || index >= leafHashes.length) invalid('index must be inside the tree');
  const path = (m: number, lo: number, hi: number): Uint8Array[] => {
    const n = hi - lo;
    if (n <= 1) return [];
    const k = split(n);
    return m < k
      ? [...path(m, lo, lo + k), mth(leafHashes, lo + k, hi)]
      : [...path(m - k, lo + k, hi), mth(leafHashes, lo, lo + k)];
  };
  return path(index, 0, leafHashes.length);
}

/** RFC 9162 PROOF(m, D[n]): proves the first `size1` leaves are a prefix of all of them. */
export function consistencyProof(leafHashes: readonly Uint8Array[], size1: number): Uint8Array[] {
  checkLeaves(leafHashes);
  if (!isSize(size1) || size1 > leafHashes.length) invalid('size1 must be at most the tree size');
  if (size1 === 0 || size1 === leafHashes.length) return [];
  const sub = (m: number, lo: number, hi: number, whole: boolean): Uint8Array[] => {
    const n = hi - lo;
    if (m === n) return whole ? [] : [mth(leafHashes, lo, hi)];
    const k = split(n);
    return m <= k
      ? [...sub(m, lo, lo + k, whole), mth(leafHashes, lo + k, hi)]
      : [...sub(m - k, lo + k, hi, false), mth(leafHashes, lo, lo + k)];
  };
  return sub(size1, 0, leafHashes.length, true);
}

/**
 * The root an inclusion proof leads to (RFC 9162 §2.1.3.2 steps 1–4), or null when the proof has the
 * wrong shape for (index, size). Compare the result with a trusted root yourself, or use verifyInclusion.
 */
export function rootFromInclusionProof(leafHash: Uint8Array, index: number, size: number, proof: readonly Uint8Array[]): Uint8Array | null {
  if (!isHash(leafHash) || !isSize(index) || !isSize(size) || index >= size) return null;
  if (!Array.isArray(proof) || proof.length > MAX_PROOF || !proof.every(isHash)) return null;
  let fn = index;
  let sn = size - 1;
  let r = leafHash;
  for (const p of proof) {
    if (sn === 0) return null;
    if (odd(fn) || fn === sn) {
      r = merkleNodeHash(p, r);
      if (!odd(fn)) while (!odd(fn) && fn !== 0) { fn = half(fn); sn = half(sn); }
    } else {
      r = merkleNodeHash(r, p);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 ? r : null;
}

/** True when `proof` shows that the leaf with this hash sits at `index` in the tree of `size` with `root`. */
export function verifyInclusion(leafHash: Uint8Array, index: number, size: number, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  if (!isHash(root)) return false;
  const r = rootFromInclusionProof(leafHash, index, size, proof);
  return r !== null && ctEqual(r, root);
}

/**
 * True when `proof` shows that the tree of `size1` with `root1` is a prefix of the tree of `size2` with
 * `root2` (RFC 9162 §2.1.4.2): nothing in the first tree was changed or removed, entries were only appended.
 * Equal sizes need an empty proof and equal roots; size1 = 0 is consistent with everything (empty proof).
 */
export function verifyConsistency(size1: number, size2: number, proof: readonly Uint8Array[], root1: Uint8Array, root2: Uint8Array): boolean {
  if (!isSize(size1) || !isSize(size2) || size1 > size2 || !isHash(root1) || !isHash(root2)) return false;
  if (!Array.isArray(proof) || proof.length > MAX_PROOF || !proof.every(isHash)) return false;
  if (size1 === size2) return proof.length === 0 && ctEqual(root1, root2);
  if (size1 === 0) return proof.length === 0 && ctEqual(root1, merkleEmptyRoot());
  if (proof.length === 0) return false;
  // Step 2: when size1 is a power of two, the old root is itself a node of the new tree.
  const path = isPowerOfTwo(size1) ? [root1, ...proof] : [...proof];
  let fn = size1 - 1;
  let sn = size2 - 1;
  while (odd(fn)) { fn = half(fn); sn = half(sn); }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (odd(fn) || fn === sn) {
      fr = merkleNodeHash(c, fr);
      sr = merkleNodeHash(c, sr);
      if (!odd(fn)) while (!odd(fn) && fn !== 0) { fn = half(fn); sn = half(sn); }
    } else {
      sr = merkleNodeHash(sr, c);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && ctEqual(fr, root1) && ctEqual(sr, root2);
}
