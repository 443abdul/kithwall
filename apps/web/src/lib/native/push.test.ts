import { beforeEach, describe, expect, it, vi } from 'vitest';

// The native plugin as the page sees it, per app version (KithwallPushPlugin.java).
const plugin = {
  permission: vi.fn(),
  requestPermission: vi.fn(),
  openSettings: vi.fn() as ReturnType<typeof vi.fn> | undefined,
  register: vi.fn(),
};
vi.mock('./index', () => ({
  nativePlugin: async () => plugin,
  nativePlatform: () => 'android',
  nativeErrorCode: (e: { code?: string }) => e?.code ?? '',
}));
vi.mock('./shell', () => ({ shellInfo: async () => ({ flavor: 'play' }) }));
const rpc = vi.fn(async () => ({ error: null }));
vi.mock('../supabase', () => ({ sb: () => ({ rpc }), must: <T>(x: { data: T }) => x.data }));

import { nativeEnablePush, NativePushError } from './push';

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof NativePushError ? e.code : `other:${String(e)}`));

beforeEach(() => {
  vi.clearAllMocks();
  plugin.openSettings = vi.fn(async () => undefined);
  plugin.register.mockResolvedValue({ provider: 'fcm', token: 'tok', p256dh: 'k', auth: 'a' });
});

describe('nativeEnablePush', () => {
  it('app 2.4+: asks Android and registers when allowed', async () => {
    plugin.permission.mockResolvedValue({ state: 'prompt', api: 2 });
    plugin.requestPermission.mockResolvedValue({ state: 'granted', blocked: false });
    expect(await code(nativeEnablePush())).toBe('ok');
    expect(plugin.requestPermission).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('register_native_push', expect.objectContaining({ p_token: 'tok' }));
  });

  it('app 2.4+: a plain "Don\'t allow" is declined, without opening the settings', async () => {
    plugin.permission.mockResolvedValue({ state: 'prompt', api: 2 });
    plugin.requestPermission.mockResolvedValue({ state: 'prompt', blocked: false });
    expect(await code(nativeEnablePush())).toBe('declined');
    expect(plugin.openSettings).not.toHaveBeenCalled();
  });

  it('app 2.4+: refused without a dialog opens the notification settings', async () => {
    plugin.permission.mockResolvedValue({ state: 'prompt', api: 2 });
    plugin.requestPermission.mockResolvedValue({ state: 'prompt', blocked: true });
    expect(await code(nativeEnablePush())).toBe('settings');
    expect(plugin.openSettings).toHaveBeenCalledOnce();
    expect(plugin.register).not.toHaveBeenCalled();
  });

  it('app 2.1 to 2.3 (no api): never calls the request that cannot answer; opens the settings', async () => {
    plugin.permission.mockResolvedValue({ state: 'prompt' });
    plugin.requestPermission.mockReturnValue(new Promise(() => undefined));   // what those builds do: nothing, forever
    expect(await code(nativeEnablePush())).toBe('settings');
    expect(plugin.requestPermission).not.toHaveBeenCalled();
    expect(plugin.openSettings).toHaveBeenCalledOnce();
  });

  it('app 2.0 (no api, no settings method): says notifications are blocked in the phone settings', async () => {
    plugin.permission.mockResolvedValue({ state: 'prompt' });
    plugin.openSettings = undefined;
    expect(await code(nativeEnablePush())).toBe('blocked');
  });

  it('already allowed: registers without asking', async () => {
    plugin.permission.mockResolvedValue({ state: 'granted' });
    expect(await code(nativeEnablePush())).toBe('ok');
    expect(plugin.requestPermission).not.toHaveBeenCalled();
    expect(plugin.register).toHaveBeenCalledOnce();
  });
});
