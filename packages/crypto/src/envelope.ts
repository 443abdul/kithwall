/**
 * Envelopes (spec §3.8): posts, comments, albums, notes, events, profile info…
 *
 *   H    = canonicalJson(header)                       (header is validated + normalised first)
 *   CK   = fresh 32-byte content key
 *   wk   = pack(XChaCha(audienceKey, CK, aad = "kithwall/v1/envelope/wk\n" + H))
 *   n,ct = XChaCha(CK, canonicalJson(payload), aad = "kithwall/v1/envelope/ct\n" + H)
 *   sig  = Ed25519(signPriv, canonicalJson({ d:"kithwall/v1/envelope-sig", header, wk?, n?, ct?, body? }))
 *
 * Public items carry `body` (the payload in the clear) instead of wk/n/ct, and are still signed.
 * Comment-style items (sealWithContentKey) carry n/ct but no wk.
 *
 * Opening always verifies the signature FIRST (`bad_signature`), then decrypts (`decrypt_failed`).
 */
import { fail, invalid } from './errors';
import { assertBytes, assertString, b64u, canonicalJson, fromUtf8, randomBytes, utf8, wipe } from './encoding';
import { KEY_LEN, NONCE_LEN, TAG_LEN, aeadDecrypt, aeadEncrypt, edSign, edVerifyB64, hkdfSha256, packDecrypt, packEncrypt } from './primitives';

export type Audience = { id: string; epoch: number } | 'self' | 'public';

export interface EnvelopeHeader {
  v: 1;
  type: string;
  id: string;
  author: string;
  wall?: string;
  audience: Audience;
}

export interface Envelope {
  v: 1;
  wk?: string;
  n?: string;
  ct?: string;
  body?: unknown;
  sig: string;
}

/** Maximum serialized payload size (4 MiB). */
export const MAX_PAYLOAD = 4 * 1024 * 1024;

/** Validates a header and returns a normalised copy (no undefined fields, no extra fields). */
export function normalizeHeader(header: EnvelopeHeader): EnvelopeHeader {
  if (typeof header !== 'object' || header === null || header.v !== 1) invalid('header.v must be 1');
  assertString(header.type, 'header.type', 64);
  assertString(header.id, 'header.id');
  assertString(header.author, 'header.author');
  const out: EnvelopeHeader = { v: 1, type: header.type, id: header.id, author: header.author, audience: 'self' };
  if (header.wall !== undefined) {
    assertString(header.wall, 'header.wall');
    out.wall = header.wall;
  }
  const a = header.audience;
  if (a === 'self' || a === 'public') {
    out.audience = a;
  } else if (typeof a === 'object' && a !== null) {
    assertString(a.id, 'header.audience.id');
    if (!Number.isSafeInteger(a.epoch) || a.epoch < 0 || a.epoch > 0x7fffffff) invalid('header.audience.epoch must be a non-negative integer');
    out.audience = { id: a.id, epoch: a.epoch };
  } else {
    invalid('header.audience must be {id, epoch}, "self" or "public"');
  }
  return out;
}

function headerJson(h: EnvelopeHeader): string {
  return canonicalJson(h);
}

function wkAad(h: EnvelopeHeader): Uint8Array {
  return utf8('kithwall/v1/envelope/wk\n' + headerJson(h));
}

function ctAad(h: EnvelopeHeader): Uint8Array {
  return utf8('kithwall/v1/envelope/ct\n' + headerJson(h));
}

interface SignedFields {
  wk?: string;
  n?: string;
  ct?: string;
  body?: unknown;
}

function sigMessage(h: EnvelopeHeader, f: SignedFields): Uint8Array {
  const m: Record<string, unknown> = { d: 'kithwall/v1/envelope-sig', header: h };
  if (f.wk !== undefined) m.wk = f.wk;
  if (f.n !== undefined) m.n = f.n;
  if (f.ct !== undefined) m.ct = f.ct;
  if (f.body !== undefined) m.body = f.body;
  return utf8(canonicalJson(m));
}

