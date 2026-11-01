/**
 * Merkle tree (RFC 9162 / RFC 6962) known-answer tests and proof properties.
 *
 * The vectors are the RFC 6962 reference test data used by Certificate Transparency implementations
 * (certificate-transparency-go / Trillian "merkle" test data): eight leaves, the root of every prefix,
 * and a set of inclusion and consistency proofs.
 */
import { describe, expect, it } from 'vitest';
import {
  consistencyProof, inclusionProof, merkleEmptyRoot, merkleLeafHash, merkleNodeHash, merkleRoot, rootFromInclusionProof,
  verifyConsistency, verifyInclusion,
} from '../src/index';
import { expectCode, hex, toHex } from './helpers';

const LEAVES = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'].map(hex);
const HASHES = LEAVES.map((d) => merkleLeafHash(d));

const ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

const INCLUSION: { index: number; size: number; path: string[] }[] = [
  { index: 0, size: 1, path: [] },
  {
    index: 0, size: 8, path: [
      '96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7',
      '5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
      '6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4',
    ],
  },
  {
    index: 5, size: 8, path: [
      'bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b',
      'ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0',
      'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
    ],
  },
  { index: 2, size: 3, path: ['fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125'] },
  {
    index: 1, size: 5, path: [
      '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
      '5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
      'bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b',
    ],
  },
];

const CONSISTENCY: { size1: number; size2: number; proof: string[] }[] = [
  { size1: 1, size2: 1, proof: [] },
  {
    size1: 1, size2: 8, proof: [
      '96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7',
      '5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
      '6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4',
    ],
  },
  {
    size1: 6, size2: 8, proof: [
      '0ebc5d3437fbe2db158b9f126a1d118e308181031d0a949f8dededebc558ef6a',
      'ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0',
      'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
    ],
  },
  {
    size1: 2, size2: 5, proof: [
      '5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
      'bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b',
    ],
  },
];

const root = (n: number) => merkleRoot(HASHES.slice(0, n));

