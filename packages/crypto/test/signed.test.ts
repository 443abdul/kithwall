/// <reference types="node" />
import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { b64u, documentPublicKey, randomBytes, signDocument, verifyDocument } from '../src/index';

const CTX = 'kithwall/mirror-list/v1';

describe('signed documents', () => {
  const priv = randomBytes(32);
  const pub = documentPublicKey(priv);
  const body = JSON.stringify({ hello: 'wörld', n: 1 });

  it('verifies its own signature and nothing else', () => {
    const sig = signDocument(CTX, body, priv);
    expect(verifyDocument(CTX, body, sig, pub)).toBe(true);
    expect(verifyDocument(CTX, body + ' ', sig, pub)).toBe(false);
    expect(verifyDocument('kithwall/other/v1', body, sig, pub)).toBe(false);
    expect(verifyDocument(CTX, body, sig, documentPublicKey(randomBytes(32)))).toBe(false);
    expect(verifyDocument(CTX, body, 'not-base64!', pub)).toBe(false);
    expect(verifyDocument(CTX, body, sig, 'short')).toBe(false);
  });

  it('matches what node:crypto produces (scripts/mirrors.mjs signs with it)', () => {
    // PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(priv)]);
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    const sig = nodeSign(null, Buffer.from(`${CTX}\n${body}`, 'utf8'), key);
    expect(b64u.encode(new Uint8Array(sig))).toBe(signDocument(CTX, body, priv));
  });
});
