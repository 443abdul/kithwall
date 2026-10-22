// Regression test (2026-10-23): in the Android app every native plugin call hung, so v1 email sign-in,
// passphrase sign-in with "keep me signed in", passkeys and push never finished. nativePlugin() returned
// Capacitor's plugin proxy from an async function; the proxy answers `then` too, so the promise adopted it as
// a thenable and called a native "then()" that rejects (docs/v2/05-native.md §1, "App frame").
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  // Like Capacitor's registerPlugin(): EVERY property is a native method, `then` included, and calling an
  // unknown one rejects ("X.then()" is not implemented on android) without ever calling resolve/reject.
  registerPlugin: (name: string) => new Proxy({}, {
    get: (_t, k) => (...args: unknown[]) => (k === 'then'
      ? Promise.reject(new Error(`"${name}.then()" is not implemented on android`))
      : Promise.resolve({ method: String(k), args })),
  }),
}));

const g = globalThis as unknown as { window?: unknown };
afterEach(() => { delete g.window; vi.resetModules(); });

describe('nativePlugin', () => {
  it('resolves to a usable plugin inside the app (no native then())', async () => {
    g.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } };
    const { nativePlugin } = await import('./index');
    const settled = await Promise.race([
      nativePlugin('KithwallSecure').then((p) => p.get({ key: 'amk' })),
      new Promise((r) => setTimeout(() => r('hung'), 1000)),
    ]);
    expect(settled).toEqual({ method: 'get', args: [{ key: 'amk' }] });
  });

  it('refuses outside the app', async () => {
    const { nativePlugin } = await import('./index');
    await expect(nativePlugin('KithwallShell')).rejects.toThrow(/not running in the Kithwall app/);
  });
});
