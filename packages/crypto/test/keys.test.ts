import { describe, expect, it } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  type KeyBundle,
  b64u,
  createKeyBundle,
  combineRecoveryShares,
  deriveCacheKey,
  deriveFromPassword,
  deriveVaultKey,
  generateIdentity,
  newSymmetricKey,
  recoveryKeyFromPhrase,
  rewrapPassword,
  rotateRecovery,
  splitRecoveryKey,
  unlockWithPassword,
  unlockWithRecoveryKey,
  unlockWithAmk,
  unlockWithRecoveryPhrase,
} from '../src/index';
import { packEncrypt } from '../src/primitives';
import { wrapAad } from '../src/keys';
import { FAST_KDF, WEAK, expectCode, flipB64, toHex } from './helpers';

const USER = '7d3c1e2a-0000-4000-8000-000000000001';

describe('generateIdentity', () => {
  it('produces matching Ed25519 / X25519 key pairs', () => {
    const id = generateIdentity();
    expect(ed25519.getPublicKey(id.signPriv)).toEqual(id.signPub);
    expect(x25519.getPublicKey(id.kxPriv)).toEqual(id.kxPub);
    expect(toHex(generateIdentity().signPub)).not.toBe(toHex(id.signPub));
  });
});

describe('vault / cache keys', () => {
  it('are distinct, deterministic 32-byte keys', () => {
    const amk = newSymmetricKey();
    expect(deriveVaultKey(amk)).toEqual(deriveVaultKey(amk));
    expect(deriveVaultKey(amk).length).toBe(32);
    expect(toHex(deriveVaultKey(amk))).not.toBe(toHex(deriveCacheKey(amk)));
    expect(toHex(deriveVaultKey(amk))).not.toBe(toHex(amk));
    expectCode(() => deriveVaultKey(new Uint8Array(16)), 'invalid_input');
    expectCode(() => deriveCacheKey(new Uint8Array(16)), 'invalid_input');
  });
});

