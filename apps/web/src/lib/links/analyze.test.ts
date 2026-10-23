// The "Leaving Kithwall" URL analyser. Run: npx vitest run src/lib/links
import { describe, expect, it } from 'vitest';
import { analyzeLink, claimedDomain, isNavigableHref, labelRisk, stripTracking } from './analyze';
import { decodeLabel, toUnicode } from './punycode';

describe('punycode', () => {
  it('decodes RFC 3492 samples and IDN hosts', () => {
    expect(decodeLabel('mnchen-3ya')).toBe('münchen');
    expect(decodeLabel('bcher-kva')).toBe('bücher');
    expect(toUnicode('xn--80ak6aa92e.com')).toBe('аррӏе.com');
    expect(toUnicode('www.xn--mnchen-3ya.de')).toBe('www.münchen.de');
    expect(toUnicode('example.com')).toBe('example.com');
  });
  it('rejects malformed input', () => {
    expect(decodeLabel('ab-c!')).toBeNull();
    expect(toUnicode('xn--!!.com')).toBe('xn--!!.com');
  });
});

describe('schemes', () => {
  it('never navigates data:, javascript:, file:, blob:', () => {
    for (const u of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd',
      'blob:https://kithwall.com/abc', 'vbscript:msgbox', 'not a url']) {
      const r = analyzeLink(u);
      expect(r.navigable, u).toBe(false);
      expect(r.openUrl, u).toBe('');
      expect(isNavigableHref(u), u).toBe(false);
    }
    expect(analyzeLink('javascript:alert(1)').scheme).toBe('javascript');
  });
  it('flags plain http', () => {
    const r = analyzeLink('http://example.com/a');
    expect(r.navigable).toBe(true);
    expect(r.warnings).toEqual(['insecure']);
    expect(r.flagged).toBe(true);
  });
  it('a clean https link has no warnings', () => {
    const r = analyzeLink('https://www.example.co.uk/path?q=1');
    expect(r.warnings).toEqual([]);
    expect(r.flagged).toBe(false);
    expect(r.domain).toBe('example.co.uk');
    expect(r.subdomain).toBe('www');
    expect(r.openUrl).toBe('https://www.example.co.uk/path?q=1');
  });
  it('uses private public suffixes (github.io) for the registrable domain', () => {
    expect(analyzeLink('https://evil.github.io/x').domain).toBe('evil.github.io');
  });
});

describe('userinfo tricks', () => {
  it('shows the real host and drops the credentials when opening', () => {
    const r = analyzeLink('https://google.com@evil.example/login');
    expect(r.host).toBe('evil.example');
    expect(r.warnings).toContain('userinfo');
    expect(r.userinfo).toBe('google.com');
    expect(r.openUrl).toBe('https://evil.example/login');
    const p = analyzeLink('https://user:secret@bank.example/');
    expect(p.userinfo).toBe('user:…');
    expect(p.openUrl).not.toContain('secret');
  });
});

describe('IP addresses and obfuscation', () => {
  it('flags IP hosts, including numeric and hex forms', () => {
    expect(analyzeLink('https://93.184.216.34/').warnings).toContain('ip');
    expect(analyzeLink('https://[2606:2800:220:1::]/').warnings).toContain('ip');
    const dec = analyzeLink('http://2130706433/');
    expect(dec.host).toBe('127.0.0.1');
    expect(dec.warnings).toEqual(expect.arrayContaining(['insecure', 'ip', 'obfuscated']));
    expect(analyzeLink('http://0x7f.1/').warnings).toContain('obfuscated');
  });
  it('flags very long, deeply nested and percent-encoded addresses', () => {
    expect(analyzeLink(`https://example.com/${'a'.repeat(400)}`).warnings).toContain('long');
    expect(analyzeLink('https://a.b.c.d.e.example.com/').warnings).toContain('obfuscated');
    expect(analyzeLink(`https://example.com/${'%41%42%43'.repeat(8)}`).warnings).toContain('obfuscated');
    expect(analyzeLink('https://example.com:8443/').warnings).toContain('port');
  });
  it('flags a familiar domain used as a subdomain', () => {
    const r = analyzeLink('https://paypal.com.account-verify.example.net/login');
    expect(r.domain).toBe('example.net');
    expect(r.warnings).toContain('deceptiveSubdomain');
    expect(analyzeLink('https://login.paypal.com.evil.io/').warnings).toContain('deceptiveSubdomain');
    expect(analyzeLink('https://en.m.wikipedia.org/wiki/X').warnings).toEqual([]);
  });
});

