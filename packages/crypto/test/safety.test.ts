import { describe, expect, it } from 'vitest';
import {
  type KeyChange, SAFETY_QR_PREFIX, b64u, formatSafetyNumber, generateIdentity, normalizeSafetyDigits, parseSafetyQr, safetyNumber,
  safetyNumbersMatch, safetyQrPayload, signChallenge, signKeyChange, verifyChallenge, verifyKeyChange,
} from '../src/index';
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

describe('safetyNumber known answer', () => {
  // Locks the algorithm (domain string, 5200 iterations, digit extraction, ordering): a change here
  // would make every verified contact look changed.
  it('matches the recorded vector', () => {
    const n = safetyNumber(
      { userId: '00000000-0000-0000-0000-00000000000a', signPub: new Uint8Array(32).fill(1) },
      { userId: '00000000-0000-0000-0000-00000000000b', signPub: new Uint8Array(32).fill(2) },
    );
    expect(n).toBe('266945553356581885080741637371903790060714856152031344693685');
  });
});

describe('safety number display and comparison', () => {
  const n = safetyNumber({ userId: 'ua', signPub: a.signPub }, { userId: 'ub', signPub: b.signPub });
  it('groups into twelve blocks of five', () => {
    const g = formatSafetyNumber(n);
    expect(g).toHaveLength(12);
    expect(g.every((x) => /^\d{5}$/.test(x))).toBe(true);
    expect(g.join('')).toBe(n);
    expectCode(() => formatSafetyNumber('123'), 'invalid_input');
  });
  it('compares what a person typed, in any script, ignoring spaces', () => {
    expect(safetyNumbersMatch(n, formatSafetyNumber(n).join(' '))).toBe(true);
    expect(safetyNumbersMatch(n, formatSafetyNumber(n).join('-\n'))).toBe(true);
    const arabic = [...n].map((d) => String.fromCodePoint(0x660 + Number(d))).join('');
    const persian = [...n].map((d) => String.fromCodePoint(0x6f0 + Number(d))).join(' ');
    const devanagari = [...n].map((d) => String.fromCodePoint(0x966 + Number(d))).join('');
    const bengali = [...n].map((d) => String.fromCodePoint(0x9e6 + Number(d))).join('');
    for (const v of [arabic, persian, devanagari, bengali]) expect(safetyNumbersMatch(n, v)).toBe(true);
    expect(normalizeSafetyDigits('١٢ 3-٤')).toBe('1234');
    const wrong = (n[0] === '9' ? '0' : '9') + n.slice(1);
    expect(safetyNumbersMatch(n, wrong)).toBe(false);
    expect(safetyNumbersMatch(n, n.slice(0, 59))).toBe(false);
    expect(safetyNumbersMatch(n, n + '1')).toBe(false);
    expect(safetyNumbersMatch('short', 'short')).toBe(false);
  });
  it('round-trips through the QR payload', () => {
    const qr = safetyQrPayload(n);
    expect(qr.startsWith(SAFETY_QR_PREFIX)).toBe(true);
    expect(parseSafetyQr(qr)).toBe(n);
    expect(parseSafetyQr('https://example.com/' + n)).toBeNull();
    expect(parseSafetyQr(SAFETY_QR_PREFIX + n.slice(1))).toBeNull();
    expect(parseSafetyQr(SAFETY_QR_PREFIX + n + 'x')).toBeNull();
    expect(parseSafetyQr(null as unknown as string)).toBeNull();
    expectCode(() => safetyQrPayload('x'), 'invalid_input');
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
