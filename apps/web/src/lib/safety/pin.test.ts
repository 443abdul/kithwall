// App PIN / duress PIN wrapping and the local attempt limiter. Run: npx vitest run src/lib/safety
import { describe, expect, it } from 'vitest';
import { randomBytes, type KdfParams } from '@kithwall/crypto';
import { createPinWrap, openPinWrap, pinProblem, setDuressPin, isPinWrap } from './pin';
import { attemptWait, delayAfter, noteFailure, noteSuccess, FRESH } from './limiter';

const WEAK: KdfParams = { alg: 'argon2id', v: 1, m: 64, t: 1, p: 1 };
const opts = { allowWeakParams: true, kdf: WEAK };
const USER = '00000000-0000-0000-0000-0000000000a1';

describe('pinProblem', () => {
  it('accepts reasonable PINs', () => {
    expect(pinProblem('482916')).toBeNull();
    expect(pinProblem('90817263')).toBeNull();
  });
  it('rejects short, long, non-digit and trivial PINs', () => {
    expect(pinProblem('12345')).toBe('short');
    expect(pinProblem('1'.repeat(17))).toBe('long');
    expect(pinProblem('12a456')).toBe('digits');
    expect(pinProblem('000000')).toBe('simple');
    expect(pinProblem('123456')).toBe('simple');
    expect(pinProblem('890123')).toBe('simple');
    expect(pinProblem('654321')).toBe('simple');
  });
});

describe('PIN wrap', () => {
  const amk = randomBytes(32);

  it('opens with the right PIN and not with a wrong one', async () => {
    const w = await createPinWrap(USER, amk, '482916', opts);
    expect(isPinWrap(w)).toBe(true);
    const ok = await openPinWrap(USER, w, '482916', opts);
    expect(ok.kind).toBe('real');
    if (ok.kind === 'real') expect(ok.amk).toEqual(amk);
    expect((await openPinWrap(USER, w, '482917', opts)).kind).toBe('wrong');
    expect((await openPinWrap(USER, w, '', opts)).kind).toBe('wrong');
    expect((await openPinWrap(USER, w, 'abc', opts)).kind).toBe('wrong');
  });

  it('is bound to the user id', async () => {
    const w = await createPinWrap(USER, amk, '482916', opts);
    expect((await openPinWrap('00000000-0000-0000-0000-0000000000b2', w, '482916', opts)).kind).toBe('wrong');
  });

  it('uses a fresh random salt for each new wrap', async () => {
    const a = await createPinWrap(USER, amk, '482916', opts);
    const b = await createPinWrap(USER, amk, '482916', opts);
    expect(a.salt).not.toBe(b.salt);
    expect(a.amk).not.toBe(b.amk);
  });

  it('refuses weak Argon2id parameters unless allowed (tests only)', async () => {
    await expect(createPinWrap(USER, amk, '482916', { kdf: WEAK })).rejects.toThrow();
  });

  it('detects tampering', async () => {
    const w = await createPinWrap(USER, amk, '482916', opts);
    const bad = { ...w, amk: w.amk.slice(0, -2) + (w.amk.endsWith('A') ? 'BB' : 'AA') };
    expect((await openPinWrap(USER, bad, '482916', opts)).kind).toBe('wrong');
  });

  it('refuses bad PINs at creation', async () => {
    await expect(createPinWrap(USER, amk, '1234', opts)).rejects.toThrow('pin_short');
    await expect(createPinWrap(USER, amk, '111111', opts)).rejects.toThrow('pin_simple');
  });
});

describe('duress PIN', () => {
  const amk = randomBytes(32);

  it('is recognised as duress and never opens the keys', async () => {
    const w = await setDuressPin(USER, await createPinWrap(USER, amk, '482916', opts), '730215', opts);
    expect((await openPinWrap(USER, w, '730215', opts)).kind).toBe('duress');
    const real = await openPinWrap(USER, w, '482916', opts);
    expect(real.kind).toBe('real');
    expect((await openPinWrap(USER, w, '730216', opts)).kind).toBe('wrong');
  });

  it('must differ from the app PIN', async () => {
    const w = await createPinWrap(USER, amk, '482916', opts);
    await expect(setDuressPin(USER, w, '482916', opts)).rejects.toThrow('pin_same_as_app_pin');
  });

  it('a record without a duress PIN has the same shape', async () => {
    const plain = await createPinWrap(USER, amk, '482916', opts);
    const withDuress = await setDuressPin(USER, plain, '730215', opts);
    expect(Object.keys(plain).sort()).toEqual(Object.keys(withDuress).sort());
    expect(plain.duress.length).toBe(withDuress.duress.length);
  });

  it('can be cleared', async () => {
    const w = await setDuressPin(USER, await createPinWrap(USER, amk, '482916', opts), '730215', opts);
    const cleared = await setDuressPin(USER, w, null, opts);
    expect((await openPinWrap(USER, cleared, '730215', opts)).kind).toBe('wrong');
  });

  it('survives an app PIN change, which may not reuse the duress PIN', async () => {
    const w = await setDuressPin(USER, await createPinWrap(USER, amk, '482916', opts), '730215', opts);
    await expect(createPinWrap(USER, amk, '730215', opts, w)).rejects.toThrow('pin_same_as_duress');
    const changed = await createPinWrap(USER, amk, '591846', opts, w);
    expect((await openPinWrap(USER, changed, '482916', opts)).kind).toBe('wrong');
    expect((await openPinWrap(USER, changed, '591846', opts)).kind).toBe('real');
    expect((await openPinWrap(USER, changed, '730215', opts)).kind).toBe('duress');
  });
});

describe('attempt limiter', () => {
  it('allows three free tries, then escalates', () => {
    expect([1, 2, 3].map(delayAfter)).toEqual([0, 0, 0]);
    expect(delayAfter(4)).toBe(30_000);
    expect(delayAfter(5)).toBe(60_000);
    expect(delayAfter(6)).toBe(300_000);
    expect(delayAfter(7)).toBe(900_000);
    expect(delayAfter(8)).toBe(3_600_000);
    expect(delayAfter(30)).toBe(3_600_000);
  });

  it('tracks the wait and resets on success', () => {
    let s = FRESH;
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) s = noteFailure(s, t0, null).state;
    expect(s.failures).toBe(4);
    expect(attemptWait(s, t0)).toBe(30_000);
    expect(attemptWait(s, t0 + 30_000)).toBe(0);
    expect(noteSuccess()).toEqual({ failures: 0, lockedUntil: 0 });
  });

  it('asks for a wipe when the limit is reached (and only if set)', () => {
    let s = FRESH;
    let wipe = false;
    for (let i = 0; i < 4; i++) ({ state: s, wipe } = noteFailure(s, 0, 5));
    expect(wipe).toBe(false);
    ({ wipe } = noteFailure(s, 0, 5));
    expect(wipe).toBe(true);
    expect(noteFailure({ failures: 50, lockedUntil: 0 }, 0, null).wipe).toBe(false);
  });
});
