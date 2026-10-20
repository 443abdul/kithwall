// Recovery from a @handle: what the server hands out and the proof the device sends back.
// Run: npx vitest run src/lib/auth/recovery-shared.test.ts
import { describe, expect, it } from 'vitest';
import { b64u, createKeyBundle, signChallenge, unlockWithRecoveryPhrase, verifyChallenge, type KeyBundle } from '@kithwall/crypto';
import { cleanPhrase, recoveryBundleOf } from './recovery-shared';

describe('recoveryBundleOf', () => {
  it('never includes the passphrase wrap, and still opens with the recovery phrase', () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const { bundle, recoveryPhrase } = createKeyBundle(userId, new Uint8Array(32).fill(7));
    expect(bundle.amkByPassword).toBeTypeOf('string');
    const pub = recoveryBundleOf(bundle);
    expect(pub).not.toHaveProperty('amkByPassword');
    const u = unlockWithRecoveryPhrase(userId, pub as KeyBundle, recoveryPhrase);
    // The proof /api/recovery/finish checks against profiles.sign_pub.
    const sig = signChallenge(u.identity.signPriv, 'nonce-123');
    expect(verifyChallenge(b64u.decode(bundle.signPub), 'nonce-123', sig)).toBe(true);
    expect(verifyChallenge(b64u.decode(bundle.signPub), 'other-nonce', sig)).toBe(false);
  });
});

describe('cleanPhrase', () => {
  it('normalises case, spacing and stray punctuation, keeping order', () => {
    expect(cleanPhrase('  Apple   banana,\ncherry. ')).toEqual({ phrase: 'apple banana cherry', words: 3 });
    expect(cleanPhrase('').words).toBe(0);
  });
});
