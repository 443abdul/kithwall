// resealEnvelope (Kithwall 2 phase 3, edits): a new payload under the same content key.
import { describe, expect, it } from 'vitest';
import {
  type EnvelopeHeader, deriveSubkey, extractContentKey, generateIdentity, newSymmetricKey, openEnvelope,
  openWithContentKey, resealEnvelope, sealEnvelope, sealWithContentKey,
} from '../src/index';
import { expectCode } from './helpers';

const author = generateIdentity();
const mallory = generateIdentity();
const audienceKey = newSymmetricKey();
const header: EnvelopeHeader = { v: 1, type: 'post:status', id: 'post-1', author: 'user-a', audience: { id: 'aud-1', epoch: 2 } };
const commentHeader: EnvelopeHeader = { v: 1, type: 'comment', id: 'c-1', author: 'user-b', wall: 'post-1', audience: 'self' };

describe('resealEnvelope', () => {
  const v1 = sealEnvelope({ header, payload: { text: 'v1' }, audienceKey, signPriv: author.signPriv });
  const ck = extractContentKey({ header, envelope: v1, audienceKey, signPub: author.signPub });
  const comment = sealWithContentKey({ header: commentHeader, payload: { text: 'nice' }, contentKey: deriveSubkey(ck, 'comment', 'c-1'), signPriv: mallory.signPriv });

  it('replaces the payload, keeps the content key, so comments still open', () => {
    const v2 = resealEnvelope({ header, envelope: v1, payload: { text: 'v2' }, audienceKey, signPub: author.signPub, signPriv: author.signPriv });
    expect(openEnvelope({ header, envelope: v2, audienceKey, signPub: author.signPub })).toEqual({ text: 'v2' });
    expect(v2.wk).toBe(v1.wk);
    expect(v2.ct).not.toBe(v1.ct);
    const ck2 = extractContentKey({ header, envelope: v2, audienceKey, signPub: author.signPub });
    expect(Array.from(ck2)).toEqual(Array.from(ck));
    expect(openWithContentKey({ header: commentHeader, envelope: comment, contentKey: deriveSubkey(ck2, 'comment', 'c-1'), signPub: mallory.signPub })).toEqual({ text: 'nice' });
  });

  it('refuses an envelope that does not verify as the author\'s', () => {
    const forged = sealEnvelope({ header, payload: { text: 'x' }, audienceKey, signPriv: mallory.signPriv });
    expectCode(() => resealEnvelope({ header, envelope: forged, payload: { text: 'y' }, audienceKey, signPub: author.signPub, signPriv: author.signPriv }), 'bad_signature');
  });

  it('public envelopes are simply re-signed', () => {
    const ph: EnvelopeHeader = { ...header, audience: 'public' };
    const p1 = sealEnvelope({ header: ph, payload: { text: 'a' }, signPriv: author.signPriv });
    const p2 = resealEnvelope({ header: ph, envelope: p1, payload: { text: 'b' }, signPub: author.signPub, signPriv: author.signPriv });
    expect(openEnvelope({ header: ph, envelope: p2, signPub: author.signPub })).toEqual({ text: 'b' });
  });
});
