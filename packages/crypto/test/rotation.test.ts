import { describe, expect, it } from 'vitest';
import {
  b64u, createKeyBundle, openSealed, rotateIdentityBundle, seal, signKeyChange, unlockWithAmk, unlockWithPassword, verifyKeyChange,
  generateIdentity, newSymmetricKey,
} from '../src/index';
import { FAST_KDF, expectCode } from './helpers';

const USER = '00000000-0000-0000-0000-0000000000c1';

describe('rotateIdentityBundle (K2 signed identity rotation)', () => {
  it('gives new keys for the same AMK and keeps the old X25519 key for earlier sealed keys', () => {
    const kek = new Uint8Array(32).fill(7);
    const { bundle, unlocked } = createKeyBundle(USER, kek, FAST_KDF);
    const sender = generateIdentity();
    const key = newSymmetricKey();
    const sealedBefore = seal({ recipientKxPub: unlocked.identity.kxPub, senderSignPriv: sender.signPriv, context: 'ctx', plaintext: key });

    const r = rotateIdentityBundle(USER, bundle, unlocked);
    expect(r.bundle.signPub).not.toBe(bundle.signPub);
    expect(r.bundle.kxPub).not.toBe(bundle.kxPub);
    expect(r.bundle.amkByPassword).toBe(bundle.amkByPassword);

    const again = unlockWithPassword(USER, r.bundle, kek);
    expect(b64u.encode(again.identity.signPub)).toBe(r.bundle.signPub);
    expect(again.previousKx).toHaveLength(1);
    const prev = again.previousKx![0]!;
    expect(b64u.encode(prev.kxPub)).toBe(bundle.kxPub);
    expect(openSealed({ sealed: sealedBefore, recipientKxPriv: prev.kxPriv, recipientKxPub: prev.kxPub, senderSignPub: sender.signPub, context: 'ctx' })).toEqual(key);

    // The change statement is signed by the OLD key and verifies only against it.
    const change = { userId: USER, newSignPub: r.bundle.signPub, newKxPub: r.bundle.kxPub, at: new Date().toISOString() };
    const sig = signKeyChange(unlocked.identity.signPriv, change);
    expect(verifyKeyChange(unlocked.identity.signPub, change, sig)).toBe(true);
    expect(verifyKeyChange(r.unlocked.identity.signPub, change, sig)).toBe(false);

    // A second rotation keeps both earlier keys, newest first.
    const r2 = rotateIdentityBundle(USER, r.bundle, again);
    const third = unlockWithAmk(USER, r2.bundle, again.amk);
    expect(third.previousKx!.map((p) => b64u.encode(p.kxPub))).toEqual([r.bundle.kxPub, bundle.kxPub]);
  });

  it('refuses an identity that does not belong to the bundle', () => {
    const a = createKeyBundle(USER, null, FAST_KDF);
    const b = createKeyBundle(USER, null, FAST_KDF);
    expectCode(() => rotateIdentityBundle(USER, a.bundle, b.unlocked), 'decrypt_failed');
  });
});
