// Security review W1: open redirect through /signin?next=…
import { describe, expect, it } from 'vitest';
import { safeNext, safePath } from './next';

/** Where a browser would actually go if it navigated to `next` from https://kithwall.com. */
const landsOn = (next: string) => new URL(next, 'https://kithwall.com').origin;

describe('safeNext', () => {
  it('keeps same-site paths, with query and hash', () => {
    expect(safeNext('/messages/abc?x=1#m')).toBe('/messages/abc?x=1#m');
    expect(safeNext('/u/ann')).toBe('/u/ann');
    expect(safeNext('/a/../b')).toBe('/b');
  });

  it('falls back to /home for nothing or garbage', () => {
    for (const v of [null, undefined, '', 'home', 'https://evil.example/', 'javascript:alert(1)', '/'.padEnd(3000, 'a')]) {
      expect(safeNext(v)).toBe('/home');
    }
  });

  it('refuses the reported bypasses (tab / newline / CR between the slashes)', () => {
    const attacks = ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/%09/evil.example'.replace('%09', '\t'),
      '\t//evil.example', '/\u0000/evil.example', '/\u007f/evil.example'];
    // The old prefix check let the reported payload through, and URL parsing takes it off-site:
    const oldSafeNext = (raw: string) => (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') ? '/home' : raw);
    expect(oldSafeNext('/\t/evil.example')).toBe('/\t/evil.example');
    expect(landsOn('/\t/evil.example')).toBe('https://evil.example');
    for (const a of attacks) expect(safeNext(a)).toBe('/home');
  });

  it('refuses protocol-relative and backslash forms', () => {
    for (const a of ['//evil.example', '/\\evil.example', '/\\/evil.example', '\\\\evil.example', '/x\\..\\..\\/evil']) {
      expect(safeNext(a)).toBe('/home');
    }
  });

  it('anything it returns stays on the site', () => {
    const samples = ['/%2F%2Fevil.example', '/ /evil.example', '/%5C%5Cevil.example', '/.//evil.example', '/@evil.example', '/?next=//evil'];
    for (const s of samples) {
      const out = safeNext(s);
      expect(out.startsWith('/') && !out.startsWith('//')).toBe(true);
      expect(landsOn(out)).toBe('https://kithwall.com');
    }
  });

  it('safePath returns null instead of a fallback (notification taps)', () => {
    expect(safePath('/messages/1')).toBe('/messages/1');
    expect(safePath('//evil.example')).toBeNull();
    expect(safePath(42)).toBeNull();
  });
});
