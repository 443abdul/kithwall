// Web Push message encryption (RFC 8291, "aes128gcm" content coding, RFC 8188) for the native apps
// (docs/v2/05-native.md §5). The same "who + what" JSON that browsers get is encrypted to a P-256 key
// pair that the app made on the device (Android Keystore-wrapped / iOS Keychain); the push provider
// (FCM, APNs, a UnifiedPush distributor) only ever carries ciphertext. The apps decrypt with the same
// steps (KithwallPush on Android, NotificationService on iOS).
//
// Pure node:crypto, no server-only import, so it is unit-tested against the RFC 8291 example.
import { createCipheriv, createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';

const RECORD_SIZE = 4096;
const enc = new TextEncoder();

function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HKDF-SHA-256 extract + expand, for outputs of at most 32 bytes. */
function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);
}

export const b64uDecode = (s: string): Buffer => Buffer.from(s, 'base64url');
export const b64uEncode = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

/** A 65-byte uncompressed P-256 point (0x04 ‖ X ‖ Y), base64url. */
export const isP256Point = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{86,88}={0,2}$/.test(s) && b64uDecode(s).length === 65 && b64uDecode(s)[0] === 4;
/** A 16-byte auth secret, base64url. */
export const isAuthSecret = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{21,24}={0,2}$/.test(s) && b64uDecode(s).length === 16;

function deriveKeys(ecdhSecret: Uint8Array, authSecret: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array) {
  const keyInfo = Buffer.concat([enc.encode('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  return { cek, nonce };
}

export interface EncryptOptions {
  /** Test hooks only (RFC 8291 example): a fixed sender key and salt. */
  asPrivate?: Uint8Array;
  salt?: Uint8Array;
  /** Pad the plaintext to a multiple of this many bytes (hides the exact length); default 64. */
  padTo?: number;
}

/**
 * Encrypt one push message to a device key: returns the complete aes128gcm body
 * (salt ‖ rs ‖ idlen ‖ keyid=as_public ‖ AES-128-GCM(record ‖ 0x02 ‖ zero padding)).
 */
export function encryptPush(uaPublicB64u: string, authSecretB64u: string, plaintext: Uint8Array | string, opts: EncryptOptions = {}): Buffer {
  const uaPublic = b64uDecode(uaPublicB64u);
  const authSecret = b64uDecode(authSecretB64u);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad device public key');
  if (authSecret.length !== 16) throw new Error('bad auth secret');
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const ecdh = createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(Buffer.from(opts.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(undefined, 'uncompressed');
  const secret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ? Buffer.from(opts.salt) : randomBytes(16);
  const { cek, nonce } = deriveKeys(secret, authSecret, uaPublic, asPublic, salt);

  const padTo = opts.padTo ?? 64;
  const padLen = padTo > 1 ? (padTo - ((data.length + 1) % padTo)) % padTo : 0;
  const record = Buffer.concat([data, Buffer.from([2]), Buffer.alloc(padLen)]);
  if (record.length + 16 > RECORD_SIZE) throw new Error('push payload too large');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/**
 * Reference decryption (the receiving device's side), used by the tests and mirrored by the native
 * code. Throws on any tampering.
 */
export function decryptPush(uaPrivate: Uint8Array, authSecretB64u: string, message: Uint8Array): Buffer {
  const m = Buffer.from(message);
  if (m.length < 21 + 65 + 17) throw new Error('short message');
  const salt = m.subarray(0, 16);
  const rs = m.readUInt32BE(16);
  const idlen = m[20]!;
  if (idlen !== 65 || rs < 18) throw new Error('bad header');
  const asPublic = m.subarray(21, 21 + idlen);
  const ct = m.subarray(21 + idlen);
  if (ct.length > rs) throw new Error('multiple records are not used');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(uaPrivate));
  const uaPublic = ecdh.getPublicKey(undefined, 'uncompressed');
  const secret = ecdh.computeSecret(asPublic);
  const { cek, nonce } = deriveKeys(secret, b64uDecode(authSecretB64u), uaPublic, asPublic, salt);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const record = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (end < 0 || record[end] !== 2) throw new Error('bad padding');
  return record.subarray(0, end);
}
