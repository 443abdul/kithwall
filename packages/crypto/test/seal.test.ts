import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { type Sealed, b64u, canonicalJson, generateIdentity, newSymmetricKey, openSealed, seal } from '../src/index';
import { expectCode, flipB64 } from './helpers';

const alice = generateIdentity();
const bob = generateIdentity();
const carol = generateIdentity();
const CONTEXT = 'audience-key/aud-1/3/bob';

function sealToBob(pt = newSymmetricKey(), context = CONTEXT): { sealed: Sealed; pt: Uint8Array } {
  return { sealed: seal({ recipientKxPub: bob.kxPub, senderSignPriv: alice.signPriv, context, plaintext: pt }), pt };
}

function openAsBob(sealed: Sealed, over: Partial<Parameters<typeof openSealed>[0]> = {}): Uint8Array {
  return openSealed({ sealed, recipientKxPriv: bob.kxPriv, recipientKxPub: bob.kxPub, senderSignPub: alice.signPub, context: CONTEXT, ...over });
}

/** Re-signs arbitrary fields as Alice (models a malicious-but-authentic sender). */
function resign(s: Omit<Sealed, 'sig'>, context = CONTEXT): Sealed {
  const msg = canonicalJson({ d: 'kithwall/v1/seal-sig', v: 1, context, recipient: b64u.encode(bob.kxPub), eph: s.eph, n: s.n, ct: s.ct });
  return { ...s, sig: b64u.encode(ed25519.sign(new TextEncoder().encode(msg), alice.signPriv)) };
}

describe('seal / openSealed', () => {
  it('round-trips and uses a fresh ephemeral key and nonce each time', () => {
    const { sealed, pt } = sealToBob();
    expect(openAsBob(sealed)).toEqual(pt);
    const again = seal({ recipientKxPub: bob.kxPub, senderSignPriv: alice.signPriv, context: CONTEXT, plaintext: pt });
    expect(again.eph).not.toBe(sealed.eph);
    expect(again.n).not.toBe(sealed.n);
    expect(b64u.decode(sealed.n).length).toBe(24);
  });

  it('wrong recipient cannot open', () => {
    const { sealed } = sealToBob();
    // Carol presenting her own keys: the signature covers Bob's public key.
    expectCode(() => openSealed({ sealed, recipientKxPriv: carol.kxPriv, recipientKxPub: carol.kxPub, senderSignPub: alice.signPub, context: CONTEXT }), 'bad_signature');
    // Carol claiming to be Bob: key mismatch is caught up front.
    expectCode(() => openSealed({ sealed, recipientKxPriv: carol.kxPriv, recipientKxPub: bob.kxPub, senderSignPub: alice.signPub, context: CONTEXT }), 'invalid_input');
  });

  it('wrong sender public key → bad_signature', () => {
    const { sealed } = sealToBob();
    expectCode(() => openAsBob(sealed, { senderSignPub: carol.signPub }), 'bad_signature');
  });

  it('server-injected box signed by someone else → bad_signature', () => {
    const forged = seal({ recipientKxPub: bob.kxPub, senderSignPriv: carol.signPriv, context: CONTEXT, plaintext: newSymmetricKey() });
    expectCode(() => openAsBob(forged), 'bad_signature');
  });

  it('wrong context → bad_signature', () => {
    const { sealed } = sealToBob();
    expectCode(() => openAsBob(sealed, { context: 'audience-key/aud-1/4/bob' }), 'bad_signature');
    expectCode(() => openAsBob(sealed, { context: 'recovery-share/alice/bob' }), 'bad_signature');
  });

  it('every flipped byte of every field → bad_signature', () => {
    const { sealed } = sealToBob();
    for (const f of ['eph', 'n', 'ct', 'sig'] as const) {
      const len = b64u.decode(sealed[f]).length;
      for (let i = 0; i < len; i++) expectCode(() => openAsBob({ ...sealed, [f]: flipB64(sealed[f], i) }), 'bad_signature');
    }
  });

  it('malformed boxes → bad_signature', () => {
    const { sealed } = sealToBob();
    expectCode(() => openAsBob(null as unknown as Sealed), 'bad_signature');
    expectCode(() => openAsBob({ ...sealed, v: 2 } as unknown as Sealed), 'bad_signature');
    expectCode(() => openAsBob({ ...sealed, ct: 7 } as unknown as Sealed), 'bad_signature');
    expectCode(() => openAsBob({ ...sealed, sig: '!!' }), 'bad_signature');
    expectCode(() => openAsBob({ ...sealed, sig: undefined } as unknown as Sealed), 'bad_signature');
  });

  it('validly signed but malformed / wrong-context ciphertext → decrypt_failed', () => {
    const { sealed } = sealToBob();
    expectCode(() => openAsBob(resign({ ...sealed, ct: flipB64(sealed.ct, 0) })), 'decrypt_failed');
    expectCode(() => openAsBob(resign({ ...sealed, eph: b64u.encode(carol.kxPub) })), 'decrypt_failed');
    expectCode(() => openAsBob(resign({ ...sealed, eph: b64u.encode(new Uint8Array(32)) })), 'decrypt_failed'); // low-order point
    expectCode(() => openAsBob(resign({ ...sealed, n: b64u.encode(new Uint8Array(12)) })), 'decrypt_failed');
    expectCode(() => openAsBob(resign({ ...sealed, ct: '***' })), 'decrypt_failed');
    // Encrypted under one context, signed under another: AAD binding catches it.
    const other = sealToBob(undefined, 'conversation-key/c1/0/bob').sealed;
    expectCode(() => openAsBob(resign(other)), 'decrypt_failed');
  });

  it('validates inputs', () => {
    const base = { recipientKxPub: bob.kxPub, senderSignPriv: alice.signPriv, context: CONTEXT, plaintext: newSymmetricKey() };
    expectCode(() => seal({ ...base, plaintext: new Uint8Array(0) }), 'invalid_input');
    expectCode(() => seal({ ...base, plaintext: new Uint8Array(64 * 1024 + 1) }), 'invalid_input');
    expectCode(() => seal({ ...base, context: '' }), 'invalid_input');
    expectCode(() => seal({ ...base, context: 'x'.repeat(513) }), 'invalid_input');
    expectCode(() => seal({ ...base, recipientKxPub: new Uint8Array(31) }), 'invalid_input');
    expectCode(() => seal({ ...base, recipientKxPub: new Uint8Array(32) }), 'invalid_input'); // low-order
    expectCode(() => seal({ ...base, senderSignPriv: new Uint8Array(64) }), 'invalid_input');
    const { sealed } = sealToBob();
    expectCode(() => openAsBob(sealed, { senderSignPub: new Uint8Array(31) }), 'invalid_input');
    expectCode(() => openAsBob(sealed, { recipientKxPriv: new Uint8Array(1) }), 'invalid_input');
    expectCode(() => openAsBob(sealed, { context: '' }), 'invalid_input');
  });
});
