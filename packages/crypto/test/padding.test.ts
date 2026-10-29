import { describe, expect, it } from 'vitest';
import { b64u, newSymmetricKey, openWithContentKey, sealWithContentKey } from '../src/index';
import { paddedLength } from '../src/envelope';
import { edKeygen } from '../src/primitives';

describe('payload padding (Padme)', () => {
  it('never shrinks, adds at most ~12%, and makes nearby lengths identical', () => {
    for (const n of [0, 1, 255, 256, 1000, 5000, 9000, 70000]) {
      const p = paddedLength(n);
      expect(p).toBeGreaterThanOrEqual(n);
      expect(p / Math.max(n, 256)).toBeLessThanOrEqual(1.12);
    }
    expect(paddedLength(1)).toBe(paddedLength(200));
    expect(paddedLength(1001)).toBe(paddedLength(1020));
  });

  it('padded payloads open to the same value, and two short texts have the same ciphertext length', () => {
    const id = edKeygen();
    const ck = newSymmetricKey();
    const header = { v: 1 as const, type: 'comment', id: 'c1', author: 'u', wall: 'p', audience: 'self' as const };
    const a = sealWithContentKey({ header, payload: { text: 'hi' }, contentKey: ck, signPriv: id.priv });
    const b = sealWithContentKey({ header, payload: { text: 'a somewhat longer comment, still short' }, contentKey: ck, signPriv: id.priv });
    expect(b64u.decode(a.ct!).length).toBe(b64u.decode(b.ct!).length);
    expect(openWithContentKey({ header, envelope: a, contentKey: ck, signPub: id.pub })).toEqual({ text: 'hi' });
  });
});
