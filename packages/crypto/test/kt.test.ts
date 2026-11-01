/**
 * Key-transparency leaves (src/kt.ts). The vector is shared with the SQL side
 * (supabase/tests/key_transparency.test.sql checks kw.kt_commitment / kw.kt_leaf_hash give the same bytes),
 * so the server and every client agree on what a leaf is.
 */
import { describe, expect, it } from 'vitest';
import {
  b64u, inclusionProof, ktCommitment, ktLeafData, ktLeafHash, merkleLeafHash, merkleRoot, verifyInclusion, type KtEntry,
} from '../src/index';
import { expectCode, toHex } from './helpers';

const VECTOR: KtEntry = {
  userId: '0f9c3f1e-6a4b-4c2d-9e8f-1a2b3c4d5e6f',
  signPub: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
  kxPub: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
  version: 3,
  salt: Uint8Array.from({ length: 32 }, (_, i) => i),
};

describe('key-transparency leaves', () => {
  it('the vector keys are 32 bytes of 0x01 and 0x02', () => {
    expect(VECTOR.signPub).toBe(b64u.encode(new Uint8Array(32).fill(1)));
    expect(VECTOR.kxPub).toBe(b64u.encode(new Uint8Array(32).fill(2)));
  });

  it('commitment and leaf hash (shared with the SQL test)', () => {
    expect(toHex(ktCommitment(VECTOR))).toBe('acebae685411a51be34974f33ccf0b8b72fa57199ca8e18c8d6128525ec70c84');
    expect(toHex(ktLeafHash(VECTOR))).toBe('ac04dc149d0f0605f90f64a92136adbc5a53616792fc47153f18c1150ce9d42a');
    expect(toHex(ktLeafHash(VECTOR))).toBe(toHex(merkleLeafHash(ktLeafData(ktCommitment(VECTOR)))));
  });

  it('every field is bound: changing any of them changes the commitment', () => {
    const base = toHex(ktCommitment(VECTOR));
    const variants: KtEntry[] = [
      { ...VECTOR, userId: '0f9c3f1e-6a4b-4c2d-9e8f-1a2b3c4d5e60' },
      { ...VECTOR, signPub: b64u.encode(new Uint8Array(32).fill(3)) },
      { ...VECTOR, kxPub: b64u.encode(new Uint8Array(32).fill(3)) },
      { ...VECTOR, version: 4 },
      { ...VECTOR, salt: Uint8Array.from({ length: 32 }, (_, i) => 31 - i) },
      // Swapping the two keys must not collide either.
      { ...VECTOR, signPub: VECTOR.kxPub, kxPub: VECTOR.signPub },
    ];
    for (const v of variants) expect(toHex(ktCommitment(v))).not.toBe(base);
  });

  it('rejects malformed entries', () => {
    expectCode(() => ktCommitment({ ...VECTOR, userId: VECTOR.userId.toUpperCase() }), 'invalid_input');
    expectCode(() => ktCommitment({ ...VECTOR, signPub: 'short' }), 'invalid_input');
    expectCode(() => ktCommitment({ ...VECTOR, kxPub: VECTOR.kxPub + 'A' }), 'invalid_input');
    expectCode(() => ktCommitment({ ...VECTOR, version: 0 }), 'invalid_input');
    expectCode(() => ktCommitment({ ...VECTOR, version: 1.5 }), 'invalid_input');
    expectCode(() => ktCommitment({ ...VECTOR, salt: new Uint8Array(16) }), 'invalid_input');
    expectCode(() => ktLeafData(new Uint8Array(31)), 'invalid_input');
  });

  it('an opening proves a key is in the log; the same keys with another salt or user do not', () => {
    const others = Array.from({ length: 6 }, (_, i) => merkleLeafHash(new Uint8Array([9, i])));
    const leaves = [...others.slice(0, 4), ktLeafHash(VECTOR), ...others.slice(4)];
    const root = merkleRoot(leaves);
    const proof = inclusionProof(leaves, 4);
    expect(verifyInclusion(ktLeafHash(VECTOR), 4, leaves.length, proof, root)).toBe(true);
    expect(verifyInclusion(ktLeafHash({ ...VECTOR, salt: new Uint8Array(32) }), 4, leaves.length, proof, root)).toBe(false);
    expect(verifyInclusion(ktLeafHash({ ...VECTOR, userId: '00000000-0000-4000-8000-000000000000' }), 4, leaves.length, proof, root)).toBe(false);
  });
});