describe('Merkle tree hashing (RFC 6962 test data)', () => {
  it('the empty tree is SHA-256 of nothing', () => {
    expect(toHex(merkleEmptyRoot())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(merkleRoot([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('a leaf is hashed with the 0x00 prefix', () => {
    expect(toHex(HASHES[0]!)).toBe('6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');
    expect(toHex(HASHES[1]!)).toBe('96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7');
  });

  ROOTS.forEach((r, i) => {
    it(`root of the first ${i + 1} leaves`, () => expect(toHex(root(i + 1))).toBe(r));
  });

  it('rejects leaf hashes of the wrong length', () => {
    expectCode(() => merkleRoot([new Uint8Array(31)]), 'invalid_input');
  });
});

describe('inclusion proofs', () => {
  for (const v of INCLUSION) {
    it(`leaf ${v.index} in a tree of ${v.size}: generated and verified`, () => {
      const proof = inclusionProof(HASHES.slice(0, v.size), v.index);
      expect(proof.map(toHex)).toEqual(v.path);
      expect(verifyInclusion(HASHES[v.index]!, v.index, v.size, v.path.map(hex), root(v.size))).toBe(true);
    });
  }

  it('every leaf of every tree up to 40 leaves verifies, and only against the right root', () => {
    const many = Array.from({ length: 40 }, (_, i) => merkleLeafHash(new Uint8Array([i, i >> 8, 7])));
    for (let n = 1; n <= many.length; n++) {
      const r = merkleRoot(many.slice(0, n));
      for (let m = 0; m < n; m++) {
        const p = inclusionProof(many.slice(0, n), m);
        expect(verifyInclusion(many[m]!, m, n, p, r)).toBe(true);
        expect(toHex(rootFromInclusionProof(many[m]!, m, n, p)!)).toBe(toHex(r));
        // Wrong index, wrong leaf, the (size, root) of a later tree: all fail.
        if (n > 1) expect(verifyInclusion(many[m]!, (m + 1) % n, n, p, r)).toBe(false);
        expect(verifyInclusion(many[(m + 1) % 40]!, m, n, p, r)).toBe(false);
        if (n < many.length) expect(verifyInclusion(many[m]!, m, n + 1, p, merkleRoot(many.slice(0, n + 1)))).toBe(false);
      }
    }
  });

  it('rejects tampered, truncated, padded and malformed proofs', () => {
    const p = inclusionProof(HASHES, 5);
    const r = root(8);
    const flipped = p.map((h) => h.slice());
    flipped[1]![0]! ^= 1;
    expect(verifyInclusion(HASHES[5]!, 5, 8, flipped, r)).toBe(false);
    expect(verifyInclusion(HASHES[5]!, 5, 8, p.slice(0, 2), r)).toBe(false);
    expect(verifyInclusion(HASHES[5]!, 5, 8, [...p, p[0]!], r)).toBe(false);
    expect(verifyInclusion(HASHES[5]!, 8, 8, p, r)).toBe(false);
    expect(verifyInclusion(HASHES[5]!, -1, 8, p, r)).toBe(false);
    expect(verifyInclusion(HASHES[5]!, 5, 8, [new Uint8Array(31), p[1]!, p[2]!], r)).toBe(false);
    expect(verifyInclusion(HASHES[5]!, 5, 8, p, new Uint8Array(32))).toBe(false);
    expect(verifyInclusion(HASHES[0]!, 0, 1, [], root(1))).toBe(true);
    expect(verifyInclusion(HASHES[0]!, 0, 1, [HASHES[1]!], root(1))).toBe(false);
  });

  it('works for indexes and sizes beyond 32 bits', () => {
    // Leaf 2^40 is the last leaf of a 2^40 + 1 tree: its path is the root of the first 2^40 leaves.
    const leaf = merkleLeafHash(new Uint8Array([1]));
    const left = merkleLeafHash(new Uint8Array([2]));
    expect(toHex(rootFromInclusionProof(leaf, 2 ** 40, 2 ** 40 + 1, [left])!)).toBe(toHex(merkleNodeHash(left, leaf)));
    expect(rootFromInclusionProof(leaf, 2 ** 40, 2 ** 40 + 2, [left])).toBeNull();
    // Consistency 2^40 → 2^40 + 1: the old root is a node of the new tree (power-of-two rule).
    expect(verifyConsistency(2 ** 40, 2 ** 40 + 1, [leaf], left, merkleNodeHash(left, leaf))).toBe(true);
    expect(verifyConsistency(2 ** 40, 2 ** 40 + 1, [leaf], leaf, merkleNodeHash(left, leaf))).toBe(false);
  });
});

describe('consistency proofs', () => {
  for (const v of CONSISTENCY) {
    it(`${v.size1} → ${v.size2}: generated and verified`, () => {
      const proof = consistencyProof(HASHES.slice(0, v.size2), v.size1);
      expect(proof.map(toHex)).toEqual(v.proof);
      expect(verifyConsistency(v.size1, v.size2, v.proof.map(hex), root(v.size1), root(v.size2))).toBe(true);
    });
  }

  it('every pair of sizes up to 40 leaves verifies, and fails against any other root', () => {
    const many = Array.from({ length: 40 }, (_, i) => merkleLeafHash(new Uint8Array([i, 3])));
    const roots = Array.from({ length: 41 }, (_, n) => merkleRoot(many.slice(0, n)));
    for (let n = 1; n <= many.length; n++) {
      for (let m = 0; m <= n; m++) {
        const p = consistencyProof(many.slice(0, n), m);
        expect(verifyConsistency(m, n, p, roots[m]!, roots[n]!)).toBe(true);
        if (m >= 1 && m < n) {
          expect(verifyConsistency(m, n, p, roots[m - 1]!, roots[n]!)).toBe(false);
          expect(verifyConsistency(m, n, p, roots[m]!, roots[n - 1]!)).toBe(false);
          expect(verifyConsistency(m, n, p.slice(1), roots[m]!, roots[n]!)).toBe(false);
          expect(verifyConsistency(m, n, [], roots[m]!, roots[n]!)).toBe(false);
        }
      }
    }
  });

  it('a rewritten history is not consistent: same prefix size, different entry', () => {
    const forked = HASHES.slice();
    forked[3] = merkleLeafHash(hex('ff'));
    const p = consistencyProof(forked, 4);
    expect(verifyConsistency(4, 8, p, root(4), merkleRoot(forked))).toBe(false);
    expect(verifyConsistency(4, 8, consistencyProof(HASHES, 4), root(4), merkleRoot(forked))).toBe(false);
  });

  it('a shrinking log is never consistent, and equal sizes need equal roots', () => {
    expect(verifyConsistency(8, 6, [], root(8), root(6))).toBe(false);
    expect(verifyConsistency(5, 5, [], root(5), root(5))).toBe(true);
    expect(verifyConsistency(5, 5, [], root(5), root(6))).toBe(false);
    expect(verifyConsistency(5, 5, [HASHES[0]!], root(5), root(5))).toBe(false);
    expect(verifyConsistency(0, 3, [], merkleEmptyRoot(), root(3))).toBe(true);
    expect(verifyConsistency(0, 3, [], root(1), root(3))).toBe(false);
  });
});
