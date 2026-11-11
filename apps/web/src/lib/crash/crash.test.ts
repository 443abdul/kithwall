import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport, describeAgent, isNoise, parseReport, REPORT_MAX_BYTES, reportFingerprintSource, type CrashReport, type ReportInput } from './report';
import { isRoutePattern, ROUTE_PATTERNS, routePattern, UNKNOWN_ROUTE } from './routes';
import type { ScrubContext } from './scrub';

const ctx: ScrubContext = { appOrigins: ['https://www.kithwall.com'], apiOrigins: ['https://abcdefghijklmnop.supabase.co'], route: routePattern };
const UUID = '3f2c1a9e-7b4d-4c8e-9a1f-0d2e6b5c4a39';
const ID = '9b2f0c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b';

describe('routePattern', () => {
  it('answers with a pattern, never with the path', () => {
    expect(routePattern('/home')).toBe('/home');
    expect(routePattern('/')).toBe('/');
    expect(routePattern(`/messages/${UUID}`)).toBe('/messages/[id]');
    expect(routePattern(`/messages/${UUID}?call=${UUID}&answer=1#x`)).toBe('/messages/[id]');
    expect(routePattern('/messages/new')).toBe('/messages/new');
    expect(routePattern(`/messages/circle/${UUID}`)).toBe('/messages/circle/[circleId]');
    expect(routePattern('/u/saito')).toBe('/u/[handle]');
    expect(routePattern('/u/saito/verify')).toBe('/u/[handle]/verify');
    expect(routePattern('/u/verify/verify')).toBe('/u/[handle]/verify');
    expect(routePattern('/saito')).toBe('/[handle]');
    expect(routePattern('/saito/photos/12')).toBe('/[handle]/[...rest]');
    expect(routePattern('/design')).toBe('/design/[[...screen]]');
    expect(routePattern('/design/home/dark')).toBe('/design/[[...screen]]');
    expect(routePattern('/legal/privacy')).toBe('/legal/[doc]');
    expect(routePattern('/api/crash')).toBe('/api');
    expect(routePattern('/you/settings/data/')).toBe('/you/settings/data');
    expect(routePattern(UNKNOWN_ROUTE)).toBe(UNKNOWN_ROUTE);
  });

  it('only ever gives one of the known answers, and patterns map to themselves', () => {
    const paths = ['/x', '/a/b/c/d/e/f', `/${UUID}`, '/u', '/post', `/post/${UUID}/more`, '//', '', '/%E0%A4%A', '/messages/../../etc/passwd', 'not-a-path', `/circles/${UUID}/settings`];
    for (const p of paths) expect(isRoutePattern(routePattern(p)), p).toBe(true);
    for (const p of ROUTE_PATTERNS) expect(routePattern(p), p).toBe(p);
    expect(isRoutePattern('/u/saito')).toBe(false);
    expect(isRoutePattern(42)).toBe(false);
  });

  it('knows every page under src/app (add new pages to ROUTE_PATTERNS)', () => {
    const app = join(__dirname, '..', '..', 'app');
    const found: string[] = [];
    const walk = (dir: string, route: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === 'api' || name.startsWith('.') || name.startsWith('_')) continue;
          walk(full, /^\(.*\)$/.test(name) ? route : `${route}/${name}`);
        } else if (name === 'page.tsx') found.push(route || '/');
      }
    };
    walk(app, '');
    expect(found.length).toBeGreaterThan(40);
    expect(found.filter((r) => !ROUTE_PATTERNS.includes(r))).toEqual([]);
    expect(ROUTE_PATTERNS.filter((r) => !found.includes(r))).toEqual([]);
  });
});

