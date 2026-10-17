import { describe, expect, it } from 'vitest';
import { b64u, canonicalJson, decryptBlob, encryptBlob, newSymmetricKey, randomBytes } from '../src/index';
import { concat, ctEqual, decodeFixed, fromUtf8, lp, u64be, wipe } from '../src/encoding';
import { packDecrypt, packEncrypt, hkdfSha256, edVerify, edVerifyB64, aeadDecrypt, xShared } from '../src/primitives';
import { MAX_BLOB } from '../src/blob';
import { expectCode, flipB64, toHex } from './helpers';

describe('b64u', () => {
  it('round-trips all lengths 0..64 and matches RFC 4648 vectors', () => {
    for (let n = 0; n <= 64; n++) {
      const b = randomBytes(n || 1).subarray(0, n);
      expect(b64u.decode(b64u.encode(b))).toEqual(b);
    }
    const enc = (s: string) => b64u.encode(new TextEncoder().encode(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('Zg');
    expect(enc('fo')).toBe('Zm8');
    expect(enc('foo')).toBe('Zm9v');
    expect(enc('foobar')).toBe('Zm9vYmFy');
    expect(b64u.encode(Uint8Array.of(0xfb, 0xff))).toBe('-_8');
  });

  it('rejects padding, bad characters, bad lengths, non-canonical bits and non-strings', () => {
    expectCode(() => b64u.decode('Zg=='), 'invalid_input');
    expectCode(() => b64u.decode('Zm9v+'), 'invalid_input');
    expectCode(() => b64u.decode('Zm 9'), 'invalid_input');
    expectCode(() => b64u.decode('Zm9vé'), 'invalid_input');
    expectCode(() => b64u.decode('Z'), 'invalid_input');
    expectCode(() => b64u.decode('Zh'), 'invalid_input'); // trailing bits set
    expectCode(() => b64u.decode('Zm9'), 'invalid_input');
    expectCode(() => b64u.decode(42 as unknown as string), 'invalid_input');
    expectCode(() => b64u.encode('x' as unknown as Uint8Array), 'invalid_input');
    expectCode(() => b64u.decode('A'.repeat(128 * 1024 * 1024 + 4)), 'invalid_input');
  });
});

describe('randomness', () => {
  it('returns the requested length and is not constant', () => {
    expect(randomBytes(1).length).toBe(1);
    const big = randomBytes(200_000);
    expect(big.length).toBe(200_000);
    expect(big.subarray(150_000).some((x) => x !== 0)).toBe(true);
    expect(newSymmetricKey().length).toBe(32);
    expect(toHex(newSymmetricKey())).not.toBe(toHex(newSymmetricKey()));
  });
  it('validates n', () => {
    for (const n of [0, -1, 1.5, NaN, 1024 * 1024 + 1]) expectCode(() => randomBytes(n), 'invalid_input');
  });
  it('fails closed without WebCrypto', () => {
    const orig = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expectCode(() => randomBytes(8), 'invalid_input');
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: orig, configurable: true });
    }
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively without whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x', { d: 2, c: -0.5 }], ä: false })).toBe(
      '{"a":[true,null,"x",{"c":-0.5,"d":2}],"b":1,"ä":false}',
    );
    expect(canonicalJson(Object.create(null))).toBe('{}');
    expect(canonicalJson(' "')).toBe(JSON.stringify(' "'));
  });
  it('allows repeated (non-cyclic) references', () => {
    const shared = { x: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"x":1},{"x":1}]');
  });
  it('rejects undefined, NaN, Infinity, functions, symbols, bigint, class instances, cycles, sparse arrays, deep nesting', () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = [deep];
    const bad: unknown[] = [
      undefined,
      { a: undefined },
      NaN,
      Infinity,
      () => 1,
      Symbol('s'),
      10n,
      new Date(0),
      new Uint8Array(1),
      new Map(),
      cyc,
      [1, , 2],
      { [Symbol('k')]: 1 },
      deep,
    ];
    for (const v of bad) expectCode(() => canonicalJson(v), 'invalid_input');
  });
});

