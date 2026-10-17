import { describe, expect, it } from 'vitest';
import { FILE_CHUNK_SIZE, decryptFile, encryptFile, newSymmetricKey, randomBytes } from '../src/index';
import { MAX_FILE_SIZE } from '../src/files';
import { concat, ctEqual } from '../src/encoding';
import { expectCode } from './helpers';

const SEALED = FILE_CHUNK_SIZE + 16;
const HEADER = 17;

function data(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) out.set(randomBytes(Math.min(65536, n - off)), off);
  return out;
}

describe('encryptFile / decryptFile', () => {
  it('round-trips empty, small, exact-multiple and multi-chunk odd sizes', () => {
    for (const n of [0, 1, 1000, FILE_CHUNK_SIZE - 1, FILE_CHUNK_SIZE, FILE_CHUNK_SIZE + 1, 2 * FILE_CHUNK_SIZE, 200 * 1024 + 13]) {
      const d = data(n);
      const { key, ciphertext } = encryptFile(d, 'media/user-a/f1');
      expect(key.length).toBe(32);
      expect(ciphertext.length).toBe(HEADER + n + Math.max(1, Math.ceil(n / FILE_CHUNK_SIZE)) * 16);
      expect(ctEqual(decryptFile(ciphertext, key, 'media/user-a/f1'), d)).toBe(true);
    }
  }, 60_000);

  it('uses a fresh key per file', () => {
    const d = data(10);
    const a = encryptFile(d, 'f');
    const b = encryptFile(d, 'f');
    expect(a.key).not.toEqual(b.key);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  describe('multi-chunk attacks (200 KiB + 13 bytes = 4 chunks)', () => {
    const d = data(200 * 1024 + 13);
    const { key, ciphertext } = encryptFile(d, 'f1');
    const chunk = (i: number) => ciphertext.subarray(HEADER + i * SEALED, Math.min(ciphertext.length, HEADER + (i + 1) * SEALED));
    const head = ciphertext.subarray(0, HEADER);

    it('truncation at a chunk boundary is detected', () => {
      for (let k = 1; k <= 3; k++) expectCode(() => decryptFile(ciphertext.subarray(0, HEADER + k * SEALED), key, 'f1'), 'decrypt_failed');
    });
    it('truncation inside a chunk, and dropping everything, are detected', () => {
      expectCode(() => decryptFile(ciphertext.subarray(0, ciphertext.length - 1), key, 'f1'), 'decrypt_failed');
      expectCode(() => decryptFile(ciphertext.subarray(0, HEADER + SEALED + 5), key, 'f1'), 'decrypt_failed');
      expectCode(() => decryptFile(ciphertext.subarray(0, HEADER), key, 'f1'), 'decrypt_failed');
      expectCode(() => decryptFile(new Uint8Array(0), key, 'f1'), 'decrypt_failed');
    });
    it('a trailing fragment shorter than a tag is rejected', () => {
      expectCode(() => decryptFile(concat(ciphertext.subarray(0, HEADER + 4 * SEALED - SEALED), chunk(3), new Uint8Array(0)).subarray(0, HEADER + 3 * SEALED + 5), key, 'f1'), 'decrypt_failed');
      expectCode(() => decryptFile(concat(head, chunk(0), new Uint8Array(10)), key, 'f1'), 'decrypt_failed');
    });
    it('chunk reordering is detected', () => {
      expectCode(() => decryptFile(concat(head, chunk(1), chunk(0), chunk(2), chunk(3)), key, 'f1'), 'decrypt_failed');
      expectCode(() => decryptFile(concat(head, chunk(0), chunk(2), chunk(1), chunk(3)), key, 'f1'), 'decrypt_failed');
    });
    it('chunk duplication / extension is detected', () => {
      expectCode(() => decryptFile(concat(ciphertext, chunk(3)), key, 'f1'), 'decrypt_failed');
      expectCode(() => decryptFile(concat(head, chunk(0), chunk(0), chunk(2), chunk(3)), key, 'f1'), 'decrypt_failed');
    });
    it('splicing chunks from another file is detected', () => {
      const other = encryptFile(d, 'f1');
      const oc = other.ciphertext.subarray(HEADER + SEALED, HEADER + 2 * SEALED);
      expectCode(() => decryptFile(concat(head, chunk(0), oc, chunk(2), chunk(3)), key, 'f1'), 'decrypt_failed');
    });
    it('any flipped byte (sampled across header, every chunk and every tag) is detected', () => {
      const positions = [0, 1, 16, HEADER, HEADER + 100, HEADER + SEALED - 1, HEADER + SEALED, HEADER + 2 * SEALED + 7, ciphertext.length - 17, ciphertext.length - 1];
      for (const p of positions) {
        const c = new Uint8Array(ciphertext);
        c[p] = c[p]! ^ 0x80;
        expectCode(() => decryptFile(c, key, 'f1'), 'decrypt_failed');
      }
    });
    it('wrong fileId or key is detected', () => {
      expectCode(() => decryptFile(ciphertext, key, 'f2'), 'decrypt_failed');
      expectCode(() => decryptFile(ciphertext, newSymmetricKey(), 'f1'), 'decrypt_failed');
    });
  });

  it('validates inputs', () => {
    expectCode(() => encryptFile('x' as unknown as Uint8Array, 'f'), 'invalid_input');
    expectCode(() => encryptFile(new Uint8Array(1), ''), 'invalid_input');
    expectCode(() => encryptFile(new Uint8Array(MAX_FILE_SIZE + 1), 'f'), 'invalid_input');
    const { key, ciphertext } = encryptFile(new Uint8Array(1), 'f');
    expectCode(() => decryptFile(ciphertext, new Uint8Array(16), 'f'), 'invalid_input');
    expectCode(() => decryptFile(ciphertext, key, ''), 'invalid_input');
    expectCode(() => decryptFile([] as unknown as Uint8Array, key, 'f'), 'invalid_input');
  });
});
