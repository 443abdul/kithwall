// Endpoint resolution, URL rewriting, failover and CSP additions. Run: npx vitest run src/lib/net
import { describe, expect, it } from 'vitest';
import { readNetConfig, routingEnabled } from './config';
import { buildRoutes, endpointsFor, pickRoute, resolveBase, rewriteHttp, rewriteWs, statusOf, type Route } from './endpoints';
import { isOnionRequest, netConnectSources, onionLocation } from './csp';
import type { MirrorList } from './mirrors';

const SB = 'https://proj.supabase.co';
const HERE = 'https://www.kithwall.com';
const ONION = 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvw.onion';
const cfg = (env: Record<string, string> = {}) => readNetConfig({ NEXT_PUBLIC_SUPABASE_URL: SB, ...env });

describe('no configuration', () => {
  const c = cfg();
  it('is disabled and has exactly one direct route', () => {
    expect(routingEnabled(c)).toBe(false);
    const routes = buildRoutes(c, HERE);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ id: 'direct', apiBase: SB, realtimeBase: 'wss://proj.supabase.co', storageBase: `${SB}/storage/v1` });
    const e = endpointsFor(routes, routes[0]!);
    expect(e).toMatchObject({ appOrigin: HERE, apiBase: SB, turnRoute: `${HERE}/api/calls/turn`, alternates: [] });
  });
  it('rewrites nothing and adds no CSP source or header', () => {
    const r = buildRoutes(c, HERE)[0]!;
    expect(rewriteHttp(`${SB}/rest/v1/posts?id=eq.1`, SB, r)).toBe(`${SB}/rest/v1/posts?id=eq.1`);
    expect(rewriteWs('wss://proj.supabase.co/realtime/v1/websocket?vsn=1', SB, r)).toBe('wss://proj.supabase.co/realtime/v1/websocket?vsn=1');
    expect(netConnectSources(c)).toEqual([]);
    expect(onionLocation(c, '/home', false)).toBeNull();
    expect(isOnionRequest('x.onion', '1', c)).toBe(false);
  });
});

describe('single-origin proxy (NEXT_PUBLIC_API_BASE=/sb)', () => {
  const c = cfg({ NEXT_PUBLIC_API_BASE: '/sb', NEXT_PUBLIC_REALTIME_BASE: 'wss://rt.kithwall.com' });
  const routes = buildRoutes(c, HERE);
  it('puts the proxy first and Supabase directly last', () => {
    expect(routes.map((r) => r.id)).toEqual(['primary', 'direct']);
    expect(routes[0]).toMatchObject({ apiBase: `${HERE}/sb`, realtimeBase: 'wss://rt.kithwall.com', health: `${HERE}/sb/auth/v1/health` });
  });
  it('rewrites REST, Auth, Storage and Realtime onto the proxy', () => {
    const r = routes[0]!;
    expect(rewriteHttp(`${SB}/rest/v1/posts?select=*`, SB, r)).toBe(`${HERE}/sb/rest/v1/posts?select=*`);
    expect(rewriteHttp(`${SB}/storage/v1/object/media/a/b`, SB, r)).toBe(`${HERE}/sb/storage/v1/object/media/a/b`);
    expect(rewriteHttp('https://proj.supabase.co.evil.example/x', SB, r)).toBe('https://proj.supabase.co.evil.example/x');
    expect(rewriteHttp('/api/calls/turn', SB, r)).toBe('/api/calls/turn');
    expect(rewriteWs('wss://proj.supabase.co/realtime/v1/websocket?apikey=k', SB, r)).toBe('wss://rt.kithwall.com/realtime/v1/websocket?apikey=k');
  });
  it('allows only the absolute realtime origin in CSP (the path is same-origin)', () => {
    expect(netConnectSources(c)).toEqual(['wss://rt.kithwall.com']);
  });
});