describe('key bundle and recovery flows (end to end)', async () => {
  const { passwordKEK, authKey } = await deriveFromPassword('jess@example.com', 'first password', FAST_KDF, WEAK);
  const { bundle, unlocked, recoveryPhrase } = createKeyBundle(USER, passwordKEK, FAST_KDF);

  it('creates a well-formed bundle and a 24-word phrase', () => {
    expect(bundle.v).toBe(1);
    expect(bundle.kdf).toEqual(FAST_KDF);
    expect(recoveryPhrase.split(' ')).toHaveLength(24);
    expect(b64u.decode(bundle.signPub)).toEqual(unlocked.identity.signPub);
    expect(b64u.decode(bundle.kxPub)).toEqual(unlocked.identity.kxPub);
    expect(typeof authKey).toBe('string');
    // The bundle never contains the AMK or private keys in the clear.
    const s = JSON.stringify(bundle);
    expect(s).not.toContain(b64u.encode(unlocked.amk));
    expect(s).not.toContain(b64u.encode(unlocked.identity.signPriv));
    expect(s).not.toContain(b64u.encode(unlocked.identity.kxPriv));
  });

  it('defaults kdf to DEFAULT_KDF', () => {
    expect(createKeyBundle(USER, passwordKEK).bundle.kdf.m).toBe(65536);
  });

  it('unlockWithPassword recovers AMK and identity', () => {
    const u = unlockWithPassword(USER, bundle, passwordKEK);
    expect(u.amk).toEqual(unlocked.amk);
    expect(u.identity).toEqual(unlocked.identity);
  });

  it('wrong password → bad_password', async () => {
    const wrong = await deriveFromPassword('jess@example.com', 'second password', FAST_KDF, WEAK);
    expectCode(() => unlockWithPassword(USER, bundle, wrong.passwordKEK), 'bad_password');
  });

  it('bundle moved to another user id → bad_password', () => {
    expectCode(() => unlockWithPassword('someone-else', bundle, passwordKEK), 'bad_password');
  });

  it('any flipped byte of amkByPassword → bad_password; of identityEnc → decrypt_failed', () => {
    for (let i = 0; i < b64u.decode(bundle.amkByPassword!).length; i++) {
      expectCode(() => unlockWithPassword(USER, { ...bundle, amkByPassword: flipB64(bundle.amkByPassword!, i) }, passwordKEK), 'bad_password');
    }
    for (let i = 0; i < b64u.decode(bundle.identityEnc).length; i++) {
      expectCode(() => unlockWithPassword(USER, { ...bundle, identityEnc: flipB64(bundle.identityEnc, i) }, passwordKEK), 'decrypt_failed');
    }
  });

  it('substituted public keys in the bundle are detected', () => {
    const other = generateIdentity();
    expectCode(() => unlockWithPassword(USER, { ...bundle, signPub: b64u.encode(other.signPub) }, passwordKEK), 'decrypt_failed');
    expectCode(() => unlockWithPassword(USER, { ...bundle, kxPub: b64u.encode(other.kxPub) }, passwordKEK), 'decrypt_failed');
    expectCode(() => unlockWithPassword(USER, { ...bundle, kxPub: '***' }, passwordKEK), 'decrypt_failed');
  });

  it('unlockWithAmk restores the identity and checks public keys', () => {
    const u = unlockWithAmk(USER, bundle, unlocked.amk);
    expect(u.amk).toEqual(unlocked.amk);
    expect(u.identity).toEqual(unlocked.identity);
    const other = generateIdentity();
    expectCode(() => unlockWithAmk(USER, { ...bundle, signPub: b64u.encode(other.signPub) }, unlocked.amk), 'decrypt_failed');
    expectCode(() => unlockWithAmk(USER, { ...bundle, kxPub: b64u.encode(other.kxPub) }, unlocked.amk), 'decrypt_failed');
    expectCode(() => unlockWithAmk(USER, bundle, newSymmetricKey()), 'decrypt_failed');
    expectCode(() => unlockWithAmk('other', bundle, unlocked.amk), 'decrypt_failed');
    expectCode(() => unlockWithAmk(USER, { ...bundle, identityEnc: flipB64(bundle.identityEnc, 5) }, unlocked.amk), 'decrypt_failed');
    expectCode(() => unlockWithAmk(USER, bundle, new Uint8Array(31)), 'invalid_input');
    expectCode(() => unlockWithAmk('', bundle, unlocked.amk), 'invalid_input');
  });

  it('unlockWithRecoveryPhrase also checks bundle public keys', () => {
    const other = generateIdentity();
    expectCode(() => unlockWithRecoveryPhrase(USER, { ...bundle, signPub: b64u.encode(other.signPub) }, recoveryPhrase), 'decrypt_failed');
    expectCode(() => unlockWithRecoveryPhrase(USER, { ...bundle, kxPub: b64u.encode(other.kxPub) }, recoveryPhrase), 'decrypt_failed');
  });

  it('malformed wrapped values of the wrong size are rejected', () => {
    // A correctly-authenticated but wrong-length AMK / identity (only a key holder could make these).
    const shortAmk = packEncrypt(passwordKEK, new Uint8Array(16), wrapAad('amk-password', USER));
    expectCode(() => unlockWithPassword(USER, { ...bundle, amkByPassword: shortAmk }, passwordKEK), 'decrypt_failed');
  });

  it('validates arguments and bundle shape', () => {
    expectCode(() => unlockWithPassword('', bundle, passwordKEK), 'invalid_input');
    expectCode(() => unlockWithPassword(USER, bundle, new Uint8Array(31)), 'invalid_input');
    expectCode(() => unlockWithPassword(USER, { ...bundle, v: 2 } as unknown as KeyBundle, passwordKEK), 'invalid_input');
    expectCode(() => unlockWithPassword(USER, null as unknown as KeyBundle, passwordKEK), 'invalid_input');
    expectCode(() => unlockWithPassword(USER, { ...bundle, identityEnc: 5 } as unknown as KeyBundle, passwordKEK), 'invalid_input');
    expectCode(() => createKeyBundle(USER, new Uint8Array(1)), 'invalid_input');
    expectCode(() => createKeyBundle('', passwordKEK), 'invalid_input');
    expectCode(() => createKeyBundle('u'.repeat(257), passwordKEK), 'invalid_input');
    expectCode(() => createKeyBundle(USER, passwordKEK, { ...FAST_KDF, alg: 'pbkdf2' } as never), 'invalid_input');
  });

  it('unlockWithRecoveryPhrase works and normalizes whitespace / case', () => {
    const messy = '  ' + recoveryPhrase.toUpperCase().split(' ').join(' \n\t ') + '  ';
    const u = unlockWithRecoveryPhrase(USER, bundle, messy);
    expect(u.amk).toEqual(unlocked.amk);
    expect(u.identity.signPriv).toEqual(unlocked.identity.signPriv);
  });

  it('bad phrases → bad_phrase', () => {
    const words = recoveryPhrase.split(' ');
    const swapped = [...words];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    const bads = [
      '',
      words.slice(0, 23).join(' '),
      [...words.slice(0, 23), 'notaword'].join(' '),
      Array(12).fill('abandon').join(' ').replace(/abandon$/, 'about'), // valid 12-word phrase
      swapped.join(' '), // almost always a checksum failure; otherwise a commitment mismatch
      Array(23).fill('abandon').join(' ') + ' art', // valid phrase, different account
      'x'.repeat(2000),
      42 as unknown as string,
    ];
    for (const p of bads) expectCode(() => unlockWithRecoveryPhrase(USER, bundle, p), 'bad_phrase');
  });

  it('recoveryKeyFromPhrase returns the 32-byte RK', () => {
    expect(recoveryKeyFromPhrase(recoveryPhrase).length).toBe(32);
  });

  it('tampered amkByRecovery / wrong user → decrypt_failed after the commitment check', () => {
    expectCode(() => unlockWithRecoveryPhrase(USER, { ...bundle, amkByRecovery: flipB64(bundle.amkByRecovery, 30) }, recoveryPhrase), 'decrypt_failed');
    expectCode(() => unlockWithRecoveryPhrase('other', bundle, recoveryPhrase), 'decrypt_failed');
    const rk = recoveryKeyFromPhrase(recoveryPhrase);
    expectCode(() => unlockWithRecoveryKey(USER, { ...bundle, rkCommitment: 'short' }, rk), 'bad_phrase');
    expectCode(() => unlockWithRecoveryKey(USER, bundle, new Uint8Array(32)), 'bad_phrase');
    expectCode(() => unlockWithRecoveryKey(USER, bundle, new Uint8Array(31)), 'invalid_input');
  });

  it('forgot password: phrase → AMK → new password re-wrap; old password stops working', async () => {
    const u = unlockWithRecoveryPhrase(USER, bundle, recoveryPhrase);
    const next = await deriveFromPassword('jess@example.com', 'brand new password', FAST_KDF, WEAK);
    const updated: KeyBundle = { ...bundle, amkByPassword: rewrapPassword(USER, u.amk, next.passwordKEK) };
    expect(unlockWithPassword(USER, updated, next.passwordKEK).amk).toEqual(unlocked.amk);
    expectCode(() => unlockWithPassword(USER, updated, passwordKEK), 'bad_password');
    expectCode(() => rewrapPassword(USER, new Uint8Array(3), next.passwordKEK), 'invalid_input');
    expectCode(() => rewrapPassword(USER, u.amk, new Uint8Array(3)), 'invalid_input');
    expectCode(() => rewrapPassword('', u.amk, next.passwordKEK), 'invalid_input');
  });

  it('email change: new salt → re-derive → re-wrap', async () => {
    const next = await deriveFromPassword('jessica@new.example', 'first password', FAST_KDF, WEAK);
    expect(toHex(next.passwordKEK)).not.toBe(toHex(passwordKEK));
    const updated: KeyBundle = { ...bundle, amkByPassword: rewrapPassword(USER, unlocked.amk, next.passwordKEK) };
    expect(unlockWithPassword(USER, updated, next.passwordKEK).amk).toEqual(unlocked.amk);
  });

  it('rotateRecovery: new phrase works, old phrase stops working', () => {
    const r = rotateRecovery(USER, unlocked.amk);
    expect(r.recoveryPhrase).not.toBe(recoveryPhrase);
    expect(r.rk).toEqual(recoveryKeyFromPhrase(r.recoveryPhrase));
    const updated: KeyBundle = { ...bundle, amkByRecovery: r.amkByRecovery, rkCommitment: r.rkCommitment };
    expect(unlockWithRecoveryPhrase(USER, updated, r.recoveryPhrase).amk).toEqual(unlocked.amk);
    expectCode(() => unlockWithRecoveryPhrase(USER, updated, recoveryPhrase), 'bad_phrase');
    expectCode(() => rotateRecovery(USER, new Uint8Array(1)), 'invalid_input');
    expectCode(() => rotateRecovery('', unlocked.amk), 'invalid_input');
  });

  it('trusted-friend recovery: split RK → combine k shares → unlock → rotate', async () => {
    const r = rotateRecovery(USER, unlocked.amk);
    const updated: KeyBundle = { ...bundle, amkByRecovery: r.amkByRecovery, rkCommitment: r.rkCommitment };
    const shares = await splitRecoveryKey(r.rk, 5, 3);
    const rk = await combineRecoveryShares([shares[4]!, shares[1]!, shares[2]!], updated.rkCommitment);
    const u = unlockWithRecoveryKey(USER, updated, rk);
    expect(u.amk).toEqual(unlocked.amk);
    expect(u.identity.kxPriv).toEqual(unlocked.identity.kxPriv);
    // After recovery the device issues a fresh RK; the old shares no longer match.
    const fresh = rotateRecovery(USER, u.amk);
    await expect(combineRecoveryShares(shares.slice(0, 3), fresh.rkCommitment)).rejects.toMatchObject({ code: 'bad_share' });
  });
});
