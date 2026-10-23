// Client runtime: failover through netFetch, mirror-list caching and rollback. Run: npx vitest run src/lib/net
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentPublicKey, randomBytes, signDocument } from '@kithwall/crypto';

const SB = 'https://proj.supabase.co';
const HERE = 'https://www.kithwall.com';
const priv = randomBytes(32);
const PUB = documentPublicKey(priv);

function signed(version: number, expires = '2099-01-01T00:00:00Z') {
  const body = JSON.stringify({
    format: 'kithwall-mirrors', version, issued: '2026-01-01T00:00:00Z', expires,
    mirrors: [{ origin: 'https://m-signed.example', api: 'https://m-signed.example/sb' }],
  });
  return JSON.stringify({ 'kithwall-mirrors': 1, body, sig: signDocument('kithwall/mirror-list/v1', body, priv) });
}

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}

const json = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: SB, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk', ...env })) vi.stubEnv(k, v);
  return import('./runtime');
}

let storage: MemStorage;
beforeEach(() => {
  storage = new MemStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('location', { origin: HERE });
  vi.stubGlobal('window', globalThis);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('not configured', () => {
  it('is the identity and installs nothing', async () => {
    const fetchSpy = vi.fn(json);
    vi.stubGlobal('fetch', fetchSpy);
    const net = await load({});
    expect(net.supabaseNetOptions()).toEqual({});
    expect(net.netUrl(`${SB}/rest/v1/x`)).toBe(`${SB}/rest/v1/x`);
    expect(net.endpoints()).toMatchObject({ apiBase: SB, alternates: [] });
    await net.recheck();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(net.netState().status).toBe('unknown');
  });
});

describe('failover', () => {
  it('moves to the next route when the current one is unreachable, and back when it returns', async () => {
    const down = new Set<string>([`${HERE}/sb`]);
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if ([...down].some((d) => u.startsWith(d))) throw new TypeError('Failed to fetch');
      return json();
    });
    vi.stubGlobal('fetch', fetchSpy);
    const net = await load({ NEXT_PUBLIC_API_BASE: '/sb', NEXT_PUBLIC_MIRROR_ORIGINS: 'https://m2.example' });
    expect(net.netUrl(`${SB}/rest/v1/posts`)).toBe(`${HERE}/sb/rest/v1/posts`);

    // A GET fails on the primary proxy: re-check, switch to the mirror's proxy, retry once there.
    const res = await net.netFetch(`${SB}/rest/v1/posts`);
    expect(res.ok).toBe(true);
    expect(net.netState()).toMatchObject({ status: 'rerouted', current: { id: 'mirror:https://m2.example' } });
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toContain('https://m2.example/sb/rest/v1/posts');
    expect(storage.getItem('kw.net.route')).toBe('mirror:https://m2.example');

    // POSTs are not retried (they may have reached the server).
    down.add('https://m2.example/sb');
    await expect(net.netFetch(`${SB}/rest/v1/rpc/x`, { method: 'POST' })).rejects.toThrow('Failed to fetch');

    // The primary comes back: the next check returns to it.
    down.clear();
    await net.recheck();
    expect(net.netState()).toMatchObject({ status: 'direct', current: { id: 'primary' } });
  });

  it('reports "blocked" when no route answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const net = await load({ NEXT_PUBLIC_API_BASE: '/sb' });
    await net.recheck();
    expect(net.netState().status).toBe('blocked');
  });
});

describe('signed mirror list on the device', () => {
  it('never probes a signed-list mirror that CSP would block', async () => {
    vi.stubGlobal('fetch', vi.fn(json));
    const net = await load({ NEXT_PUBLIC_API_BASE: '/sb', NEXT_PUBLIC_MIRROR_LIST_PUBKEY: PUB });
    expect(net.acceptMirrorList(signed(1)).ok).toBe(true);
    expect(net.netState().list?.mirrors.map((m) => m.origin)).toEqual(['https://m-signed.example']);
    expect(net.netState().routes.map((r) => r.id)).toEqual(['primary', 'direct']);
  });

  it('keeps the newest verified list, refuses rollback and forged lists, and adds its routes', async () => {
    vi.stubGlobal('fetch', vi.fn(json));
    // The mirror's origin is allowed in CSP (build-time), but its proxy only comes from the signed list.
    const env = { NEXT_PUBLIC_API_BASE: 'https://api.example', NEXT_PUBLIC_MIRROR_ORIGINS: 'https://m-signed.example', NEXT_PUBLIC_MIRROR_LIST_PUBKEY: PUB };
    const net = await load(env);
    expect(net.netState().routes.map((r) => r.id)).toEqual(['primary', 'direct']);
    expect(net.acceptMirrorList(signed(5)).ok).toBe(true);
    expect(storage.getItem('kw.net.minVersion')).toBe('5');
    expect(net.netState().routes.map((r) => r.id)).toEqual(['primary', 'mirror:https://m-signed.example', 'direct']);
    expect(net.acceptMirrorList(signed(4))).toEqual({ ok: false, reason: 'rollback' });
    expect(net.acceptMirrorList(signed(9, '2001-01-01T00:00:00Z'))).toEqual({ ok: false, reason: 'expired' });
    const forged = JSON.parse(signed(9)) as { body: string; sig: string };
    forged.body = forged.body.replace('m-signed', 'evil');
    expect(net.acceptMirrorList(JSON.stringify(forged))).toEqual({ ok: false, reason: 'signature' });

    // A fresh page load re-verifies what was stored and still refuses the older version.
    const again = await load(env);
    expect(again.netState().list?.version).toBe(5);
    expect(again.acceptMirrorList(signed(3)).ok).toBe(false);
  });

  it('fetches the list from the configured URLs', async () => {
    const fetchSpy = vi.fn(async (u: RequestInfo | URL) => (void u, new Response(signed(7), { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);
    const net = await load({ NEXT_PUBLIC_MIRROR_LIST_PUBKEY: PUB });
    await net.refreshMirrorList();
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(['/api/net/mirrors']);
    expect(net.netState().list?.version).toBe(7);
  });
});
