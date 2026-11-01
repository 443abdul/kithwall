// When Data Saver is in effect, and the daily media meter. Run: npx vitest run src/lib/net
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataSaverActive, getDataSaverMode, mediaBytesToday, recordMediaBytes, setDataSaverMode } from './dataSaver';

const store = new Map<string, string>();
function connection(c: { saveData?: boolean; effectiveType?: string } | undefined) {
  vi.stubGlobal('navigator', { connection: c });
}

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  connection(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('dataSaverActive', () => {
  it('defaults to auto and follows the browser', () => {
    expect(getDataSaverMode()).toBe('auto');
    expect(dataSaverActive()).toBe(false);
    connection({ saveData: true });
    expect(dataSaverActive()).toBe(true);
    connection({ effectiveType: '3g' });
    expect(dataSaverActive()).toBe(true);
    connection({ effectiveType: '4g' });
    expect(dataSaverActive()).toBe(false);
  });

  it('on and off override the browser', () => {
    connection({ saveData: true });
    setDataSaverMode('off');
    expect(dataSaverActive()).toBe(false);
    connection({ effectiveType: '4g' });
    setDataSaverMode('on');
    expect(dataSaverActive()).toBe(true);
    setDataSaverMode('auto');
    expect(store.has('kw.dataSaver')).toBe(false);
    expect(dataSaverActive()).toBe(false);
  });
});

describe('media meter', () => {
  it('adds up today and starts over on a new day', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    recordMediaBytes(1000);
    recordMediaBytes(500);
    recordMediaBytes(-3);
    recordMediaBytes(Number.NaN);
    expect(mediaBytesToday()).toBe(1500);
    vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
    expect(mediaBytesToday()).toBe(0);
    recordMediaBytes(7);
    expect(mediaBytesToday()).toBe(7);
  });
});
