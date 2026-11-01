import { describe, expect, it } from 'vitest';
import { b64u, fileDigest, frankCommit, frankingBody, frankMatches, newFrankingKey } from '../src/index';
import { expectCode } from './helpers';

const CONV = '00000000-0000-0000-0000-0000000000c1';
const MSG = '00000000-0000-0000-0000-0000000000d1';
const SENDER = '00000000-0000-0000-0000-0000000000e1';
const fixedKey = Uint8Array.from({ length: 32 }, (_, i) => i);

describe('message franking', () => {
  it('matches an independent HMAC-SHA-256 vector (also used by supabase/tests/franking.test.sql)', () => {
    const body = frankingBody({ conversationId: CONV, messageId: MSG, senderId: SENDER, payload: { text: 'héllo' } });
    expect(body).toBe('{"conv":"00000000-0000-0000-0000-0000000000c1","id":"00000000-0000-0000-0000-0000000000d1","payload":{"text":"héllo"},"sender":"00000000-0000-0000-0000-0000000000e1","v":1}');
    expect(b64u.encode(fixedKey)).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
    expect(frankCommit(fixedKey, body)).toBe('6epbm1K22fQAKsx1t0sstUOxWdktI6ttxOrMbU4n1GQ');
  });

  it('verifies the committed body and nothing else', () => {
    const fk = newFrankingKey();
    const payload = { text: 'you will regret this', attachments: [{ path: 'a/b', key: 'k', mime: 'image/jpeg', bytes: 3, sha: 'x' }] };
    const body = frankingBody({ conversationId: CONV, messageId: MSG, senderId: SENDER, payload });
    const c = frankCommit(fk, body);
    expect(c).toHaveLength(43);
    expect(frankMatches(fk, body, c)).toBe(true);
    expect(frankMatches(b64u.encode(fk), body, c)).toBe(true);
    // Any change to the text, an attachment, the chat, the message id or the sender breaks it.
    const variants = [
      frankingBody({ conversationId: CONV, messageId: MSG, senderId: SENDER, payload: { ...payload, text: 'you will love this' } }),
      frankingBody({ conversationId: CONV, messageId: MSG, senderId: SENDER, payload: { ...payload, attachments: [{ ...payload.attachments[0]!, sha: 'y' }] } }),
      frankingBody({ conversationId: '00000000-0000-0000-0000-0000000000c2', messageId: MSG, senderId: SENDER, payload }),
      frankingBody({ conversationId: CONV, messageId: '00000000-0000-0000-0000-0000000000d2', senderId: SENDER, payload }),
      frankingBody({ conversationId: CONV, messageId: MSG, senderId: '00000000-0000-0000-0000-0000000000e2', payload }),
    ];
    for (const v of variants) expect(frankMatches(fk, v, c)).toBe(false);
    expect(frankMatches(newFrankingKey(), body, c)).toBe(false);
  });

  it('is canonical: key order in the payload does not matter', () => {
    const a = frankingBody({ conversationId: CONV, messageId: MSG, senderId: SENDER, payload: { text: 'hi', voice: { secs: 2 } } });
    const b = frankingBody({ conversationId: CONV, messageId: MSG, senderId: SENDER, payload: { voice: { secs: 2 }, text: 'hi' } });
    expect(a).toBe(b);
  });

  it('a fresh key each time: the same message gives unlinkable commitments', () => {
    const body = frankingBody({ conversationId: CONV, messageId: MSG, senderId: SENDER, payload: { text: 'ok' } });
    expect(frankCommit(newFrankingKey(), body)).not.toBe(frankCommit(newFrankingKey(), body));
  });

  it('never throws on malformed input when verifying', () => {
    const body = frankingBody({ conversationId: CONV, messageId: MSG, senderId: SENDER, payload: { text: 'ok' } });
    const c = frankCommit(fixedKey, body);
    expect(frankMatches(undefined, body, c)).toBe(false);
    expect(frankMatches('not base64!', body, c)).toBe(false);
    expect(frankMatches(new Uint8Array(16), body, c)).toBe(false);
    expect(frankMatches(fixedKey, body, c.slice(0, 42))).toBe(false);
    expect(frankMatches(fixedKey, body, null)).toBe(false);
    expect(frankMatches(fixedKey, { body }, c)).toBe(false);
  });

  it('validates inputs when committing', () => {
    expectCode(() => frankCommit(new Uint8Array(31), 'x'), 'invalid_input');
    expectCode(() => frankingBody({ conversationId: '', messageId: MSG, senderId: SENDER, payload: {} }), 'invalid_input');
    expectCode(() => frankingBody({ conversationId: CONV, messageId: MSG, senderId: SENDER, payload: [] }), 'invalid_input');
    expectCode(() => frankingBody({ conversationId: CONV, messageId: MSG, senderId: SENDER, payload: { text: undefined } }), 'invalid_input');
  });

  it('file digests are SHA-256 of the stored bytes', () => {
    expect(fileDigest(new TextEncoder().encode('abc'))).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });
});
