import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOfflineError, knownOffline, OfflineError, setKnownOffline, storedAuthUser } from './offline';

afterEach(() => { vi.unstubAllGlobals(); });

describe('isOfflineError', () => {
  it('recognises network failures as browsers and supabase-js report them', () => {
    vi.stubGlobal('navigator', { onLine: true });
    expect(isOfflineError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isOfflineError(new Error('TypeError: Failed to fetch'))).toBe(true);
    expect(isOfflineError({ message: 'NetworkError when attempting to fetch resource.' })).toBe(true);
    expect(isOfflineError(new Error('TypeError: Load failed'))).toBe(true);
  });
  it('does not treat refusals as offline', () => {
    vi.stubGlobal('navigator', { onLine: true });
    expect(isOfflineError(new Error('new row violates row-level security policy'))).toBe(false);
    expect(isOfflineError(null)).toBe(false);
    expect(isOfflineError('x')).toBe(false);
  });
  it('anything fails offline when the browser knows it is offline', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(isOfflineError(new Error('whatever'))).toBe(true);
  });
});

describe('known offline (the session was opened without a connection)', () => {
  afterEach(() => { setKnownOffline(false); });
  it('OfflineError counts as offline, and the flag is just a switch', () => {
    vi.stubGlobal('navigator', { onLine: true });
    expect(isOfflineError(new OfflineError())).toBe(true);
    expect(knownOffline()).toBe(false);
    setKnownOffline(true);
    expect(knownOffline()).toBe(true);
  });
});

describe('storedAuthUser', () => {
  const store = new Map<string, string>();
  it('reads the stored session without the network, and only a well-formed one', () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null });
    const id = '11111111-1111-4111-8111-111111111111';
    store.set('sb-x-auth-token', JSON.stringify({ access_token: 'a', refresh_token: 'r', user: { id, email: 'u@kithwall.invalid' } }));
    expect(storedAuthUser('sb-x-auth-token')).toEqual({ id, email: 'u@kithwall.invalid' });
    expect(storedAuthUser(undefined)).toBeNull();
    store.set('sb-x-auth-token', JSON.stringify({ user: { id } }));
    expect(storedAuthUser('sb-x-auth-token')).toBeNull(); // no refresh token: no session
    store.set('sb-x-auth-token', '{broken');
    expect(storedAuthUser('sb-x-auth-token')).toBeNull();
  });
});