describe('internal helpers', () => {
  it('u64be, lp, concat, ctEqual, wipe, decodeFixed, fromUtf8', () => {
    expect(toHex(u64be(0x0102030405))).toBe('0000000102030405');
    expect(toHex(u64be(Number.MAX_SAFE_INTEGER))).toBe('001fffffffffffff');
    expectCode(() => u64be(-1), 'invalid_input');
    expect(toHex(lp('a', Uint8Array.of(1, 2)))).toBe('00000001610000000201' + '02');
    expect(concat()).toEqual(new Uint8Array(0));
    expect(ctEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(ctEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(ctEqual(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
    const w = Uint8Array.of(9, 9);
    wipe(w, undefined);
    expect(w).toEqual(new Uint8Array(2));
    expectCode(() => decodeFixed(5, 'x', 1), 'invalid_input');
    expectCode(() => decodeFixed('AAAA', 'x', 2), 'invalid_input');
    expect(() => fromUtf8(Uint8Array.of(0xff))).toThrow();
  });

  it('primitives wrappers fail closed', () => {
    const key = newSymmetricKey();
    expectCode(() => hkdfSha256(new Uint8Array(0), 'x'), 'invalid_input');
    expect(edVerify(new Uint8Array(63), new Uint8Array(0), new Uint8Array(32))).toBe(false);
    expect(edVerify(new Uint8Array(64), new Uint8Array(0), new Uint8Array(31))).toBe(false);
    expect(edVerify(new Uint8Array(64), new Uint8Array(0), new Uint8Array(32).fill(0xff))).toBe(false);
    expect(edVerifyB64(123, new Uint8Array(0), new Uint8Array(32))).toBe(false);
    expect(edVerifyB64('***', new Uint8Array(0), new Uint8Array(32))).toBe(false);
    expectCode(() => aeadDecrypt(key, new Uint8Array(23), new Uint8Array(16), new Uint8Array(0)), 'decrypt_failed');
    expectCode(() => xShared(new Uint8Array(32).fill(1), new Uint8Array(32)), 'invalid_input'); // low-order point
    const blob = packEncrypt(key, Uint8Array.of(1), new Uint8Array(0));
    expect(packDecrypt(key, blob, new Uint8Array(0))).toEqual(Uint8Array.of(1));
    expectCode(() => packDecrypt(key, '!!', new Uint8Array(0)), 'decrypt_failed');
    expectCode(() => packDecrypt(key, 'AAAA', new Uint8Array(0)), 'decrypt_failed');
    const raw = b64u.decode(blob);
    raw[0] = 2;
    expectCode(() => packDecrypt(key, b64u.encode(raw), new Uint8Array(0)), 'decrypt_failed');
  });
});

describe('encryptBlob / decryptBlob', () => {
  const key = newSymmetricKey();
  const data = new TextEncoder().encode('private settings');

  it('round-trips, including empty data', () => {
    expect(decryptBlob(key, encryptBlob(key, data, 'settings'), 'settings')).toEqual(data);
    expect(decryptBlob(key, encryptBlob(key, new Uint8Array(0), 'e'), 'e')).toEqual(new Uint8Array(0));
  });
  it('uses fresh nonces', () => {
    expect(encryptBlob(key, data, 'a')).not.toBe(encryptBlob(key, data, 'a'));
  });
  it('rejects wrong key, wrong aad and every flipped byte', () => {
    const blob = encryptBlob(key, data, 'settings');
    expectCode(() => decryptBlob(newSymmetricKey(), blob, 'settings'), 'decrypt_failed');
    expectCode(() => decryptBlob(key, blob, 'settingz'), 'decrypt_failed');
    const len = b64u.decode(blob).length;
    for (let i = 0; i < len; i++) expectCode(() => decryptBlob(key, flipB64(blob, i), 'settings'), 'decrypt_failed');
    expectCode(() => decryptBlob(key, blob.slice(0, -4), 'settings'), 'decrypt_failed');
  });
  it('validates inputs', () => {
    expectCode(() => encryptBlob(new Uint8Array(31), data, 'a'), 'invalid_input');
    expectCode(() => encryptBlob(key, 'x' as unknown as Uint8Array, 'a'), 'invalid_input');
    expectCode(() => encryptBlob(key, data, ''), 'invalid_input');
    expectCode(() => encryptBlob(key, data, 'a'.repeat(513)), 'invalid_input');
    expectCode(() => encryptBlob(key, { length: MAX_BLOB + 1 } as unknown as Uint8Array, 'a'), 'invalid_input');
    expectCode(() => decryptBlob(new Uint8Array(16), 'AAAA', 'a'), 'invalid_input');
  });
  it('rejects oversize data', () => {
    const big = new Uint8Array(MAX_BLOB + 1);
    expectCode(() => encryptBlob(key, big, 'a'), 'invalid_input');
  });
});
