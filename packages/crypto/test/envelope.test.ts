import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  type Envelope,
  type EnvelopeHeader,
  b64u,
  canonicalJson,
  deriveSubkey,
  extractContentKey,
  generateIdentity,
  newSymmetricKey,
  openEnvelope,
  openWithContentKey,
  sealEnvelope,
  sealWithContentKey,
} from '../src/index';
import { packEncrypt } from '../src/primitives';
import { expectCode, flipB64, toHex } from './helpers';

const author = generateIdentity();
const mallory = generateIdentity();
const audienceKey = newSymmetricKey();

const header: EnvelopeHeader = { v: 1, type: 'post', id: 'post-1', author: 'user-a', wall: 'user-b', audience: { id: 'aud-1', epoch: 3 } };
const payload = { text: 'Hello wall!', tags: ['user-c'], photo: { key: 'abc', w: 720 }, n: 1.5, ok: true, none: null };

function sealPost(h: EnvelopeHeader = header, p: unknown = payload): Envelope {
  return sealEnvelope({ header: h, payload: p, audienceKey, signPriv: author.signPriv });
}

function open(env: Envelope, h: EnvelopeHeader = header, key = audienceKey, signPub = author.signPub): unknown {
  return openEnvelope({ header: h, envelope: env, audienceKey: key, signPub });
}

/** Signs arbitrary envelope fields as the author (models a malicious author). */
function resign(h: EnvelopeHeader, f: Omit<Envelope, 'v' | 'sig'>, priv = author.signPriv): Envelope {
  const m: Record<string, unknown> = { d: 'kithwall/v1/envelope-sig', header: h };
  for (const k of ['wk', 'n', 'ct', 'body'] as const) if (f[k] !== undefined) m[k] = f[k];
  const sig = b64u.encode(ed25519.sign(new TextEncoder().encode(canonicalJson(m)), priv));
  return { v: 1, ...f, sig };
}

