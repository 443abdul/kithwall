import { describe, expect, it } from 'vitest';
import { createKeyBundle, newSymmetricKey } from '@kithwall/crypto';
import {
  bundleLooksValid, cleanLabel, deviceLabel, handleShapeProblem, isB64u, isSyntheticEmail, noticeEmailOk,
  normalizeHandle, syntheticEmailFor,
} from './passkey-shared';

const USER = '7d3c1e2a-0000-4000-8000-000000000001';

describe('handles', () => {
  it('normalises', () => {
    expect(normalizeHandle('  @Maya.K ')).toBe('maya.k');
  });
  it('checks the v1 username shape and reserved names', () => {
    expect(handleShapeProblem('maya')).toBeNull();
    expect(handleShapeProblem('maya.k2')).toBeNull();
    expect(handleShapeProblem('ma')).toBe('invalid');
    expect(handleShapeProblem('.maya')).toBe('invalid');
    expect(handleShapeProblem('maya_k')).toBe('invalid');   // underscores are not allowed (profiles check)
    expect(handleShapeProblem('a'.repeat(31))).toBe('invalid');
    expect(handleShapeProblem('settings')).toBe('reserved');
    expect(handleShapeProblem('@Admin')).toBe('reserved');
  });
});

describe('synthetic emails', () => {
  it('derive a non-routable address from the user id', () => {
    const e = syntheticEmailFor(USER);
    expect(e).toBe('u7d3c1e2a000040008000000000000001@id.kithwall.invalid');
    expect(isSyntheticEmail(e)).toBe(true);
    expect(isSyntheticEmail(e.toUpperCase())).toBe(true);
    expect(isSyntheticEmail('maya@example.com')).toBe(false);
    expect(isSyntheticEmail(null)).toBe(false);
    expect(() => syntheticEmailFor('nope')).toThrow();
  });
  it('are never accepted as notice addresses', () => {
    expect(noticeEmailOk('maya@example.com')).toBe(true);
    expect(noticeEmailOk(syntheticEmailFor(USER))).toBe(false);
    expect(noticeEmailOk('x@foo.invalid')).toBe(false);
    expect(noticeEmailOk('no-at-sign')).toBe(false);
    expect(noticeEmailOk('a b@example.com')).toBe(false);
    expect(noticeEmailOk(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

describe('bundleLooksValid', () => {
  const pw = createKeyBundle(USER, newSymmetricKey()).bundle;
  const pk = createKeyBundle(USER, null).bundle;
  it('accepts real bundles of the expected kind', () => {
    expect(bundleLooksValid(pw, { password: true })).toBe(true);
    expect(bundleLooksValid(pk, { password: false })).toBe(true);
  });
  it('refuses the wrong kind', () => {
    expect(bundleLooksValid(pw, { password: false })).toBe(false);
    expect(bundleLooksValid(pk, { password: true })).toBe(false);
  });
  it('refuses malformed or padded bundles', () => {
    expect(bundleLooksValid(null, { password: false })).toBe(false);
    expect(bundleLooksValid([], { password: false })).toBe(false);
    expect(bundleLooksValid({ ...pk, v: 2 }, { password: false })).toBe(false);
    expect(bundleLooksValid({ ...pk, signPub: 'short' }, { password: false })).toBe(false);
    expect(bundleLooksValid({ ...pk, extra: 'x' }, { password: false })).toBe(false);
    expect(bundleLooksValid({ ...pk, kdf: { alg: 'pbkdf2' } }, { password: false })).toBe(false);
    expect(bundleLooksValid({ ...pk, identityEnc: `${pk.identityEnc}=` }, { password: false })).toBe(false);
  });
});

describe('small helpers', () => {
  it('isB64u', () => {
    expect(isB64u('abc_-', 1, 10)).toBe(true);
    expect(isB64u('ab+/', 1, 10)).toBe(false);
    expect(isB64u('a', 2, 10)).toBe(false);
    expect(isB64u(5, 0, 10)).toBe(false);
  });
  it('cleanLabel trims, strips control characters and caps the length', () => {
    expect(cleanLabel('  My\nphone  ')).toBe('My phone');
    expect(cleanLabel('')).toBe('Passkey');
    expect(cleanLabel(42)).toBe('Passkey');
    expect(cleanLabel('x'.repeat(100))).toHaveLength(60);
  });
  it('deviceLabel is coarse', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0')).toBe('Edge on Windows');
    expect(deviceLabel('curl/8')).toBe('Passkey');
  });
});
