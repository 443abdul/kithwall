import { describe, expect, it } from 'vitest';
import { b64u, canonicalJson, newSymmetricKey, openSealed, pqKeysFromKx, seal, signPqPub, verifiedPqPub } from '../src/index';
import { edKeygen, xKeygen } from '../src/primitives';

const ctx = 'audience-key/aud/1/bob';

describe('hybrid post-quantum sealed boxes (v2)', () => {
  const alice = edKeygen();
  const bob = xKeygen();
  const bobPq = pqKeysFromKx(bob.priv);

  it('derives the same ML-KEM key pair from the same X25519 key, and different ones from different keys', () => {
    const again = pqKeysFromKx(new Uint8Array(bob.priv));
    expect(b64u.encode(again.pub)).toBe(b64u.encode(bobPq.pub));
    expect(b64u.encode(pqKeysFromKx(xKeygen().priv).pub)).not.toBe(b64u.encode(bobPq.pub));
  });

  it('round-trips, fits the 2 KB column, and v1 boxes still open', () => {
    const key = newSymmetricKey();
    const v2 = seal({ recipientKxPub: bob.pub, senderSignPriv: alice.priv, context: ctx, plaintext: key, recipientPqPub: bobPq.pub });
    expect(v2.v).toBe(2);
    expect(canonicalJson(v2).length).toBeLessThan(2048);
    const open = (s: typeof v2) => openSealed({ sealed: s, recipientKxPriv: bob.priv, recipientKxPub: bob.pub, senderSignPub: alice.pub, context: ctx });
    expect(b64u.encode(open(v2))).toBe(b64u.encode(key));
    const v1 = seal({ recipientKxPub: bob.pub, senderSignPriv: alice.priv, context: ctx, plaintext: key });
    expect(v1.v).toBe(1);
    expect(b64u.encode(open(v1))).toBe(b64u.encode(key));
  });

  it('rejects a changed KEM ciphertext, a downgrade to v1, or the wrong context', () => {
    const key = newSymmetricKey();
    const v2 = seal({ recipientKxPub: bob.pub, senderSignPriv: alice.priv, context: ctx, plaintext: key, recipientPqPub: bobPq.pub });
    const kem = b64u.decode(v2.kem!); kem[0]! ^= 1;
    const open = (s: unknown, c = ctx) => () => openSealed({ sealed: s as typeof v2, recipientKxPriv: bob.priv, recipientKxPub: bob.pub, senderSignPub: alice.pub, context: c });
    expect(open({ ...v2, kem: b64u.encode(kem) })).toThrow();
    expect(open({ ...v2, v: 1 })).toThrow();
    expect(open(v2, 'audience-key/aud/2/bob')).toThrow();
  });

  it('a box sealed to someone else\'s ML-KEM key does not open (signature binds the recipient\'s key)', () => {
    const other = pqKeysFromKx(xKeygen().priv);
    const v2 = seal({ recipientKxPub: bob.pub, senderSignPriv: alice.priv, context: ctx, plaintext: newSymmetricKey(), recipientPqPub: other.pub });
    expect(() => openSealed({ sealed: v2, recipientKxPriv: bob.priv, recipientKxPub: bob.pub, senderSignPub: alice.pub, context: ctx })).toThrow();
  });

  it('only accepts a published ML-KEM key signed by the person for their current X25519 key', () => {
    const id = edKeygen();
    const sig = signPqPub({ userId: 'bob', kxPub: bob.pub, pqPub: bobPq.pub, signPriv: id.priv });
    const pq = b64u.encode(bobPq.pub);
    expect(verifiedPqPub({ userId: 'bob', kxPub: bob.pub, pqPub: pq, sig, signPub: id.pub })).not.toBeNull();
    expect(verifiedPqPub({ userId: 'mallory', kxPub: bob.pub, pqPub: pq, sig, signPub: id.pub })).toBeNull();
    expect(verifiedPqPub({ userId: 'bob', kxPub: xKeygen().pub, pqPub: pq, sig, signPub: id.pub })).toBeNull();
    expect(verifiedPqPub({ userId: 'bob', kxPub: bob.pub, pqPub: pq, sig, signPub: edKeygen().pub })).toBeNull();
    expect(verifiedPqPub({ userId: 'bob', kxPub: bob.pub, pqPub: null, sig, signPub: id.pub })).toBeNull();
  });
});
