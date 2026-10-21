// Run: npx vitest run src/lib/keys
// Security review K2: identity-key pinning. Replays the review's exploit (an operator or a session-only
// attacker swaps a contact's identity keys) against the client rule that decides whether new keys may be
// sealed to the contact, and checks that legitimate signed rotations are shown but not blocked.
import { describe, expect, it } from 'vitest';
import { b64u, generateIdentity, signKeyChange, type KeyChange } from '@kithwall/crypto';
import { cleanPins, maySealTo, pinStatus, vouchedFrom, type KeyChangeLogRow, type Pin } from './pinsCore';

const USER = '00000000-0000-0000-0000-0000000000b0';
const old = generateIdentity();
const next = generateIdentity();
const attacker = generateIdentity();
const enc = (i: typeof old) => ({ s: b64u.encode(i.signPub), x: b64u.encode(i.kxPub) });
const pin: Pin = { ...enc(old), at: '2026-10-01T00:00:00.000Z' };

function change(from: typeof old, to: typeof old, at: string): KeyChangeLogRow {
  const c: KeyChange = { userId: USER, newSignPub: enc(to).s, newKxPub: enc(to).x, at };
  return { change: c, sig: signKeyChange(from.signPriv, c), created_at: at };
}

describe('identity pins (K2)', () => {
  it('detects ANY change of either key', () => {
    expect(pinStatus(undefined, enc(old).s, enc(old).x)).toBe('new');
    expect(pinStatus(pin, enc(old).s, enc(old).x)).toBe('same');
    expect(pinStatus(pin, enc(attacker).s, enc(attacker).x)).toBe('changed');
    // Swapping only the key-exchange key (what new keys are sealed to) is a change too.
    expect(pinStatus(pin, enc(old).s, enc(attacker).x)).toBe('changed');
  });

  it('exploit: a silent key swap (no signature by the old key) stops sealing to the new key', () => {
    const a = enc(attacker);
    // The attacker may even write a "key change" signed by their own key: it doesn't chain from the pin.
    const forged = [change(attacker, attacker, '2026-10-20T00:00:00Z')];
    const vouched = vouchedFrom(pin, a.s, a.x, forged);
    expect(vouched).toBe(false);
    expect(maySealTo({ pin, signPub: a.s, kxPub: a.x, verifiedKey: null, vouched })).toBe(false);
  });

  it('a kx-only swap behind an unchanged signing key is not vouched', () => {
    const rows = [change(old, next, '2026-10-20T00:00:00Z')];
    expect(vouchedFrom(pin, enc(old).s, enc(attacker).x, rows)).toBe(false);
  });

  it('a rotation signed by the pinned key is shown but does not stop sharing for unverified contacts', () => {
    const n = enc(next);
    const rows = [change(old, next, '2026-10-20T00:00:00Z')];
    const vouched = vouchedFrom(pin, n.s, n.x, rows);
    expect(vouched).toBe(true);
    expect(pinStatus(pin, n.s, n.x)).toBe('changed'); // → "safety number changed" notice
    expect(maySealTo({ pin, signPub: n.s, kxPub: n.x, verifiedKey: null, vouched })).toBe(true);
  });

  it('verified contacts: never sealed to a changed key without the user confirming, even when vouched', () => {
    const n = enc(next);
    expect(maySealTo({ pin, signPub: n.s, kxPub: n.x, verifiedKey: enc(old).s, vouched: true })).toBe(false);
    // After the user verified the new number (which re-pins), sharing resumes.
    expect(maySealTo({ pin: { ...n, at: 'now' }, signPub: n.s, kxPub: n.x, verifiedKey: n.s, vouched: false })).toBe(true);
    // A verified key that differs from the published one blocks even if the pin was updated another way.
    expect(maySealTo({ pin: { ...n, at: 'now' }, signPub: n.s, kxPub: n.x, verifiedKey: enc(old).s, vouched: false })).toBe(false);
  });

  it('new contacts are trusted on first use; unchanged ones always pass', () => {
    expect(maySealTo({ pin: undefined, signPub: enc(old).s, kxPub: enc(old).x, verifiedKey: null, vouched: false })).toBe(true);
    expect(maySealTo({ pin, signPub: enc(old).s, kxPub: enc(old).x, verifiedKey: null, vouched: false })).toBe(true);
  });

  it('cleans what comes out of the vault', () => {
    expect(cleanPins({ [USER]: pin, 'not-a-uuid': pin, [USER.replace('b0', 'b1')]: { s: 'short', x: pin.x, at: 'x' } })).toEqual({ [USER]: pin });
    expect(cleanPins(null)).toEqual({});
  });
});
