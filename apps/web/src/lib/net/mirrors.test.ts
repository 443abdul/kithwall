// Signed mirror list: format, signature, expiry, rollback. Run: npx vitest run src/lib/net
import { describe, expect, it } from 'vitest';
import { documentPublicKey, randomBytes, signDocument } from '@kithwall/crypto';
import { MIRROR_LIST_CONTEXT, parsePayload, parseSigned, shareText, toToken, verifyMirrorList } from './mirrors';

const priv = randomBytes(32);
const pub = documentPublicKey(priv);
const NOW = Date.parse('2026-10-23T12:00:00Z');

function payload(over: Record<string, unknown> = {}) {
  return {
    format: 'kithwall-mirrors', version: 3, issued: '2026-10-20T00:00:00Z', expires: '2027-01-20T00:00:00Z',
    mirrors: [
      { origin: 'https://mirror-one.example', api: 'https://mirror-one.example/sb', realtime: 'wss://mirror-one.example/sb', label: 'One' },
      { origin: 'https://mirror-two.example/', kind: 'mirror' },
      { origin: 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvw.onion', api: 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvw.onion/sb' },
    ],
    apk: [{ url: 'https://mirror-one.example/kithwall.apk', sha256: 'A'.repeat(64) }],
    ...over,
  };
}
function sign(p: unknown, key = priv) {
  const body = JSON.stringify(p);
  return { 'kithwall-mirrors': 1 as const, body, sig: signDocument(MIRROR_LIST_CONTEXT, body, key) };
}

describe('verifyMirrorList', () => {
  it('accepts a valid list (object, JSON text and kwm1 token)', () => {
    const s = sign(payload());
    for (const input of [s, JSON.stringify(s), toToken(s), `Kithwall addresses:\n${toToken(s)}\n`]) {
      const r = verifyMirrorList(input, pub, { now: NOW });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.list.version).toBe(3);
      expect(r.list.mirrors.map((m) => m.origin)).toEqual([
        'https://mirror-one.example', 'https://mirror-two.example',
        'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvw.onion',
      ]);
      expect(r.list.mirrors[0]).toMatchObject({ api: 'https://mirror-one.example/sb', realtime: 'wss://mirror-one.example/sb', kind: 'mirror', label: 'One' });
      expect(r.list.mirrors[2]!.kind).toBe('onion');
      expect(r.list.apk[0]!.sha256).toBe('a'.repeat(64));
    }
  });

  it('rejects a bad signature, a different key and a tampered body', () => {
    const s = sign(payload());
    expect(verifyMirrorList({ ...s, sig: sign(payload({ version: 4 })).sig }, pub, { now: NOW })).toEqual({ ok: false, reason: 'signature' });
    expect(verifyMirrorList(sign(payload(), randomBytes(32)), pub, { now: NOW })).toEqual({ ok: false, reason: 'signature' });
    const tampered = { ...s, body: s.body.replace('mirror-one.example', 'evil.example') };
    expect(verifyMirrorList(tampered, pub, { now: NOW })).toEqual({ ok: false, reason: 'signature' });
    // A signature for another kind of document (different context) never verifies as a mirror list.
    const other = { ...s, sig: signDocument('kithwall/other/v1', s.body, priv) };
    expect(verifyMirrorList(other, pub, { now: NOW })).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects an expired list and one issued in the future', () => {
    expect(verifyMirrorList(sign(payload({ expires: '2026-10-22T00:00:00Z' })), pub, { now: NOW })).toEqual({ ok: false, reason: 'expired' });
    expect(verifyMirrorList(sign(payload({ issued: '2026-11-30T00:00:00Z' })), pub, { now: NOW })).toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  it('refuses rollback to an older version', () => {
    const v3 = sign(payload({ version: 3 }));
    expect(verifyMirrorList(v3, pub, { now: NOW, minVersion: 3 }).ok).toBe(true);
    expect(verifyMirrorList(v3, pub, { now: NOW, minVersion: 4 })).toEqual({ ok: false, reason: 'rollback' });
  });

  it('rejects malformed input and a missing key', () => {
    expect(verifyMirrorList('nonsense', pub)).toEqual({ ok: false, reason: 'format' });
    expect(verifyMirrorList({ body: '{}', sig: 'x' }, pub)).toEqual({ ok: false, reason: 'format' });
    expect(verifyMirrorList(sign({ format: 'other', version: 1 }), pub, { now: NOW })).toEqual({ ok: false, reason: 'format' });
    expect(verifyMirrorList(sign(payload()), '')).toEqual({ ok: false, reason: 'no-key' });
  });
});

describe('parsePayload', () => {
  it('drops unsafe entries', () => {
    const p = parsePayload(JSON.stringify(payload({
      mirrors: [
        { origin: 'http://plain.example' },                       // plain http on the internet
        { origin: 'javascript:alert(1)' },
        { origin: 'https://user:pw@x.example' },
        { origin: 'https://ok.example', api: 'http://ok.example/sb', realtime: 'https://ok.example' },
        { origin: 'https://ok.example' },                         // duplicate
      ],
      apk: [{ url: 'http://x.example/a.apk' }, { url: 'https://x.example/a.apk', sha256: 'nothex' }],
    })))!;
    expect(p.mirrors).toEqual([{ origin: 'https://ok.example', kind: 'mirror' }]);
    expect(p.apk).toEqual([{ url: 'https://x.example/a.apk' }]);
  });
  it('round-trips the share token', () => {
    const s = sign(payload());
    expect(parseSigned(toToken(s))).toEqual(s);
    const text = shareText(parsePayload(s.body)!, s, 'Kithwall:');
    expect(text.split('\n').slice(0, 3)).toEqual(['Kithwall:', 'https://mirror-one.example', 'https://mirror-two.example']);
    expect(text).toContain('kwm1.');
  });
});