describe('sealEnvelope / openEnvelope', () => {
  it('round-trips for audience and self envelopes, with and without wall', () => {
    expect(open(sealPost())).toEqual(payload);
    const self: EnvelopeHeader = { v: 1, type: 'note', id: 'n1', author: 'user-a', audience: 'self' };
    expect(open(sealPost(self), self)).toEqual(payload);
    const noWall: EnvelopeHeader = { v: 1, type: 'post', id: 'p2', author: 'user-a', wall: undefined, audience: { id: 'aud-1', epoch: 0 } };
    expect(open(sealPost(noWall, 'just a string'), noWall)).toBe('just a string');
  });

  it('produces fresh content keys and nonces', () => {
    const a = sealPost();
    const b = sealPost();
    expect(a.wk).not.toBe(b.wk);
    expect(a.n).not.toBe(b.n);
    expect(b64u.decode(a.n!).length).toBe(24);
  });

  it('every flipped byte of wk / n / ct / sig → bad_signature', () => {
    const env = sealPost();
    for (const f of ['wk', 'n', 'ct', 'sig'] as const) {
      const len = b64u.decode(env[f]!).length;
      for (let i = 0; i < len; i++) expectCode(() => open({ ...env, [f]: flipB64(env[f]!, i) }), 'bad_signature');
    }
  });

  it('any header change (type, id, author, wall, audience id, epoch, audience kind) → bad_signature', () => {
    const env = sealPost();
    const variants: EnvelopeHeader[] = [
      { ...header, type: 'comment' },
      { ...header, id: 'post-2' },
      { ...header, author: 'user-x' },
      { ...header, wall: 'user-x' },
      { ...header, wall: undefined },
      { ...header, audience: { id: 'aud-2', epoch: 3 } },
      { ...header, audience: { id: 'aud-1', epoch: 4 } },
      { ...header, audience: 'self' },
    ];
    for (const h of variants) expectCode(() => open(env, h), 'bad_signature');
    expectCode(() => open(env, { ...header, audience: 'public' }), 'bad_signature');
  });

  it('swapping envelopes between headers → bad_signature', () => {
    const h2: EnvelopeHeader = { ...header, id: 'post-2' };
    const e1 = sealPost();
    const e2 = sealPost(h2, { text: 'other' });
    expectCode(() => open(e2, header), 'bad_signature');
    expectCode(() => open(e1, h2), 'bad_signature');
    // Mixing fields of two envelopes.
    expectCode(() => open({ ...e1, ct: e2.ct, n: e2.n }), 'bad_signature');
    expectCode(() => open({ ...e1, wk: e2.wk }), 'bad_signature');
  });

  it('wrong signer → bad_signature, even if the key is right', () => {
    expectCode(() => open(sealPost(), header, audienceKey, mallory.signPub), 'bad_signature');
    const forged = sealEnvelope({ header, payload, audienceKey, signPriv: mallory.signPriv });
    expectCode(() => open(forged), 'bad_signature');
  });

  it('wrong audience key → decrypt_failed (signature still verified first)', () => {
    expectCode(() => open(sealPost(), header, newSymmetricKey()), 'decrypt_failed');
  });

  it('authentic author but ciphertext moved from another header → decrypt_failed (AAD binding)', () => {
    const h2: EnvelopeHeader = { ...header, id: 'post-2' };
    const e2 = sealPost(h2);
    const moved = resign(header, { wk: e2.wk, n: e2.n, ct: e2.ct });
    expectCode(() => open(moved), 'decrypt_failed');
    // wk from this header but ct from another
    const e1 = sealPost();
    expectCode(() => open(resign(header, { wk: e1.wk, n: e2.n, ct: e2.ct })), 'decrypt_failed');
  });

  it('malformed-but-signed envelopes → decrypt_failed', () => {
    const e = sealPost();
    expectCode(() => open(resign(header, { wk: e.wk, n: '***', ct: e.ct })), 'decrypt_failed');
    expectCode(() => open(resign(header, { wk: e.wk, n: b64u.encode(new Uint8Array(12)), ct: e.ct })), 'decrypt_failed');
    expectCode(() => open(resign(header, { wk: 'AAAA', n: e.n, ct: e.ct })), 'decrypt_failed');
    expectCode(() => open(resign(header, { n: e.n, ct: e.ct })), 'decrypt_failed'); // no wk
    // wk that wraps a 16-byte "key"
    const wk16 = packEncrypt(audienceKey, new Uint8Array(16), new TextEncoder().encode('kithwall/v1/envelope/wk\n' + canonicalJson(header)));
    expectCode(() => open(resign(header, { wk: wk16, n: e.n, ct: e.ct })), 'decrypt_failed');
  });

  it('non-JSON plaintext under a valid key → decrypt_failed', () => {
    const ck = newSymmetricKey();
    const aadCt = new TextEncoder().encode('kithwall/v1/envelope/ct\n' + canonicalJson(header));
    const wk = packEncrypt(audienceKey, ck, new TextEncoder().encode('kithwall/v1/envelope/wk\n' + canonicalJson(header)));
    const raw = b64u.decode(packEncrypt(ck, new TextEncoder().encode('{not json'), aadCt));
    const env = resign(header, { wk, n: b64u.encode(raw.subarray(1, 25)), ct: b64u.encode(raw.subarray(25)) });
    expectCode(() => open(env), 'decrypt_failed');
  });

  it('structural problems → bad_signature', () => {
    const e = sealPost();
    expectCode(() => open(null as unknown as Envelope), 'bad_signature');
    expectCode(() => open({ ...e, v: 2 } as unknown as Envelope), 'bad_signature');
    expectCode(() => open({ ...e, extra: 1 } as unknown as Envelope), 'bad_signature');
    expectCode(() => open({ ...e, body: 'x' }), 'bad_signature');
    expectCode(() => open({ ...e, wk: 5 } as unknown as Envelope), 'bad_signature');
    expectCode(() => open({ ...e, ct: undefined }), 'bad_signature');
    expectCode(() => open({ ...e, sig: '' }), 'bad_signature');
  });

  it('validates headers, keys and payloads', () => {
    const bads: unknown[] = [
      null,
      { ...header, v: 2 },
      { ...header, type: '' },
      { ...header, type: 't'.repeat(65) },
      { ...header, id: 5 },
      { ...header, author: '' },
      { ...header, wall: '' },
      { ...header, audience: 'friends' },
      { ...header, audience: null },
      { ...header, audience: { id: '', epoch: 0 } },
      { ...header, audience: { id: 'a', epoch: -1 } },
      { ...header, audience: { id: 'a', epoch: 1.5 } },
      { ...header, audience: { id: 'a', epoch: 2 ** 31 } },
    ];
    for (const h of bads) expectCode(() => sealPost(h as EnvelopeHeader), 'invalid_input');
    expectCode(() => sealEnvelope({ header, payload, signPriv: author.signPriv }), 'invalid_input'); // no audienceKey
    expectCode(() => sealEnvelope({ header, payload, audienceKey: new Uint8Array(16), signPriv: author.signPriv }), 'invalid_input');
    expectCode(() => sealEnvelope({ header, payload, audienceKey, signPriv: new Uint8Array(1) }), 'invalid_input');
    expectCode(() => sealPost(header, { a: undefined }), 'invalid_input');
    expectCode(() => sealPost(header, { a: NaN }), 'invalid_input');
    expectCode(() => sealPost(header, 'x'.repeat(4 * 1024 * 1024)), 'invalid_input');
    expectCode(() => openEnvelope({ header, envelope: sealPost(), signPub: author.signPub }), 'invalid_input');
    expectCode(() => open(sealPost(), header, audienceKey, new Uint8Array(31)), 'invalid_input');
  });
});

