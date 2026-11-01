import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOfflineError } from './offline';

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
