import { describe, expect, it } from 'vitest';
import {
  PRF_APP_SALT,
  b64u,
  createKeyBundle,
  newPrfSalt,
  newSymmetricKey,
  passkeyWrapAad,
  prfWrapKey,
  unlockWithAmk,
  unlockWithPassword,
  unlockWithPrf,
  unlockWithRecoveryPhrase,
  unwrapAmkWithPrf,
  wrapAmkWithPrf,
} from '../src/index';
import { sha256 } from '../src/primitives';
import { expectCode, flipB64, toHex } from './helpers';

const USER = '7d3c1e2a-0000-4000-8000-000000000001';
const OTHER = '7d3c1e2a-0000-4000-8000-000000000002';
const CRED = 'AQIDBAUGBwgJCgsMDQ4PEA';
const CRED2 = 'EA8ODQwLCgkIBwYFBAMCAQ';
const prf = () => newSymmetricKey();

describe('PRF_APP_SALT', () => {
  it('is the fixed SHA-256 of the app label (must never change: every passkey wrap depends on it)', () => {
    expect(PRF_APP_SALT.length).toBe(32);
    expect(toHex(PRF_APP_SALT)).toBe(toHex(sha256(new TextEncoder().encode('kithwall/v1/prf-app-salt'))));
  });
});

describe('newPrfSalt / prfWrapKey', () => {
  it('salts are 32 random bytes', () => {
    const a = newPrfSalt();
    expect(b64u.decode(a).length).toBe(32);
    expect(newPrfSalt()).not.toBe(a);
  });
  it('wrap key depends on both PRF output and credential salt, deterministically', () => {
    const p = prf(); const s1 = newPrfSalt(); const s2 = newPrfSalt();
    expect(prfWrapKey(p, s1)).toEqual(prfWrapKey(p, s1));
    expect(toHex(prfWrapKey(p, s1))).not.toBe(toHex(prfWrapKey(p, s2)));
    expect(toHex(prfWrapKey(prf(), s1))).not.toBe(toHex(prfWrapKey(p, s1)));
    expect(toHex(prfWrapKey(p, s1))).not.toBe(toHex(p)); // never the raw PRF output
  });
  it('rejects short PRF output and malformed salts', () => {
    expectCode(() => prfWrapKey(new Uint8Array(16), newPrfSalt()), 'invalid_input');
    expectCode(() => prfWrapKey(prf(), 'abc'), 'invalid_input');
    expectCode(() => prfWrapKey(prf(), b64u.encode(new Uint8Array(16))), 'invalid_input');
  });
});

describe('wrapAmkWithPrf / unwrapAmkWithPrf', () => {
  const amk = newSymmetricKey();
  const p = prf();
  const salt = newPrfSalt();
  const wrapped = wrapAmkWithPrf(USER, CRED, amk, p, salt);

  it('round-trips and is randomised', () => {
    expect(unwrapAmkWithPrf(USER, CRED, wrapped, p, salt)).toEqual(amk);
    expect(wrapAmkWithPrf(USER, CRED, amk, p, salt)).not.toBe(wrapped);
    expect(b64u.decode(wrapped).length).toBe(1 + 24 + 32 + 16);
  });
  it('fails with the wrong passkey, salt, user or credential', () => {
    expectCode(() => unwrapAmkWithPrf(USER, CRED, wrapped, prf(), salt), 'decrypt_failed');
    expectCode(() => unwrapAmkWithPrf(USER, CRED, wrapped, p, newPrfSalt()), 'decrypt_failed');
    expectCode(() => unwrapAmkWithPrf(OTHER, CRED, wrapped, p, salt), 'decrypt_failed');
    expectCode(() => unwrapAmkWithPrf(USER, CRED2, wrapped, p, salt), 'decrypt_failed');
  });
  it('detects any flipped byte', () => {
    for (let i = 0; i < b64u.decode(wrapped).length; i++) {
      expectCode(() => unwrapAmkWithPrf(USER, CRED, flipB64(wrapped, i), p, salt), 'decrypt_failed');
    }
  });
  it('validates inputs', () => {
    expectCode(() => wrapAmkWithPrf(USER, CRED, new Uint8Array(31), p, salt), 'invalid_input');
    expectCode(() => wrapAmkWithPrf(USER, 'not base64url!', amk, p, salt), 'invalid_input');
    expectCode(() => wrapAmkWithPrf('', CRED, amk, p, salt), 'invalid_input');
    expectCode(() => unwrapAmkWithPrf(USER, CRED, 'garbage', p, salt), 'decrypt_failed');
    expect(new TextDecoder().decode(passkeyWrapAad(USER, CRED))).toBe(`kithwall/v1/wrap/amk-passkey/${USER}/${CRED}`);
  });
  it('accepts PRF outputs longer than 32 bytes', () => {
    const long = new Uint8Array(64).fill(7);
    expect(unwrapAmkWithPrf(USER, CRED, wrapAmkWithPrf(USER, CRED, amk, long, salt), long, salt)).toEqual(amk);
  });
});

describe('passkey-first key bundle (no password)', () => {
  const { bundle, unlocked, recoveryPhrase } = createKeyBundle(USER, null);
  const p = prf();
  const salt = newPrfSalt();
  const wrapped = wrapAmkWithPrf(USER, CRED, unlocked.amk, p, salt);

  it('has no amkByPassword, any password is bad_password', () => {
    expect(bundle.amkByPassword).toBeUndefined();
    expect(JSON.parse(JSON.stringify(bundle)).amkByPassword).toBeUndefined();
    expectCode(() => unlockWithPassword(USER, bundle, newSymmetricKey()), 'bad_password');
  });
  it('unlocks with the passkey and with the recovery phrase', () => {
    const u = unlockWithPrf(USER, bundle, CRED, wrapped, p, salt);
    expect(u.amk).toEqual(unlocked.amk);
    expect(u.identity.signPub).toEqual(unlocked.identity.signPub);
    expect(unlockWithRecoveryPhrase(USER, bundle, recoveryPhrase).amk).toEqual(unlocked.amk);
    expect(unlockWithAmk(USER, bundle, unlocked.amk).identity.kxPriv).toEqual(unlocked.identity.kxPriv);
  });
  it('a passkey wrap for a different account cannot open this bundle', () => {
    const other = createKeyBundle(USER, null);
    const w = wrapAmkWithPrf(USER, CRED, other.unlocked.amk, p, salt);
    expectCode(() => unlockWithPrf(USER, bundle, CRED, w, p, salt), 'decrypt_failed');
  });
  it('rejects a bundle whose amkByPassword is not a string', () => {
    expectCode(() => unlockWithAmk(USER, { ...bundle, amkByPassword: 5 as never }, unlocked.amk), 'invalid_input');
  });
});
