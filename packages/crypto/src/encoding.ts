/**
 * Encoding, randomness and small byte helpers.
 *
 * Everything here is browser / Web Worker safe: no Buffer, no node:crypto.
 */
import { invalid } from './errors';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REVERSE: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** Upper bound on any base64url string we are willing to decode (~96 MiB of output). */
export const MAX_B64U_LENGTH = 128 * 1024 * 1024;

/**
 * Base64url without padding (RFC 4648 §5). Decoding is strict: it rejects
 * padding, whitespace, characters outside the alphabet, impossible lengths and
 * non-canonical trailing bits, so every byte string has exactly one encoding.
 * Decode errors throw KithwallCryptoError('invalid_input').
 */
export const b64u = {
  encode(b: Uint8Array): string {
    if (!(b instanceof Uint8Array)) invalid('b64u.encode expects a Uint8Array');
    const parts: string[] = [];
    let i = 0;
    for (; i + 2 < b.length; i += 3) {
      const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
      parts.push(ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!);
    }
    const rest = b.length - i;
    if (rest === 1) {
      const n = b[i]! << 16;
      parts.push(ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!);
    } else if (rest === 2) {
      const n = (b[i]! << 16) | (b[i + 1]! << 8);
      parts.push(ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!);
    }
    return parts.join('');
  },

  decode(s: string): Uint8Array {
    if (typeof s !== 'string') invalid('b64u.decode expects a string');
    if (s.length > MAX_B64U_LENGTH) invalid('base64url input too long');
    if (s.length % 4 === 1) invalid('invalid base64url length');
    const vals = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const v = c < 128 ? REVERSE[c]! : -1;
      if (v < 0) invalid('invalid base64url character');
      vals[i] = v;
    }
    const out = new Uint8Array(Math.floor((s.length * 3) / 4));
    let o = 0;
    let i = 0;
    for (; i + 3 < s.length; i += 4) {
      const n = (vals[i]! << 18) | (vals[i + 1]! << 12) | (vals[i + 2]! << 6) | vals[i + 3]!;
      out[o++] = (n >> 16) & 255;
      out[o++] = (n >> 8) & 255;
      out[o++] = n & 255;
    }
    const rest = s.length - i;
    if (rest === 2) {
      if ((vals[i + 1]! & 15) !== 0) invalid('non-canonical base64url');
      out[o++] = ((vals[i]! << 2) | (vals[i + 1]! >> 4)) & 255;
    } else if (rest === 3) {
      if ((vals[i + 2]! & 3) !== 0) invalid('non-canonical base64url');
      const n = (vals[i]! << 18) | (vals[i + 1]! << 12) | (vals[i + 2]! << 6);
      out[o++] = (n >> 16) & 255;
      out[o++] = (n >> 8) & 255;
    }
    return out;
  },
};

/** Largest single request accepted by randomBytes (1 MiB). */
const MAX_RANDOM = 1024 * 1024;
/** getRandomValues refuses more than 65 536 bytes per call. */
const RANDOM_CHUNK = 65536;

/** Cryptographically secure random bytes from WebCrypto (`crypto.getRandomValues`). */
export function randomBytes(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_RANDOM) invalid('randomBytes: n must be an integer in [1, 1 MiB]');
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') invalid('WebCrypto getRandomValues is unavailable');
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += RANDOM_CHUNK) {
    c.getRandomValues(out.subarray(off, Math.min(n, off + RANDOM_CHUNK)));
  }
  return out;
}

/** A fresh random 32-byte symmetric key. */
export function newSymmetricKey(): Uint8Array {
  return randomBytes(32);
}

const MAX_DEPTH = 64;

/**
 * Deterministic JSON: object keys sorted (UTF-16 code-unit order), no
 * whitespace. Only plain objects, arrays, strings, finite numbers, booleans and
 * null are allowed. undefined (including undefined-valued properties), NaN and
 * ±Infinity, functions, symbols, bigints, sparse arrays, cycles and class
 * instances (Date, Map, Uint8Array…) are rejected with `invalid_input`.
 */
export function canonicalJson(v: unknown): string {
  return canon(v, new Set<object>(), 0);
}

function canon(v: unknown, seen: Set<object>, depth: number): string {
  if (depth > MAX_DEPTH) invalid('canonicalJson: nesting too deep');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) invalid('canonicalJson: non-finite number');
      return JSON.stringify(v);
    case 'object': {
      if (seen.has(v)) invalid('canonicalJson: cycle');
      seen.add(v);
      let out: string;
      if (Array.isArray(v)) {
        const parts: string[] = [];
        for (let i = 0; i < v.length; i++) {
          if (!(i in v)) invalid('canonicalJson: sparse array');
          parts.push(canon(v[i], seen, depth + 1));
        }
        out = '[' + parts.join(',') + ']';
      } else {
        const proto: unknown = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) invalid('canonicalJson: only plain objects are allowed');
        if (Object.getOwnPropertySymbols(v).length > 0) invalid('canonicalJson: symbol keys are not allowed');
        const rec = v as Record<string, unknown>;
        const keys = Object.keys(rec).sort();
        out = '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(rec[k], seen, depth + 1)).join(',') + '}';
      }
      seen.delete(v);
      return out;
    }
    default:
      // undefined, function, symbol, bigint
      return invalid(`canonicalJson: unsupported value of type ${typeof v}`);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers shared by the other modules (not part of the public API).
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Strict UTF-8 decode (throws on malformed input). */
export function fromUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 8-byte big-endian encoding of a non-negative safe integer. */
export function u64be(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) invalid('u64be: bad integer');
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(n / 0x100000000));
  view.setUint32(4, n >>> 0);
  return out;
}

/**
 * Length-prefixed concatenation (4-byte big-endian length before each part).
 * Used whenever several variable-length values feed one hash so that the
 * encoding is unambiguous.
 */
export function lp(...parts: (Uint8Array | string)[]): Uint8Array {
  const bufs: Uint8Array[] = [];
  for (const p of parts) {
    const b = typeof p === 'string' ? utf8(p) : p;
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length);
    bufs.push(len, b);
  }
  return concat(...bufs);
}

/** Constant-time equality for byte strings (only the length may leak). */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Best-effort wipe of secret intermediates (JS gives no hard guarantees). */
export function wipe(...arrays: (Uint8Array | undefined)[]): void {
  for (const a of arrays) if (a) a.fill(0);
}

export function assertBytes(v: unknown, name: string, len?: number): asserts v is Uint8Array {
  if (!(v instanceof Uint8Array)) invalid(`${name} must be a Uint8Array`);
  if (len !== undefined && v.length !== len) invalid(`${name} must be ${len} bytes`);
}

export function assertString(v: unknown, name: string, maxLen = 256): asserts v is string {
  if (typeof v !== 'string' || v.length === 0) invalid(`${name} must be a non-empty string`);
  if (v.length > maxLen) invalid(`${name} is too long`);
}

/** Decode a base64url field that must be exactly `len` bytes; errors are `invalid_input`. */
export function decodeFixed(s: unknown, name: string, len: number): Uint8Array {
  if (typeof s !== 'string') invalid(`${name} must be a base64url string`);
  const b = b64u.decode(s);
  if (b.length !== len) invalid(`${name} must decode to ${len} bytes`);
  return b;
}
