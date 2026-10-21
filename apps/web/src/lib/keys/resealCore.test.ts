// Run: npx vitest run src/lib/keys/resealCore.test.ts
// Security final review NEW-1: rotating my identity key re-seals my past key deliveries. A recipient whose
// published key was swapped (not trusted by sealGate) must be skipped, never sealed to the swapped key.
import { describe, expect, it } from 'vitest';
import { b64u, generateIdentity } from '@kithwall/crypto';
import { resealTarget } from './resealCore';

describe('resealTarget (NEW-1)', () => {
  const me = 'me';
  const mine = generateIdentity();
  const bob = generateIdentity();
  const operator = generateIdentity();
  const published = new Map([
    ['bob', { s: b64u.encode(bob.signPub), x: b64u.encode(bob.kxPub) }],
    // Carol's published key was swapped by the operator: sealGate did not allow her.
    ['carol', { s: b64u.encode(operator.signPub), x: b64u.encode(operator.kxPub) }],
  ]);
  const allowed = new Set(['bob']);

  it('seals to a trusted recipient with their published key', () => {
    expect(resealTarget('bob', me, mine.kxPub, published, allowed)).toEqual(bob.kxPub);
  });
  it('skips a recipient whose swapped key sealGate rejected (the attack)', () => {
    expect(resealTarget('carol', me, mine.kxPub, published, allowed)).toBeNull();
  });
  it('skips recipients without a published profile', () => {
    expect(resealTarget('dave', me, mine.kxPub, published, new Set(['dave']))).toBeNull();
  });
  it('my own deliveries go to my NEW key', () => {
    expect(resealTarget(me, me, mine.kxPub, published, allowed)).toEqual(mine.kxPub);
  });
});
