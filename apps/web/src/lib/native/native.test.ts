// App ↔ domain association files, the Android passkey origin, and the native passkey JSON conversion
// (docs/v2/05-native.md §2–3). Run: npx vitest run src/lib/native
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { androidOrigins, appleAppSiteAssociation, assetLinks, isAppleTeamId, parseCertFingerprints } from './association';
import { b64urlDecode, b64urlEncode, extractPrf, prfExtension, toAuthenticationJSON, toRegistrationJSON } from './passkey';
import { backAction, downloadBlob } from './runtime';
import { notThenable } from './index';
import { GET as assetLinksRoute } from '../../app/.well-known/assetlinks.json/route';
import { GET as aasaRoute } from '../../app/.well-known/apple-app-site-association/route';

const FP1 = '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5';
const FP2_PLAIN = 'aa'.repeat(32);

describe('certificate fingerprints', () => {
  it('normalises, de-duplicates and drops junk', () => {
    expect(parseCertFingerprints(` ${FP1} , ${FP1.toLowerCase()},${FP2_PLAIN}, nope, 12:34 `))
      .toEqual([FP1, Array(32).fill('AA').join(':')]);
    expect(parseCertFingerprints(undefined)).toEqual([]);
    expect(parseCertFingerprints('')).toEqual([]);
  });

  it('derives the Credential Manager origin android:apk-key-hash:<b64url(sha256 cert)>', () => {
    const [o] = androidOrigins([FP1]);
    expect(o).toBe(`android:apk-key-hash:${Buffer.from(FP1.replace(/:/g, ''), 'hex').toString('base64url')}`);
    expect(o).toMatch(/^android:apk-key-hash:[A-Za-z0-9_-]{43}$/);
  });
});

describe('/.well-known/assetlinks.json', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('lists passkey + app link relations for com.kithwall.app', () => {
    const [l] = assetLinks([FP1]);
    expect(l!.relation).toEqual(['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds']);
    expect(l!.target).toEqual({ namespace: 'android_app', package_name: 'com.kithwall.app', sha256_cert_fingerprints: [FP1] });
    expect(assetLinks([])).toEqual([]);
  });

  it('is served as JSON with no redirect', async () => {
    vi.stubEnv('ANDROID_CERT_SHA256', `${FP1},${FP2_PLAIN}`);
    const res = assetLinksRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json() as { target: { sha256_cert_fingerprints: string[] } }[];
    expect(body[0]!.target.sha256_cert_fingerprints).toHaveLength(2);
    vi.stubEnv('ANDROID_CERT_SHA256', '');
    expect(await assetLinksRoute().json()).toEqual([]);
  });
});

describe('/.well-known/apple-app-site-association', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('names <team>.com.kithwall.app for passkeys and universal links, never /api', () => {
    const a = appleAppSiteAssociation('ABCDE12345');
    expect(a.webcredentials.apps).toEqual(['ABCDE12345.com.kithwall.app']);
    expect(a.applinks.details[0]!.appIDs).toEqual(['ABCDE12345.com.kithwall.app']);
    expect(a.applinks.details[0]!.components[0]).toMatchObject({ '/': '/api/*', exclude: true });
    expect(isAppleTeamId('ABCDE12345')).toBe(true);
    expect(isAppleTeamId('abc')).toBe(false);
    expect(isAppleTeamId(undefined)).toBe(false);
  });

  it('is 404 until APPLE_TEAM_ID is set, then JSON', async () => {
    vi.stubEnv('APPLE_TEAM_ID', '');
    expect(aasaRoute().status).toBe(404);
    vi.stubEnv('APPLE_TEAM_ID', 'ABCDE12345');
    const res = aasaRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect((await res.json() as { webcredentials: { apps: string[] } }).webcredentials.apps[0]).toBe('ABCDE12345.com.kithwall.app');
  });
});