describe('describeAgent', () => {
  const cases: [string, string, string][] = [
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240105.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/145.0.7204.63 Mobile Safari/537.36', 'Android 14', 'WebView 145'],
    ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'Android 10', 'Chrome 141'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Windows', 'Edge 141'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Windows', 'Firefox 131'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'macOS', 'Safari 18'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'iOS 17', 'Safari 17'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 'iOS 18', 'WebView'],
    ['Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36', 'Android 13', 'Samsung Internet 27'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Linux', 'Chrome 141'],
    ['curl/8.4.0 saito@example.org', 'Other', 'Other'],
    ['', 'Other', 'Other'],
  ];
  it('gives family and major version only', () => {
    for (const [ua, os, browser] of cases) {
      const a = describeAgent(ua);
      expect(a, ua).toEqual({ os, browser });
      // Never a device model, a build number or a minor version.
      expect(`${a.os} ${a.browser}`).toMatch(/^[A-Za-z ]+( \d{1,3})? [A-Za-z ]+( \d{1,3})?$/);
    }
  });
});

const input: ReportInput = {
  kind: 'error', name: 'TypeError',
  message: `Cannot read properties of undefined (reading 'envelope') in https://www.kithwall.com/messages/${UUID}?call=${UUID}`,
  stack: `TypeError: boom for @saito\n    at readMessage (https://www.kithwall.com/_next/static/chunks/4f2a9c01d3e5b677.js:1:23456)\n    at Thread (https://www.kithwall.com/_next/static/chunks/4f2a9c01d3e5b677.js:9:300)`,
  componentStack: '\n    at Bubble (https://www.kithwall.com/_next/static/chunks/4f2a9c01d3e5b677.js:9:120)\n    at ol',
  app: { web: '58a235e0c1d2', version: '2.5.0-foss', build: '412' },
  platform: 'android',
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240105.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/145.0.7204.63 Mobile Safari/537.36',
  pathname: `/messages/${UUID}`,
  locale: 'ur',
};

describe('buildReport', () => {
  const r = buildReport(input, ID, ctx);

  it('contains exactly the documented fields', () => {
    expect(Object.keys(r).sort()).toEqual(['app', 'browser', 'componentStack', 'id', 'kind', 'locale', 'message', 'name', 'os', 'platform', 'route', 'stack', 'v']);
    expect(Object.keys(r.app).sort()).toEqual(['build', 'version', 'web']);
    expect(r).toEqual({
      v: 1, id: ID, kind: 'error', app: { web: '58a235e0c1d2', version: '2.5.0-foss', build: '412' }, platform: 'android',
      os: 'Android 14', browser: 'WebView 145', route: '/messages/[id]', locale: 'ur', name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'envelope') in <app>/messages/[id]",
      stack: 'at readMessage (/_next/static/chunks/4f2a9c01d3e5b677.js:1:23456)\nat Thread (/_next/static/chunks/4f2a9c01d3e5b677.js:9:300)',
      componentStack: 'at Bubble (/_next/static/chunks/4f2a9c01d3e5b677.js:9:120)\nat ol',
    });
  });

  it('carries no path, id, handle, device model or full user agent', () => {
    const text = JSON.stringify(r);
    for (const s of [UUID, 'saito', 'Pixel', 'UQ1A', '7204', 'Mozilla', 'call=']) expect(text).not.toContain(s);
  });

  it('drops malformed build, locale and oversize values instead of sending them', () => {
    const odd = buildReport({ ...input, app: { web: 'x y;z', version: 'v'.repeat(80), build: '<script>' }, locale: 'ur_PK; DROP' }, ID, ctx);
    expect(odd.app).toEqual({ web: '', version: '', build: '' });
    expect(odd.locale).toBe('en');
  });

  it('always fits the size limit', () => {
    const huge = buildReport({ ...input, message: 'm '.repeat(20_000), stack: `    at ${'f'.repeat(300)} (https://www.kithwall.com/_next/static/chunks/a.js:1:1)\n`.repeat(500), componentStack: '    at Div\n'.repeat(500) }, ID, ctx);
    expect(JSON.stringify(huge).length).toBeLessThan(REPORT_MAX_BYTES);
  });
});