function serializePayload(payload: unknown): Uint8Array {
  const bytes = utf8(canonicalJson(payload));
  if (bytes.length > MAX_PAYLOAD) invalid('payload too large');
  return bytes;
}

function signEnvelope(h: EnvelopeHeader, f: SignedFields, signPriv: Uint8Array): Envelope {
  const sig = b64u.encode(edSign(sigMessage(h, f), signPriv));
  return { v: 1, ...f, sig };
}

function encryptPayload(h: EnvelopeHeader, payload: unknown, contentKey: Uint8Array): { n: string; ct: string } {
  const { nonce, ct } = aeadEncrypt(contentKey, serializePayload(payload), ctAad(h));
  return { n: b64u.encode(nonce), ct: b64u.encode(ct) };
}

export function sealEnvelope<T>(args: { header: EnvelopeHeader; payload: T; audienceKey?: Uint8Array; signPriv: Uint8Array }): Envelope {
  const h = normalizeHeader(args.header);
  assertBytes(args.signPriv, 'signPriv', KEY_LEN);
  if (h.audience === 'public') {
    if (args.audienceKey !== undefined) invalid('public envelopes take no audienceKey');
    const body: unknown = JSON.parse(canonicalJson(args.payload));
    serializePayload(body);
    return signEnvelope(h, { body }, args.signPriv);
  }
  assertBytes(args.audienceKey, 'audienceKey', KEY_LEN);
  const ck = randomBytes(KEY_LEN);
  try {
    const wk = packEncrypt(args.audienceKey, ck, wkAad(h));
    const { n, ct } = encryptPayload(h, args.payload, ck);
    return signEnvelope(h, { wk, n, ct }, args.signPriv);
  } finally {
    wipe(ck);
  }
}

/**
 * Checks the envelope's shape against the header and verifies the signature.
 * Anything that does not verify (including malformed envelopes) is `bad_signature`.
 */
function verifyEnvelope(h: EnvelopeHeader, env: Envelope, signPub: Uint8Array): SignedFields {
  assertBytes(signPub, 'signPub', KEY_LEN);
  if (typeof env !== 'object' || env === null || env.v !== 1) fail('bad_signature', 'malformed envelope');
  const allowed = new Set(['v', 'wk', 'n', 'ct', 'body', 'sig']);
  for (const k of Object.keys(env)) if (!allowed.has(k)) fail('bad_signature', 'unexpected envelope field');
  const f: SignedFields = {};
  if (h.audience === 'public') {
    if (env.wk !== undefined || env.n !== undefined || env.ct !== undefined || env.body === undefined) fail('bad_signature', 'envelope does not match public header');
    f.body = env.body;
  } else {
    if (env.body !== undefined || typeof env.n !== 'string' || typeof env.ct !== 'string') fail('bad_signature', 'envelope does not match encrypted header');
    if (env.wk !== undefined && typeof env.wk !== 'string') fail('bad_signature', 'malformed envelope');
    if (env.wk !== undefined) f.wk = env.wk;
    f.n = env.n;
    f.ct = env.ct;
  }
  let msg: Uint8Array;
  try {
    msg = sigMessage(h, f);
  } catch {
    return fail('bad_signature', 'malformed envelope body');
  }
  if (!edVerifyB64(env.sig, msg, signPub)) fail('bad_signature', 'envelope signature invalid');
  return f;
}

function unwrapContentKey(h: EnvelopeHeader, wk: string | undefined, audienceKey: Uint8Array): Uint8Array {
  if (wk === undefined) fail('decrypt_failed', 'envelope has no wrapped content key');
  const ck = packDecrypt(audienceKey, wk, wkAad(h));
  if (ck.length !== KEY_LEN) fail('decrypt_failed', 'malformed content key');
  return ck;
}

