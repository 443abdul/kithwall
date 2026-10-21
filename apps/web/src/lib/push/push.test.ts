// Native push encryption and UnifiedPush endpoint safety (docs/v2/05-native.md §5).
// Run: npx vitest run src/lib/push
import { createECDH } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { b64uDecode, b64uEncode, decryptPush, encryptPush, isAuthSecret, isP256Point } from './crypto';
import { isPublicAddress, isUnifiedPushEndpoint, publicOnlyLookup } from './endpoint';

const strip = (s: string) => s.replace(/\s+/g, '');

// RFC 8291 §5 / Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: strip('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: strip('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8'),
  ciphertext: strip('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ'),
};

function deviceKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
  return { priv: ecdh.getPrivateKey(), pub: b64uEncode(ecdh.getPublicKey(undefined, 'uncompressed')), auth };
}

describe('encryptPush (RFC 8291 aes128gcm)', () => {
  it('reproduces the RFC 8291 example byte for byte', () => {
    const out = encryptPush(RFC.uaPublic, RFC.auth, RFC.plaintext, { asPrivate: b64uDecode(RFC.asPrivate), salt: b64uDecode(RFC.salt), padTo: 0 });
    expect(b64uEncode(out.subarray(0, 86))).toBe(RFC.header);
    expect(b64uEncode(out.subarray(86))).toBe(RFC.ciphertext);
  });

  it('the reference decryption opens the RFC example', () => {
    const msg = Buffer.concat([b64uDecode(RFC.header), b64uDecode(RFC.ciphertext)]);
    expect(decryptPush(b64uDecode(RFC.uaPrivate), RFC.auth, msg).toString('utf8')).toBe(RFC.plaintext);
  });

  it('round-trips a "who + what" payload to a fresh device key, padded to hide its length', () => {
    const d = deviceKeys();
    const payload = JSON.stringify({ v: 1, title: 'Kithwall', body: 'dan sent you a message', kind: 'message', url: '/messages/x', tag: 'conv:x' });
    const a = encryptPush(d.pub, d.auth, payload);
    const b = encryptPush(d.pub, d.auth, payload.slice(0, 20));
    expect(a.length).toBe(b.length + 64);          // both padded to a multiple of 64 bytes of record
    expect(a.toString('latin1')).not.toContain('dan');
    expect(decryptPush(d.priv, d.auth, a).toString('utf8')).toBe(payload);
    // A fresh sender key and salt every time.
    expect(b64uEncode(encryptPush(d.pub, d.auth, payload))).not.toBe(b64uEncode(a));
  });

  it('is interoperable with the web-push library (what UnifiedPush and browsers receive)', () => {
    const d = deviceKeys();
    const enc = webpush.encrypt(d.pub, d.auth, 'hello from web-push', 'aes128gcm');
    expect(decryptPush(d.priv, d.auth, enc.cipherText).toString('utf8')).toBe('hello from web-push');
  });

  it('fails closed on tampering, a wrong key or a wrong auth secret', () => {
    const d = deviceKeys();
    const other = deviceKeys();
    const msg = encryptPush(d.pub, d.auth, 'secret');
    const flipped = Buffer.from(msg); flipped[flipped.length - 1]! ^= 1;
    expect(() => decryptPush(d.priv, d.auth, flipped)).toThrow();
    expect(() => decryptPush(other.priv, d.auth, msg)).toThrow();
    expect(() => decryptPush(d.priv, other.auth, msg)).toThrow();
  });

  it('refuses malformed device keys and oversize payloads', () => {
    const d = deviceKeys();
    expect(() => encryptPush('AAAA', d.auth, 'x')).toThrow();
    expect(() => encryptPush(d.pub, 'AAAA', 'x')).toThrow();
    expect(() => encryptPush(d.pub, d.auth, 'x'.repeat(5000))).toThrow(/too large/);
    expect(isP256Point(d.pub)).toBe(true);
    expect(isP256Point(b64uEncode(new Uint8Array(65)))).toBe(false);   // not an uncompressed point
    expect(isAuthSecret(d.auth)).toBe(true);
    expect(isAuthSecret(b64uEncode(new Uint8Array(15)))).toBe(false);
  });
});

describe('UnifiedPush endpoint validation (SSRF)', () => {
  it('accepts ordinary https distributor endpoints', () => {
    for (const u of [
      'https://ntfy.sh/upAbCdEf123?up=1',
      'https://push.example.org/UP/abc',
      'https://nextcloud.example.net/index.php/apps/uppush/push/abc',
      'https://ntfy.example.com:443/abc',
    ]) expect(isUnifiedPushEndpoint(u), u).toBe(true);
  });

  it('refuses everything that could reach an internal service', () => {
    for (const u of [
      'http://ntfy.sh/abc',                       // not https
      'https://127.0.0.1/abc', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data',
      'https://0x7f000001/x', 'https://2130706433/x', // numeric host tricks (parsed as IPv4 by WHATWG URL)
      'https://localhost/x', 'https://intranet/x', 'https://printer.local/x', 'https://db.internal/x', 'https://svc.home.arpa/x',
      'https://ntfy.sh:8443/x',                   // non-default port
      'https://user:pw@ntfy.sh/x',                // credentials
      'https://ntfy.sh/x#frag',
      `https://ntfy.sh/${'a'.repeat(1100)}`,
      'https://ntfy.sh/a b', 'https://ntfy.sh\\@evil/x', 'ftp://ntfy.sh/x', 'not a url', 42, null,
    ]) expect(isUnifiedPushEndpoint(u), String(u)).toBe(false);
  });

  it('classifies addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2a01:4f8::1']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1',
      '::ffff:8.8.8.8', '64:ff9b::7f00:1', 'ff02::1', 'not-an-ip',
    ]) expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('only accepts global unicast IPv6 (security review I5)', () => {
    for (const ip of ['::7f00:1', '::a00:1', '3fff::1', '3fff:fff::1', '4000::1', 'e000::1']) expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress('2001:4860:4860::8888')).toBe(true);
  });

  it('refuses to connect when a name resolves to any private address (DNS rebinding)', async () => {
    const lookupWith = (addrs: { address: string; family: number }[]) => publicOnlyLookup((_h, cb) => cb(null, addrs));
    const run = (fn: ReturnType<typeof publicOnlyLookup>, all: boolean) => new Promise<{ err: NodeJS.ErrnoException | null; addr: unknown }>((resolve) => {
      fn('push.example.org', { all }, (err, addr) => resolve({ err, addr }));
    });
    const ok = await run(lookupWith([{ address: '93.184.216.34', family: 4 }]), false);
    expect(ok.err).toBeNull();
    expect(ok.addr).toBe('93.184.216.34');
    const mixed = await run(lookupWith([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]), true);
    expect(mixed.err?.code).toBe('EKW_PRIVATE_ADDRESS');
    const v6 = await run(lookupWith([{ address: '::1', family: 6 }]), false);
    expect(v6.err?.code).toBe('EKW_PRIVATE_ADDRESS');
    const none = await run(lookupWith([]), false);
    expect(none.err?.code).toBe('EKW_PRIVATE_ADDRESS');
  });
});