describe('public envelopes', () => {
  const pub: EnvelopeHeader = { v: 1, type: 'page', id: 'pg-1', author: 'user-a', audience: 'public' };

  it('carry a signed clear body', () => {
    const env = sealEnvelope({ header: pub, payload, signPriv: author.signPriv });
    expect(env.wk).toBeUndefined();
    expect(env.ct).toBeUndefined();
    expect(env.body).toEqual(payload);
    expect(openEnvelope({ header: pub, envelope: env, signPub: author.signPub })).toEqual(payload);
    // survives a JSON round trip through the server
    const wire = JSON.parse(JSON.stringify(env)) as Envelope;
    expect(openEnvelope({ header: pub, envelope: wire, signPub: author.signPub })).toEqual(payload);
    const nul = sealEnvelope({ header: pub, payload: null, signPriv: author.signPriv });
    expect(openEnvelope({ header: pub, envelope: nul, signPub: author.signPub })).toBeNull();
  });

  it('reject edited bodies, wrong headers, wrong signers and mixed shapes', () => {
    const env = sealEnvelope({ header: pub, payload, signPriv: author.signPriv });
    const o = (e: Envelope, h = pub, k = author.signPub) => openEnvelope({ header: h, envelope: e, signPub: k });
    expectCode(() => o({ ...env, body: { ...payload, text: 'edited' } }), 'bad_signature');
    expectCode(() => o(env, { ...pub, id: 'pg-2' }), 'bad_signature');
    expectCode(() => o(env, pub, mallory.signPub), 'bad_signature');
    expectCode(() => o({ ...env, body: undefined }), 'bad_signature');
    expectCode(() => o({ ...env, ct: 'AAAA' }), 'bad_signature');
    expectCode(() => o({ ...env, body: { bad: new Date() } }), 'bad_signature');
    expectCode(() => o(sealPost(), pub), 'bad_signature');
  });

  it('validate inputs', () => {
    expectCode(() => sealEnvelope({ header: pub, payload, audienceKey, signPriv: author.signPriv }), 'invalid_input');
    expectCode(() => sealEnvelope({ header: pub, payload: () => 1, signPriv: author.signPriv }), 'invalid_input');
    expectCode(() => sealEnvelope({ header: pub, payload: 'x'.repeat(4 * 1024 * 1024), signPriv: author.signPriv }), 'invalid_input');
    expectCode(() => extractContentKey({ header: pub, envelope: sealPost(), audienceKey }), 'invalid_input');
    expectCode(() => sealWithContentKey({ header: pub, payload, contentKey: audienceKey, signPriv: author.signPriv }), 'invalid_input');
    expectCode(() => openWithContentKey({ header: pub, envelope: sealPost(), contentKey: audienceKey, signPub: author.signPub }), 'invalid_input');
  });
});