function decryptPayload<T>(h: EnvelopeHeader, f: SignedFields, contentKey: Uint8Array): T {
  let nonce: Uint8Array, ct: Uint8Array;
  try {
    nonce = b64u.decode(f.n as string);
    ct = b64u.decode(f.ct as string);
  } catch {
    return fail('decrypt_failed', 'malformed ciphertext');
  }
  if (nonce.length !== NONCE_LEN || ct.length < TAG_LEN) fail('decrypt_failed', 'malformed ciphertext');
  const pt = aeadDecrypt(contentKey, nonce, ct, ctAad(h));
  try {
    return JSON.parse(fromUtf8(pt)) as T;
  } catch {
    return fail('decrypt_failed', 'payload is not valid JSON');
  } finally {
    wipe(pt);
  }
}

export function openEnvelope<T>(args: { header: EnvelopeHeader; envelope: Envelope; audienceKey?: Uint8Array; signPub: Uint8Array }): T {
  const h = normalizeHeader(args.header);
  if (h.audience !== 'public') assertBytes(args.audienceKey, 'audienceKey', KEY_LEN);
  const f = verifyEnvelope(h, args.envelope, args.signPub);
  if (h.audience === 'public') return f.body as T;
  const ck = unwrapContentKey(h, f.wk, args.audienceKey as Uint8Array);
  try {
    return decryptPayload<T>(h, f, ck);
  } finally {
    wipe(ck);
  }
}

/**
 * Unwraps an envelope's content key (for comments and abuse reports). If
 * `signPub` is given the signature is verified first; callers that omit it
 * must already have verified the envelope with openEnvelope.
 */
export function extractContentKey(args: { header: EnvelopeHeader; envelope: Envelope; audienceKey: Uint8Array; signPub?: Uint8Array }): Uint8Array {
  const h = normalizeHeader(args.header);
  if (h.audience === 'public') invalid('public envelopes have no content key');
  assertBytes(args.audienceKey, 'audienceKey', KEY_LEN);
  if (args.signPub !== undefined) verifyEnvelope(h, args.envelope, args.signPub);
  const env = args.envelope;
  if (typeof env !== 'object' || env === null || (env.wk !== undefined && typeof env.wk !== 'string')) fail('decrypt_failed', 'malformed envelope');
  return unwrapContentKey(h, env.wk, args.audienceKey);
}

/** Comments: encrypted directly under `contentKey` (pass deriveSubkey(postCK, 'comment', commentId)); no wk. */
export function sealWithContentKey<T>(args: { header: EnvelopeHeader; payload: T; contentKey: Uint8Array; signPriv: Uint8Array }): Envelope {
  const h = normalizeHeader(args.header);
  if (h.audience === 'public') invalid('public envelopes are not encrypted');
  assertBytes(args.contentKey, 'contentKey', KEY_LEN);
  assertBytes(args.signPriv, 'signPriv', KEY_LEN);
  const { n, ct } = encryptPayload(h, args.payload, args.contentKey);
  return signEnvelope(h, { n, ct }, args.signPriv);
}

/**
 * Opens an envelope with a known content key: comment envelopes (no wk), or a
 * full envelope whose content key was disclosed (abuse reports).
 */
export function openWithContentKey<T>(args: { header: EnvelopeHeader; envelope: Envelope; contentKey: Uint8Array; signPub: Uint8Array }): T {
  const h = normalizeHeader(args.header);
  if (h.audience === 'public') invalid('public envelopes are not encrypted');
  assertBytes(args.contentKey, 'contentKey', KEY_LEN);
  const f = verifyEnvelope(h, args.envelope, args.signPub);
  return decryptPayload<T>(h, f, args.contentKey);
}

const LABEL_RE = /^[a-z0-9-]{1,32}$/;

/** HKDF-SHA-256(key, info = "kithwall/v1/subkey/<label>/<id>"). Labels are [a-z0-9-]{1,32}. */
export function deriveSubkey(key: Uint8Array, label: string, id: string): Uint8Array {
  assertBytes(key, 'key', KEY_LEN);
  if (typeof label !== 'string' || !LABEL_RE.test(label)) invalid('label must match [a-z0-9-]{1,32}');
  assertString(id, 'id');
  return hkdfSha256(key, `kithwall/v1/subkey/${label}/${id}`);
}
