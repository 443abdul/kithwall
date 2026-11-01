import { describe, expect, it } from 'vitest';
import { canonicalJson, signDetached, verifyDetached } from '../src/index';
import { edKeygen } from '../src/primitives';

describe('detached signatures', () => {
  const { pub, priv } = edKeygen();
  const msg = canonicalJson({ d: 'kithwall/v1/kitdrop', v: 1, from: 'u1', made: '2026-11-01T00:00:00.000Z', posts: [{ id: 'p1' }] });

  it('round-trips', () => {
    expect(verifyDetached(signDetached(msg, priv), msg, pub)).toBe(true);
  });

  it('rejects a changed message, another key, or junk', () => {
    const sig = signDetached(msg, priv);
    expect(verifyDetached(sig, msg.replace('p1', 'p2'), pub)).toBe(false);
    expect(verifyDetached(sig, msg, edKeygen().pub)).toBe(false);
    expect(verifyDetached('not-a-sig', msg, pub)).toBe(false);
    expect(verifyDetached(undefined, msg, pub)).toBe(false);
    expect(verifyDetached(42, msg, pub)).toBe(false);
  });
});
