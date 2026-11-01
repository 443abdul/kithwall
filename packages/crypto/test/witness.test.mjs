// The public witness (infra/kt-witness/witness.mjs) is a second, dependency-free implementation of the
// RFC 9162 consistency check. It must agree with src/merkle.ts on the RFC 6962 vectors and on every proof
// shape, and refuse the same forgeries. (Plain .mjs: the witness script itself is plain JavaScript.)
import { describe, expect, it } from 'vitest';
import { b64u, consistencyProof, merkleLeafHash, merkleRoot, verifyConsistency as reference } from '../src/index';
import { judge, parseHead, verifyConsistency } from '../../../infra/kt-witness/witness.mjs';

const leaves = Array.from({ length: 33 }, (_, i) => merkleLeafHash(new Uint8Array([i, 0x77])));
const roots = Array.from({ length: 34 }, (_, n) => merkleRoot(leaves.slice(0, n)));
const head = (n) => ({ size: n, root: b64u.encode(roots[n]), at: null });

describe('witness verifier', () => {
  it('agrees with packages/crypto on every pair of sizes up to 33', () => {
    for (let n = 1; n <= 33; n++) {
      for (let m = 1; m <= n; m++) {
        const p = consistencyProof(leaves.slice(0, n), m);
        expect(verifyConsistency(m, n, p, roots[m], roots[n])).toBe(true);
        expect(reference(m, n, p, roots[m], roots[n])).toBe(true);
        if (m < n) {
          expect(verifyConsistency(m, n, p, roots[m - 1], roots[n])).toBe(false);
          expect(verifyConsistency(m, n, p.slice(1), roots[m], roots[n])).toBe(false);
        }
      }
    }
  });

  it('judges heads like the devices do', () => {
    const proof = consistencyProof(leaves.slice(0, 20), 7).map((h) => b64u.encode(h));
    expect(judge(null, head(7), null)).toEqual({ ok: true, changed: true });
    expect(judge(head(7), head(7), null)).toEqual({ ok: true, changed: false });
    expect(judge(head(7), head(20), proof)).toEqual({ ok: true, changed: true });
    expect(judge(head(20), head(7), null).ok).toBe(false);                                  // shrank
    expect(judge(head(7), { ...head(7), root: head(8).root }, null).ok).toBe(false);        // forked
    expect(judge(head(7), { ...head(20), root: head(21).root }, proof).ok).toBe(false);     // rewritten
    expect(judge(head(7), head(20), ['junk']).ok).toBe(false);
    expect(parseHead({ size: 3, root: 'x' })).toBeNull();
    expect(parseHead({ size: 3, root: head(3).root, at: '2026-11-02T00:00:00Z' })).toEqual({ ...head(3), at: '2026-11-02T00:00:00Z' });
  });
});