describe('homographs', () => {
  it('flags an all-Cyrillic look-alike of a Latin name and shows the Punycode form', () => {
    const r = analyzeLink('https://аррӏе.com/');
    expect(r.host).toBe('xn--80ak6aa92e.com');
    expect(r.unicodeHost).toBe('аррӏе.com');
    expect(r.warnings).toContain('confusable');
  });
  it('flags mixed scripts in one label', () => {
    const r = analyzeLink('https://pаypal.com/'); // Cyrillic а
    expect(r.host.startsWith('xn--')).toBe(true);
    expect(r.warnings).toContain('mixedScript');
    expect(labelRisk('gооgle')).toBe('mixedScript');
  });
  it('flags misreadable Latin letters', () => {
    expect(labelRisk('ɡoogle')).toBe('confusable');
  });
  it('accepts ordinary IDNs', () => {
    const r = analyzeLink('https://münchen.de/');
    expect(r.unicodeHost).toBe('münchen.de');
    expect(r.warnings).toEqual([]);
    expect(analyzeLink('https://яндекс.рф/').warnings).toEqual([]);
    expect(analyzeLink('https://例え.jp/').warnings).toEqual([]);
    expect(labelRisk('ソニーsony')).toBeNull();
  });
});

describe('shorteners', () => {
  it('flags known shorteners', () => {
    for (const u of ['https://bit.ly/3abc', 'https://t.co/xyz', 'https://tinyurl.com/y', 'https://www.bitly.com/x', 'https://amzn.to/1']) {
      expect(analyzeLink(u).warnings, u).toContain('shortener');
    }
    expect(analyzeLink('https://youtu.be/dQw4w9WgXcQ').warnings).not.toContain('shortener');
  });
});

describe('visible text vs real destination', () => {
  it('flags text naming another site', () => {
    const r = analyzeLink('https://evil.example/login', 'paypal.com');
    expect(r.warnings).toContain('mismatch');
    expect(r.claimed).toBe('paypal.com');
    expect(analyzeLink('https://evil.example/', 'https://www.PayPal.com/signin').claimed).toBe('paypal.com');
  });
  it('accepts matching text and plain words', () => {
    expect(analyzeLink('https://www.paypal.com/signin', 'paypal.com').warnings).toEqual([]);
    expect(analyzeLink('https://paypal.com/', 'https://paypal.com/').warnings).toEqual([]);
    expect(analyzeLink('https://evil.example/', 'click here').warnings).toEqual([]);
    expect(analyzeLink('https://evil.example/', 'version 2.0 is out').warnings).toEqual([]);
  });
  it('reads domains out of text', () => {
    expect(claimedDomain('docs.google.com')).toBe('google.com');
    expect(claimedDomain('file.txt')).toBeNull();
    expect(claimedDomain('hello world')).toBeNull();
  });
});

describe('tracking parameters', () => {
  it('removes common tracking parameters and keeps functional ones byte for byte', () => {
    const r = analyzeLink('https://shop.example/item?id=42&utm_source=x&utm_medium=y&fbclid=abc&q=a%20b+c&gclid=1#top');
    expect(r.openUrl).toBe('https://shop.example/item?id=42&q=a%20b+c#top');
    expect(r.removed).toEqual(['utm_source', 'utm_medium', 'fbclid', 'gclid']);
    expect(r.warnings).toEqual([]);
  });
  it('removes site-specific share trackers only on that site', () => {
    expect(analyzeLink('https://youtu.be/dQw4w9WgXcQ?si=abc&t=42').openUrl).toBe('https://youtu.be/dQw4w9WgXcQ?t=42');
    expect(analyzeLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc').openUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(analyzeLink('https://example.com/?si=keep').openUrl).toBe('https://example.com/?si=keep');
    expect(analyzeLink('https://www.instagram.com/p/x/?igshid=1').removed).toEqual(['igshid']);
  });
  it('drops the ? when nothing is left', () => {
    expect(stripTracking('?utm_campaign=a', null)).toEqual({ search: '', removed: ['utm_campaign'] });
    expect(stripTracking('', null)).toEqual({ search: '', removed: [] });
  });
});
