import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFileUrl } from './media';
import type { FileRef } from './types';

const ref: FileRef = { path: '00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002', key: 'k', mime: 'image/jpeg', bytes: 10 };

/** A loader that fails `fails` times, then answers. */
function flaky(fails: number) {
  let calls = 0;
  const load = vi.fn(() => (calls++ < fails ? Promise.reject(new Error('download failed')) : Promise.resolve('blob:ok')));
  return load;
}

describe('a picture that did not load the first time', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('arrives at once when the first download works', async () => {
    const got = vi.fn();
    const load = flaky(0);
    loadFileUrl(ref, got, [100, 200], load);
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toHaveBeenCalledWith('blob:ok');
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('is asked for again after each wait until it arrives', async () => {
    const got = vi.fn();
    const load = flaky(2);
    loadFileUrl(ref, got, [100, 200, 400], load);
    await vi.advanceTimersByTimeAsync(0);
    expect(got).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(load).toHaveBeenCalledTimes(2);
    expect(got).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(load).toHaveBeenCalledTimes(3);
    expect(got).toHaveBeenCalledExactlyOnceWith('blob:ok');
  });

  it('gives up after the last wait instead of asking forever', async () => {
    const got = vi.fn();
    const load = flaky(99);
    loadFileUrl(ref, got, [100, 200], load);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(got).not.toHaveBeenCalled();
  });

  it('stops when the picture is no longer shown', async () => {
    const got = vi.fn();
    const load = flaky(1);
    const stop = loadFileUrl(ref, got, [100], load);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(got).not.toHaveBeenCalled();
  });

  it('starts over when the connection comes back, and listens no longer once it has the picture', async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: () => void) => { listeners.set(name, fn); },
      removeEventListener: (name: string) => { listeners.delete(name); },
    });
    const got = vi.fn();
    const load = flaky(3);
    loadFileUrl(ref, got, [100, 200], load);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(3);            // gave up
    listeners.get('online')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toHaveBeenCalledExactlyOnceWith('blob:ok');
    expect(listeners.has('online')).toBe(false);
  });
});
