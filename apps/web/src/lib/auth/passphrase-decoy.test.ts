// Security review W3: the passphrase lookup must not tell passphrase accounts apart from other handles.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { decoyId } from './passphrase-decoy';
import { syntheticEmailFor } from './passkey-shared';

const SECRET = 'a-test-secret-of-sufficient-length';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The shape test an attacker used: does the address embed a version-4, RFC 4122 UUID? */
const looksReal = (email: string) => {
  const hex = email.slice(1, 33);
  return hex[12] === '4' && '89ab'.includes(hex[16]!);
};

describe('passphrase lookup decoys', () => {
  it('are version-4 UUIDs, like real user ids', () => {
    for (let i = 0; i < 200; i++) expect(decoyId(`handle${i}`, SECRET)).toMatch(UUID_V4);
  });

  it('give addresses of exactly the same shape as real accounts (the old 1-in-64 tell is gone)', () => {
    for (let i = 0; i < 200; i++) {
      const real = syntheticEmailFor(randomUUID());
      const decoy = syntheticEmailFor(decoyId(`someone${i}`, SECRET));
      expect(decoy.length).toBe(real.length);
      expect(looksReal(decoy)).toBe(true);
      expect(looksReal(real)).toBe(true);
    }
  });

  it('are stable per handle and differ across handles and secrets', () => {
    expect(decoyId('ann', SECRET)).toBe(decoyId('ann', SECRET));
    expect(decoyId('ann', SECRET)).not.toBe(decoyId('anne', SECRET));
    expect(decoyId('ann', SECRET)).not.toBe(decoyId('ann', `${SECRET}x`));
  });
});
