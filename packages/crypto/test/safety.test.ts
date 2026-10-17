import { describe, expect, it } from 'vitest';
import { type KeyChange, b64u, generateIdentity, safetyNumber, signChallenge, signKeyChange, verifyChallenge, verifyKeyChange } from '../src/index';
import { expectCode, flipB64 } from './helpers';

const a = generateIdentity();
const b = generateIdentity();

describe('safetyNumber', () => {
  it('is 60 digits and order-independent', () => {
    const ab = safetyNumber({ userId: 'ua', signPub: a.signPub }, { userId: 'ub', signPub: b.signPub });
    const ba = safetyNumber({ userId: 'ub', signPub: b.signPub }, { userId: 'ua', signPub: a.signPub });
    expect(ab).toMatch(/^\d{60}$/);
    expect(ab).toBe(ba);
  });
  it('changes when any key or id changes', () => {
    const base = safetyNumber({ userId: 'ua', signPub: a.signPub }, { userId: 'ub', signPub: b.signPub });
    const c = generateIdentity();
    expect(safetyNumber({ userId: 'ua', signPub: c.signPub }, { userId: 'ub', signPub: b.signPub })).not.toBe(base);
    expect(safetyNumber({ userId: 'ux', signPub: a.signPub }, { userId: 'ub', signPub: b.signPub })).not.toBe(base);
  });
  it('validates inputs', () => {
    expectCode(() => safetyNumber({ userId: '', signPub: a.signPub }, { userId: 'ub', signPub: b.signPub }), 'invalid_input');
    expectCode(() => safetyNumber({ userId: 'ua', signPub: new Uint8Array(3) }, { userId: 'ub', signPub: b.signPub }), 'invalid_input');
  });
});

describe('proof-of-key challenges', () => {
  it('sign / verify', () => {
    const sig = signChallenge(a.signPriv, 'nonce-123');
    expect(verifyChallenge(a.signPub, 'nonce-123', sig)).toBe(true);
    expect(verifyChallenge(a.signPub, 'nonce-124', sig)).toBe(false);
    expect(verifyChallenge(b.signPub, 'nonce-123', sig)).toBe(false);
    expect(verifyChallenge(a.signPub, 'nonce-123', flipB64(sig, 10))).toBe(false);
    expect(verifyChallenge(a.signPub, 'nonce-123', 'garbage!')).toBe(false);
    expect(verifyChallenge(a.signPub, '', sig)).toBe(false);
    expect(verifyChallenge(a.signPub, 'x'.repeat(1025), sig)).toBe(false);
    expect(verifyChallenge(new Uint8Array(3), 'nonce-123', sig)).toBe(false);
    expectCode(() => signChallenge(a.signPriv, ''), 'invalid_input');
    expectCode(() => signChallenge(new Uint8Array(3), 'n'), 'invalid_input');
  });

  it('is domain-separated from key-change signatures', () => {
    const change: KeyChange = { userId: 'ua', newSignPub: b64u.encode(b.signPub), newKxPub: b64u.encode(b.kxPub), at: '2026-10-17T00:00:00Z' };
    const kcSig = signKeyChange(a.signPriv, change);
    expect(verifyChallenge(a.signPub, JSON.stringify(change), kcSig)).toBe(false);
  });
});

describe('key change', () => {
  const change: KeyChange = { userId: 'ua', newSignPub: b64u.encode(b.signPub), newKxPub: b64u.encode(b.kxPub), at: '2026-10-17T00:00:00Z' };

  it('old key vouches for the new key', () => {
    const sig = signKeyChange(a.signPriv, change);
    expect(verifyKeyChange(a.signPub, change, sig)).toBe(true);
    expect(verifyKeyChange(b.signPub, change, sig)).toBe(false);
    for (const k of ['userId', 'at'] as const) expect(verifyKeyChange(a.signPub, { ...change, [k]: change[k] + 'x' }, sig)).toBe(false);
    expect(verifyKeyChange(a.signPub, { ...change, newKxPub: b64u.encode(a.kxPub) }, sig)).toBe(false);
    expect(verifyKeyChange(a.signPub, { ...change, newSignPub: 'bad' }, sig)).toBe(false);
    expect(verifyKeyChange(a.signPub, null as unknown as KeyChange, sig)).toBe(false);
    expect(verifyKeyChange(a.signPub, change, flipB64(sig, 0))).toBe(false);
  });

  it('validates input on signing', () => {
    expectCode(() => signKeyChange(a.signPriv, { ...change, newKxPub: b64u.encode(new Uint8Array(31)) }), 'invalid_input');
    expectCode(() => signKeyChange(a.signPriv, { ...change, at: '' }), 'invalid_input');
    expectCode(() => signKeyChange(a.signPriv, { ...change, userId: '' }), 'invalid_input');
  });
});