describe('content keys, comments and abuse reports', () => {
  const commenter = generateIdentity();
  const commentHeader: EnvelopeHeader = { v: 1, type: 'comment', id: 'c-9', author: 'user-c', wall: 'user-b', audience: { id: 'aud-1', epoch: 3 } };

  it('extractContentKey + deriveSubkey lets any reader write and read comments', () => {
    const post = sealPost();
    const ck = extractContentKey({ header, envelope: post, audienceKey });
    expect(ck.length).toBe(32);
    expect(extractContentKey({ header, envelope: post, audienceKey, signPub: author.signPub })).toEqual(ck);
    const commentKey = deriveSubkey(ck, 'comment', 'c-9');
    const env = sealWithContentKey({ header: commentHeader, payload: { text: 'lol yes' }, contentKey: commentKey, signPriv: commenter.signPriv });
    expect(env.wk).toBeUndefined();
    // Another reader derives the same key independently.
    const ck2 = extractContentKey({ header, envelope: post, audienceKey });
    expect(openWithContentKey({ header: commentHeader, envelope: env, contentKey: deriveSubkey(ck2, 'comment', 'c-9'), signPub: commenter.signPub })).toEqual({
      text: 'lol yes',
    });
  });

  it('comment tampering, wrong derived key, wrong signer, header changes fail', () => {
    const ck = extractContentKey({ header, envelope: sealPost(), audienceKey });
    const key = deriveSubkey(ck, 'comment', 'c-9');
    const env = sealWithContentKey({ header: commentHeader, payload: { text: 'hi' }, contentKey: key, signPriv: commenter.signPriv });
    const o = (e: Envelope, h = commentHeader, k = key, s = commenter.signPub) => openWithContentKey({ header: h, envelope: e, contentKey: k, signPub: s });
    for (const f of ['n', 'ct', 'sig'] as const) {
      for (let i = 0; i < b64u.decode(env[f]!).length; i++) expectCode(() => o({ ...env, [f]: flipB64(env[f]!, i) }), 'bad_signature');
    }
    expectCode(() => o(env, { ...commentHeader, id: 'c-10' }), 'bad_signature');
    expectCode(() => o(env, { ...commentHeader, audience: { id: 'aud-1', epoch: 2 } }), 'bad_signature');
    expectCode(() => o(env, commentHeader, key, author.signPub), 'bad_signature');
    expectCode(() => o(env, commentHeader, deriveSubkey(ck, 'comment', 'c-10')), 'decrypt_failed');
    expectCode(() => o(env, commentHeader, ck), 'decrypt_failed');
    // A comment envelope can't be opened as a normal envelope (no wk).
    expectCode(() => openEnvelope({ header: commentHeader, envelope: env, audienceKey, signPub: commenter.signPub }), 'decrypt_failed');
    // Adding a wk to a comment envelope breaks its signature.
    expectCode(() => o({ ...env, wk: sealPost().wk }), 'bad_signature');
  });

  it('abuse report: disclosed content key opens the full post envelope', () => {
    const post = sealPost();
    const ck = extractContentKey({ header, envelope: post, audienceKey });
    expect(openWithContentKey({ header, envelope: post, contentKey: ck, signPub: author.signPub })).toEqual(payload);
    expectCode(() => openWithContentKey({ header, envelope: post, contentKey: newSymmetricKey(), signPub: author.signPub }), 'decrypt_failed');
    expectCode(() => openWithContentKey({ header, envelope: post, contentKey: new Uint8Array(3), signPub: author.signPub }), 'invalid_input');
  });

  it('extractContentKey failures', () => {
    const post = sealPost();
    expectCode(() => extractContentKey({ header, envelope: post, audienceKey: newSymmetricKey() }), 'decrypt_failed');
    expectCode(() => extractContentKey({ header: { ...header, id: 'post-2' }, envelope: post, audienceKey }), 'decrypt_failed');
    expectCode(() => extractContentKey({ header, envelope: { ...post, wk: flipB64(post.wk!, 3) }, audienceKey }), 'decrypt_failed');
    expectCode(() => extractContentKey({ header, envelope: { ...post, wk: flipB64(post.wk!, 3) }, audienceKey, signPub: author.signPub }), 'bad_signature');
    expectCode(() => extractContentKey({ header, envelope: post, audienceKey, signPub: mallory.signPub }), 'bad_signature');
    expectCode(() => extractContentKey({ header, envelope: { ...post, wk: undefined }, audienceKey }), 'decrypt_failed');
    expectCode(() => extractContentKey({ header, envelope: { ...post, wk: 4 } as unknown as Envelope, audienceKey }), 'decrypt_failed');
    expectCode(() => extractContentKey({ header, envelope: null as unknown as Envelope, audienceKey }), 'decrypt_failed');
    expectCode(() => extractContentKey({ header, envelope: post, audienceKey: new Uint8Array(1) }), 'invalid_input');
  });

  it('sealWithContentKey validates inputs', () => {
    expectCode(() => sealWithContentKey({ header: commentHeader, payload: 1, contentKey: new Uint8Array(1), signPriv: commenter.signPriv }), 'invalid_input');
    expectCode(() => sealWithContentKey({ header: commentHeader, payload: 1, contentKey: audienceKey, signPriv: new Uint8Array(1) }), 'invalid_input');
  });
});

describe('deriveSubkey', () => {
  it('is deterministic and separates labels and ids', () => {
    const k = newSymmetricKey();
    expect(deriveSubkey(k, 'comment', 'c1')).toEqual(deriveSubkey(k, 'comment', 'c1'));
    const set = new Set([
      toHex(deriveSubkey(k, 'comment', 'c1')),
      toHex(deriveSubkey(k, 'comment', 'c2')),
      toHex(deriveSubkey(k, 'photo', 'c1')),
      toHex(deriveSubkey(newSymmetricKey(), 'comment', 'c1')),
      toHex(k),
    ]);
    expect(set.size).toBe(5);
  });
  it('validates inputs', () => {
    const k = newSymmetricKey();
    expectCode(() => deriveSubkey(new Uint8Array(1), 'comment', 'c'), 'invalid_input');
    for (const l of ['', 'Comment', 'a/b', 'x'.repeat(33), 5 as unknown as string]) expectCode(() => deriveSubkey(k, l, 'c'), 'invalid_input');
    expectCode(() => deriveSubkey(k, 'comment', ''), 'invalid_input');
  });
});