describe('mirrors and alternates', () => {
  const c = cfg({
    NEXT_PUBLIC_API_BASE: '/sb', NEXT_PUBLIC_REALTIME_BASE: '/sb',
    NEXT_PUBLIC_API_ALTERNATES: 'https://api2.example.net',
    NEXT_PUBLIC_MIRROR_ORIGINS: 'https://kw-mirror.example, http://evil.example, https://www.kithwall.com',
    NEXT_PUBLIC_MIRROR_LIST_PUBKEY: 'x'.repeat(43),
  });
  const list: MirrorList = {
    version: 2, issued: '', expires: '', apk: [],
    mirrors: [
      { origin: 'https://signed.example', api: 'https://signed.example/sb', kind: 'mirror' },
      { origin: 'https://noproxy.example', kind: 'mirror' },
      { origin: ONION, api: `${ONION}/sb`, kind: 'onion' },
    ],
  };
  it('orders primary, alternates, build-time mirrors, signed mirrors, direct; skips onion off Tor', () => {
    const routes = buildRoutes(c, HERE, list);
    expect(routes.map((r) => r.id)).toEqual([
      'primary', 'alt:https://api2.example.net', 'mirror:https://kw-mirror.example', 'mirror:https://signed.example', 'direct',
    ]);
    expect(routes[2]).toMatchObject({ appOrigin: 'https://kw-mirror.example', apiBase: 'https://kw-mirror.example/sb', realtimeBase: 'wss://kw-mirror.example/sb' });
  });
  it('on the onion, uses the onion proxy first and keeps onion mirrors', () => {
    const routes = buildRoutes(c, ONION, list);
    expect(routes[0]).toMatchObject({ id: 'onion', apiBase: `${ONION}/sb`, realtimeBase: `${ONION.replace('http', 'ws')}/sb` });
  });
  it('CSP lists only https mirrors, their sockets and absolute alternates', () => {
    expect(netConnectSources(c).sort()).toEqual(['https://api2.example.net', 'https://kw-mirror.example', 'https://www.kithwall.com', 'wss://kw-mirror.example', 'wss://www.kithwall.com'].sort());
  });
});

describe('failover', () => {
  const routes = buildRoutes(cfg({ NEXT_PUBLIC_API_BASE: '/sb', NEXT_PUBLIC_MIRROR_ORIGINS: 'https://m1.example,https://m2.example' }), HERE);
  const probe = (up: string[]) => async (r: Route) => up.includes(r.id);
  it('keeps the first working route in order', async () => {
    expect((await pickRoute(routes, probe(['primary', 'direct'])))!.id).toBe('primary');
    expect((await pickRoute(routes, probe(['mirror:https://m2.example', 'direct'])))!.id).toBe('mirror:https://m2.example');
    expect(await pickRoute(routes, probe([]))).toBeNull();
  });
  it('prefers the last working route', async () => {
    expect((await pickRoute(routes, probe(['primary', 'direct']), 'direct'))!.id).toBe('direct');
    expect((await pickRoute(routes, probe(['primary']), 'direct'))!.id).toBe('primary');
  });
  it('treats a throwing probe as down and probes in parallel', async () => {
    let concurrent = 0; let max = 0;
    const slow = async (r: Route) => { concurrent++; max = Math.max(max, concurrent); await new Promise((f) => setTimeout(f, 10)); concurrent--; if (r.id === 'primary') throw new Error('x'); return r.id === 'direct'; };
    expect((await pickRoute(routes, slow))!.id).toBe('direct');
    expect(max).toBe(routes.length);
  });
  it('derives the banner status', () => {
    expect(statusOf(routes, routes[0]!, true, true)).toBe('direct');
    expect(statusOf(routes, routes[1]!, true, true)).toBe('rerouted');
    expect(statusOf(routes, routes.find((r) => r.kind === 'direct')!, true, true)).toBe('direct');
    expect(resolveBase('C:/Program Files/Git/sb', HERE)).toBe('');
    expect(statusOf(routes, null, true, true)).toBe('blocked');
    expect(statusOf(routes, routes[0]!, false, true)).toBe('blocked');
    expect(statusOf(routes, null, false, false)).toBe('offline');
  });
});

describe('onion', () => {
  const c = cfg({ NEXT_PUBLIC_ONION_ORIGIN: `${ONION}/` });
  it('sends Onion-Location on the clearnet only', () => {
    expect(onionLocation(c, '/help?x=1', false)).toBe(`${ONION}/help?x=1`);
    expect(onionLocation(c, '/help', true)).toBeNull();
    expect(isOnionRequest('abc.onion', null, c)).toBe(true);
    expect(isOnionRequest('www.kithwall.com', '1', c)).toBe(true);
    expect(isOnionRequest('www.kithwall.com', null, c)).toBe(false);
  });
  it('ignores a non-onion NEXT_PUBLIC_ONION_ORIGIN', () => {
    expect(cfg({ NEXT_PUBLIC_ONION_ORIGIN: 'https://example.com' }).onionOrigin).toBe('');
  });
});