describe('parseReport (server)', () => {
  const good = buildReport(input, ID, ctx);
  const wire = (): Record<string, unknown> => JSON.parse(JSON.stringify(good)) as Record<string, unknown>;

  it('accepts what the device builds, unchanged', () => {
    expect(parseReport(wire(), ctx)).toEqual(good);
    // Also with a different server context (mirror origin, no API origin): the text is already final.
    expect(parseReport(wire(), { appOrigins: ['https://mirror.example'], route: routePattern })).toEqual(good);
  });

  it('drops unknown fields', () => {
    const p = parseReport({ ...wire(), userId: UUID, session: 'abc', ip: '10.0.0.1', app: { ...good.app, device: 'Pixel 8' } }, ctx);
    expect(p).toEqual(good);
  });

  it('scrubs again whatever a modified client sends', () => {
    const p = parseReport({ ...wire(), name: 'Error for @saito', message: `user ${UUID} khan@example.org "secret words" https://private-site.example/x?q=1`, stack: `    at f (https://www.kithwall.com/u/saito?tab=1:1:1)\nfree text about saito`, route: '/u/saito' }, ctx)!;
    expect(p.name).toBe('Error');
    expect(p.message).toBe('user <id> <email> <text>');
    expect(p.stack).toBe('at f (<app>/u/[handle])');
    expect(p.route).toBe(UNKNOWN_ROUTE);
  });

  it('refuses malformed reports', () => {
    const bad: unknown[] = [
      null, 'x', [], 42, {}, { ...wire(), v: 2 }, { ...wire(), id: 'not-a-uuid' }, { ...wire(), id: UUID.replace('4c8e', '1c8e') },
      { ...wire(), kind: 'other' }, { ...wire(), platform: 'windows' }, { ...wire(), os: 'Android 14; Pixel 8' },
      { ...wire(), browser: 'Chrome/141.0.0.0' }, { ...wire(), locale: 'english please' }, { ...wire(), message: 5 },
      { ...wire(), stack: null }, { ...wire(), app: { web: 'a b', version: '', build: '' } }, { ...wire(), app: 'x' },
      { ...wire(), message: '', stack: '' }, { ...wire(), route: 7 },
    ];
    for (const b of bad) expect(parseReport(b, ctx), JSON.stringify(b)?.slice(0, 80)).toBeNull();
  });
});

describe('fingerprint and noise', () => {
  const base = buildReport(input, ID, ctx);
  it('groups the same bug across builds and people, and separates web from native', () => {
    const other: CrashReport = { ...base, id: UUID, locale: 'en', os: 'Windows', stack: base.stack.replaceAll('4f2a9c01d3e5b677', '0011223344556677').replace(':1:23456', ':3:99') };
    expect(reportFingerprintSource(other)).toBe(reportFingerprintSource(base));
    expect(reportFingerprintSource({ ...base, kind: 'native' })).not.toBe(reportFingerprintSource(base));
    expect(reportFingerprintSource({ ...base, name: 'RangeError' })).not.toBe(reportFingerprintSource(base));
    expect(reportFingerprintSource({ ...base, stack: '', message: 'a' })).not.toBe(reportFingerprintSource({ ...base, stack: '', message: 'b' }));
  });

  it("doesn't report what isn't a bug", () => {
    expect(isNoise('TypeError', 'Failed to fetch')).toBe(true);
    expect(isNoise('TypeError', 'Load failed')).toBe(true);
    expect(isNoise('TypeError', 'NetworkError when attempting to fetch resource.')).toBe(true);
    expect(isNoise('AbortError', 'The user aborted a request.')).toBe(true);
    expect(isNoise('Error', 'Script error.')).toBe(true);
    expect(isNoise('Error', 'ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isNoise('ChunkLoadError', 'Loading chunk 123 failed.')).toBe(true);
    expect(isNoise('TypeError', "Cannot read properties of undefined (reading 'x')")).toBe(false);
    expect(isNoise('Error', 'Kithwall is locked')).toBe(false);
  });
});
