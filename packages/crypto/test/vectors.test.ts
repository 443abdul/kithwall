/**
 * Known-answer tests for every primitive the package relies on.
 */
import { describe, expect, it } from 'vitest';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { argon2id as nobleArgon2id } from '@noble/hashes/argon2.js';
import { argon2id } from 'hash-wasm';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hex, toHex } from './helpers';
import { recoveryKeyFromPhrase } from '../src/index';

describe('HKDF-SHA-256 (RFC 5869 test case 1)', () => {
  it('matches OKM', () => {
    const okm = hkdf(sha256, hex('0b'.repeat(22)), hex('000102030405060708090a0b0c'), hex('f0f1f2f3f4f5f6f7f8f9'), 42);
    expect(toHex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  });
});

describe('XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha-03 §A.3.1)', () => {
  const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
  const nonce = hex('404142434445464748494a4b4c4d4e4f5051525354555657');
  const aad = hex('50515253c0c1c2c3c4c5c6c7');
  const pt = new TextEncoder().encode(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  );
  const expected =
    'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e' +
    'c0875924c1c7987947deafd8780acf49';

  it('encrypts to the published ciphertext ‖ tag', () => {
    expect(toHex(xchacha20poly1305(key, nonce, aad).encrypt(pt))).toBe(expected);
  });
  it('decrypts the published ciphertext', () => {
    expect(xchacha20poly1305(key, nonce, aad).decrypt(hex(expected))).toEqual(pt);
  });
});

describe('X25519 (RFC 7748 §5.2 and §6.1)', () => {
  it('scalar multiplication vector 1', () => {
    const out = x25519.scalarMult(
      hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'),
      hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'),
    );
    expect(toHex(out)).toBe('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552');
  });
  it('Diffie-Hellman example', () => {
    const a = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    const b = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
    expect(toHex(x25519.getPublicKey(a))).toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
    expect(toHex(x25519.getPublicKey(b))).toBe('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
    const k = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
    expect(toHex(x25519.getSharedSecret(a, x25519.getPublicKey(b)))).toBe(k);
    expect(toHex(x25519.getSharedSecret(b, x25519.getPublicKey(a)))).toBe(k);
  });
});

describe('Ed25519 (RFC 8032 §7.1 test 1)', () => {
  const sk = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const pk = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  const sig =
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
  it('derives the public key and signature', () => {
    expect(toHex(ed25519.getPublicKey(sk))).toBe(pk);
    expect(toHex(ed25519.sign(new Uint8Array(0), sk))).toBe(sig);
    expect(ed25519.verify(hex(sig), new Uint8Array(0), hex(pk), { zip215: false })).toBe(true);
  });
});

describe('Argon2id', () => {
  it('RFC 9106 §5.3 vector (with secret and associated data) — noble reference', () => {
    const tag = nobleArgon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
      t: 3,
      m: 32,
      p: 4,
      key: new Uint8Array(8).fill(3),
      personalization: new Uint8Array(12).fill(4),
      dkLen: 32,
    });
    expect(toHex(tag)).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  // hash-wasm (the implementation we ship) has no associated-data input, so the RFC vector
  // cannot be run against it directly. We check it against the reference implementation's
  // argon2id vector and cross-check it against noble (which passed RFC 9106 above).
  it('hash-wasm matches the reference implementation vector (m=64 MiB, t=2, p=1)', async () => {
    const tag = await argon2id({
      password: 'password',
      salt: 'somesalt',
      iterations: 2,
      memorySize: 65536,
      parallelism: 1,
      hashLength: 32,
      outputType: 'hex',
    });
    expect(tag).toBe('09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7');
  });

  it('hash-wasm agrees with noble (including secret, p=4)', async () => {
    for (const [m, t, p] of [
      [32, 3, 4],
      [256, 1, 1],
      [1024, 2, 2],
    ] as const) {
      const password = new Uint8Array(32).fill(1);
      const salt = new Uint8Array(16).fill(2);
      const secret = new Uint8Array(8).fill(3);
      const a = await argon2id({ password, salt, secret, iterations: t, memorySize: m, parallelism: p, hashLength: 32, outputType: 'binary' });
      const b = nobleArgon2id(password, salt, { t, m, p, key: secret, dkLen: 32 });
      expect(toHex(a)).toBe(toHex(b));
    }
  });
});

describe('BIP-39 (official English vectors)', () => {
  it('256-bit zero entropy', () => {
    const phrase = Array(23).fill('abandon').join(' ') + ' art';
    expect(entropyToMnemonic(new Uint8Array(32), wordlist)).toBe(phrase);
    expect(mnemonicToEntropy(phrase, wordlist)).toEqual(new Uint8Array(32));
    expect(recoveryKeyFromPhrase(phrase)).toEqual(new Uint8Array(32));
  });
  it('256-bit 0x7f entropy', () => {
    const phrase =
      'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';
    expect(entropyToMnemonic(new Uint8Array(32).fill(0x7f), wordlist)).toBe(phrase);
    expect(recoveryKeyFromPhrase(phrase)).toEqual(new Uint8Array(32).fill(0x7f));
  });
});
