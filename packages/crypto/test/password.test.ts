import { describe, expect, it } from 'vitest';
import { argon2id } from 'hash-wasm';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { DEFAULT_KDF, b64u, deriveFromPassword, normalizeEmail, passwordSalt, validateKdfParams } from '../src/index';
import { FAST_KDF, WEAK, expectCode, expectCodeAsync, toHex } from './helpers';

const enc = (s: string) => new TextEncoder().encode(s);

describe('salt', () => {
  it('is the first 16 bytes of SHA-256("kithwall/v1/salt" ‖ normalized email)', () => {
    const expected = sha256(enc('kithwall/v1/salt' + 'jessica@example.com')).slice(0, 16);
    expect(passwordSalt('  Jessica@Example.COM \n')).toEqual(expected);
  });
  it('normalizes with NFKC', () => {
    expect(normalizeEmail('ｊｅｓｓ@example.com')).toBe('jess@example.com');
    expect(normalizeEmail('é@x.com')).toBe('é@x.com');
  });
  it('rejects empty / non-string / huge emails', () => {
    expectCode(() => normalizeEmail('   '), 'invalid_input');
    expectCode(() => normalizeEmail(5 as unknown as string), 'invalid_input');
    expectCode(() => normalizeEmail('a'.repeat(321)), 'invalid_input');
  });
});

describe('kdf params', () => {
  it('DEFAULT_KDF is the spec value and frozen', () => {
    expect(DEFAULT_KDF).toEqual({ alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 });
    expect(Object.isFrozen(DEFAULT_KDF)).toBe(true);
  });
  it('enforces structure, bounds and the security floor', () => {
    const bad = [
      null,
      { ...DEFAULT_KDF, alg: 'scrypt' },
      { ...DEFAULT_KDF, v: 2 },
      { ...DEFAULT_KDF, m: 0 },
      { ...DEFAULT_KDF, t: 1.5 },
      { ...DEFAULT_KDF, p: 5 },
      { ...DEFAULT_KDF, t: 17 },
      { ...DEFAULT_KDF, m: 1048577 },
      { ...FAST_KDF, m: 15, p: 2 },
    ];
    for (const b of bad) expectCode(() => validateKdfParams(b as never, WEAK), 'invalid_input');
    expectCode(() => validateKdfParams(FAST_KDF), 'invalid_input');
    expectCode(() => validateKdfParams({ ...DEFAULT_KDF, t: 2 }), 'invalid_input');
    expect(validateKdfParams(FAST_KDF, WEAK)).toEqual(FAST_KDF);
    expect(validateKdfParams({ ...DEFAULT_KDF, extra: 1 } as never)).toEqual(DEFAULT_KDF);
  });
});

describe('deriveFromPassword', () => {
  it('is deterministic and splits into independent authKey / passwordKEK', async () => {
    const a = await deriveFromPassword('jess@example.com', 'correct horse', FAST_KDF, WEAK);
    const b = await deriveFromPassword(' JESS@example.com ', 'correct horse', FAST_KDF, WEAK);
    expect(a.authKey).toBe(b.authKey);
    expect(a.passwordKEK).toEqual(b.passwordKEK);
    expect(b64u.decode(a.authKey).length).toBe(32);
    expect(a.passwordKEK.length).toBe(32);
    expect(toHex(b64u.decode(a.authKey))).not.toBe(toHex(a.passwordKEK));
  });

  it('differs for a different password or email', async () => {
    const a = await deriveFromPassword('jess@example.com', 'correct horse', FAST_KDF, WEAK);
    const c = await deriveFromPassword('jess@example.com', 'correct horsf', FAST_KDF, WEAK);
    const d = await deriveFromPassword('jes@example.com', 'correct horse', FAST_KDF, WEAK);
    expect(c.authKey).not.toBe(a.authKey);
    expect(d.authKey).not.toBe(a.authKey);
  });

  it('normalizes the password with NFKC', async () => {
    const a = await deriveFromPassword('x@y.z', 'café', FAST_KDF, WEAK);
    const b = await deriveFromPassword('x@y.z', 'café', FAST_KDF, WEAK);
    expect(a.authKey).toBe(b.authKey);
  });

  it('with DEFAULT_KDF matches an independent Argon2id(64 MiB, t=3, p=1) + HKDF computation', async () => {
    const email = 'Kevin@Example.com';
    const password = 'hunter2 hunter2';
    const out = await deriveFromPassword(email, password);
    const stretched = await argon2id({
      password: enc(password),
      salt: sha256(enc('kithwall/v1/salt' + 'kevin@example.com')).slice(0, 16),
      iterations: 3,
      memorySize: 65536,
      parallelism: 1,
      hashLength: 32,
      outputType: 'binary',
    });
    expect(out.authKey).toBe(b64u.encode(hkdf(sha256, stretched, undefined, enc('kithwall/v1/auth'), 32)));
    expect(out.passwordKEK).toEqual(hkdf(sha256, stretched, undefined, enc('kithwall/v1/kek'), 32));
  }, 30_000);

  it('validates inputs and refuses weak params by default', async () => {
    await expectCodeAsync(() => deriveFromPassword('x@y.z', '', FAST_KDF, WEAK), 'invalid_input');
    await expectCodeAsync(() => deriveFromPassword('x@y.z', 'a'.repeat(1025), FAST_KDF, WEAK), 'invalid_input');
    await expectCodeAsync(() => deriveFromPassword('x@y.z', 5 as unknown as string, FAST_KDF, WEAK), 'invalid_input');
    await expectCodeAsync(() => deriveFromPassword('', 'pw', FAST_KDF, WEAK), 'invalid_input');
    await expectCodeAsync(() => deriveFromPassword('x@y.z', 'pw', FAST_KDF), 'invalid_input');
  });
});