describe('native passkey JSON', () => {
  const salt = createHash('sha256').update('kithwall/v1/prf-app-salt').digest();
  it('sends the PRF salt base64url-encoded', () => {
    expect(prfExtension(salt)).toEqual({ prf: { eval: { first: b64urlEncode(salt) } } });
    expect(Buffer.from(b64urlDecode(b64urlEncode(salt))).equals(salt)).toBe(true);
  });

  it('takes the PRF output out of the response (it never reaches the server) and normalises base64', () => {
    const prf = new Uint8Array(32).fill(7);
    const androidStyle = {
      id: 'Y3JlZA', rawId: 'Y3JlZA==', type: 'public-key', authenticatorAttachment: 'platform',
      response: { clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0=', attestationObject: 'o2Nm+/', transports: ['internal', 'hybrid'] },
      clientExtensionResults: { prf: { enabled: true, results: { first: Buffer.from(prf).toString('base64') } } },
    };
    const { output, enabled } = extractPrf(androidStyle);
    expect(enabled).toBe(true);
    expect(output).toEqual(prf);
    const reg = toRegistrationJSON(androidStyle);
    expect(JSON.stringify(reg)).not.toContain('results');
    expect(reg.clientExtensionResults).toEqual({ prf: { enabled: true } });
    expect(reg.rawId).toBe('Y3JlZA');
    expect(reg.response.clientDataJSON).toBe('eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0');
    expect(reg.response.attestationObject).toBe('o2Nm-_');
    expect(reg.response.transports).toEqual(['internal', 'hybrid']);
  });

  it('builds an assertion in @simplewebauthn shape', () => {
    const a = toAuthenticationJSON({
      id: 'abc', type: 'public-key',
      response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig', userHandle: 'dXNlcg==' },
      clientExtensionResults: {},
    });
    expect(a).toEqual({ id: 'abc', rawId: 'abc', type: 'public-key', response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig', userHandle: 'dXNlcg' }, clientExtensionResults: {} });
    const noPrf = extractPrf({ clientExtensionResults: { prf: { enabled: false } } });
    expect(noPrf).toEqual({ output: null, enabled: false });
  });
});

// ---------------------------------------------------------------------------------------------------------
// App frame (lib/native/runtime.ts): Android Back decisions, download links.

type Q = Record<string, unknown[]>;
function fakeDoc(q: Q): Document {
  return {
    querySelector: (s: string) => (q[s] ?? [])[0] ?? null,
    querySelectorAll: (s: string) => q[s] ?? [],
  } as unknown as Document;
}

describe('Android Back (backAction)', () => {
  it('sends the app to the background during a call instead of leaving the call', () => {
    expect(backAction(true, fakeDoc({ '.k-call-screen, .k-call-incoming': [{}] }), '/messages/x')).toBe('background');
  });
  it('closes the top-most open dialog first, like Esc', () => {
    const closed: string[] = [];
    const dialog = (name: string, prevent: boolean) => ({
      dispatchEvent: (e: Event) => { if (prevent) e.preventDefault(); closed.push(`cancel:${name}`); return !e.defaultPrevented; },
      close: () => closed.push(`close:${name}`),
    });
    // components/ui/Dialog.tsx prevents the default and closes through React state: no close() from us.
    expect(backAction(true, fakeDoc({ 'dialog[open]': [dialog('a', false), dialog('b', true)] }), '/home')).toBe('handled');
    expect(closed).toEqual(['cancel:b']);
    closed.length = 0;
    expect(backAction(true, fakeDoc({ 'dialog[open]': [dialog('plain', false)] }), '/home')).toBe('handled');
    expect(closed).toEqual(['cancel:plain', 'close:plain']);
  });
  it('leaves the app from Home and the signed-out start pages', () => {
    for (const p of ['/home', '/home/', '/', '/signin', '/join']) expect(backAction(true, fakeDoc({}), p)).toBe('background');
  });
  it('goes Home first when a deep link left no history, else back in history', () => {
    let clicked = 0;
    const home = { click: () => { clicked++; } };
    expect(backAction(false, fakeDoc({ 'a[href="/home"]': [home] }), '/messages/abc')).toBe('handled');
    expect(clicked).toBe(1);
    expect(backAction(true, fakeDoc({ 'a[href="/home"]': [home] }), '/messages/abc')).toBe('');
    expect(backAction(false, fakeDoc({}), '/messages/abc')).toBe('');
  });
});

describe('downloads in the app (downloadBlob)', () => {
  const anchor = (href: string, download: string | null) => ({
    href, hasAttribute: (n: string) => n === 'download' && download !== null,
  }) as unknown as HTMLAnchorElement;
  it('saves data: download links and ignores normal links', async () => {
    const b = downloadBlob(anchor('data:text/calendar;base64,QkVHSU4=', 'event.ics'));
    expect(b?.type).toBe('text/calendar');
    expect(await b?.text()).toBe('BEGIN');
    expect(downloadBlob(anchor('data:text/plain,a%20b', 'x.txt'))?.size).toBe(3);
    expect(downloadBlob(anchor('https://www.kithwall.com/x', 'x'))).toBeNull();
    expect(downloadBlob(anchor('data:text/plain,a', null))).toBeNull();
    expect(downloadBlob(anchor('blob:https://www.kithwall.com/unknown', 'x'))).toBeNull();
  });
});

describe('plugin proxies (notThenable)', () => {
  it('can be returned from an async function without calling a native "then"', async () => {
    const calls: string[] = [];
    // Like Capacitor's registerPlugin(): every property is a native method.
    const raw = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => { calls.push(String(k)); return Promise.resolve(a); } }) as { info: () => Promise<unknown> };
    const p = await (async () => notThenable(raw))();
    expect(await p.info()).toEqual([]);
    expect(calls).toEqual(['info']);
    expect('then' in p).toBe(false);
  });
});
