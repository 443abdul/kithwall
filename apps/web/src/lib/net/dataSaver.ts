'use client';
// Data Saver: for prepaid / expensive mobile data. Per device (a phone on a bundle, a laptop on Wi-Fi), so
// it lives in localStorage, not the vault. 'auto' turns it on when the browser says data is scarce (the
// "Lite mode" / Data Saver flag, or a 2G/3G-class connection). While it is on:
//  - feed photos load their small copy; the full one only when opened,
//  - videos (stories included) and link-preview images wait for a tap,
//  - photos I send are shrunk harder,
//  - calls start in their low-bandwidth mode.
// The meter counts the media this device downloaded today (ciphertext bytes, the data actually used).
import { useSyncExternalStore } from 'react';

export type DataSaverMode = 'auto' | 'on' | 'off';
const KEY = 'kw.dataSaver';
const METER = 'kw.dataMeter';

interface NetInfo { saveData?: boolean; effectiveType?: string; addEventListener?: (t: string, f: () => void) => void }
const conn = (): NetInfo | null => (typeof navigator !== 'undefined' ? ((navigator as unknown as { connection?: NetInfo }).connection ?? null) : null);

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let wired = false;
function wire() {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  conn()?.addEventListener?.('change', emit);
  window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === METER) emit(); });
}

export function getDataSaverMode(): DataSaverMode {
  try { const v = localStorage.getItem(KEY); return v === 'on' || v === 'off' ? v : 'auto'; } catch { return 'auto'; }
}

export function setDataSaverMode(m: DataSaverMode) {
  try { if (m === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, m); } catch { /* storage blocked */ }
  emit();
}

/** Is Data Saver in effect right now? */
export function dataSaverActive(): boolean {
  const m = getDataSaverMode();
  if (m !== 'auto') return m === 'on';
  const c = conn();
  return !!c && (c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g');
}

const subscribe = (l: () => void) => { wire(); listeners.add(l); return () => { listeners.delete(l); }; };

export function useDataSaver(): boolean {
  return useSyncExternalStore(subscribe, dataSaverActive, () => false);
}

export function useDataSaverMode(): DataSaverMode {
  return useSyncExternalStore(subscribe, getDataSaverMode, () => 'auto');
}

// ------------------------------------------------------------------------------------- meter
const today = () => new Date().toISOString().slice(0, 10);

/** Add downloaded media bytes to today's total. */
export function recordMediaBytes(n: number) {
  if (!(n > 0)) return;
  try {
    const raw = JSON.parse(localStorage.getItem(METER) ?? '{}') as { d?: string; b?: number };
    const b = (raw.d === today() ? raw.b ?? 0 : 0) + n;
    localStorage.setItem(METER, JSON.stringify({ d: today(), b }));
  } catch { /* storage blocked */ }
  emitSoon();
}
let pending: ReturnType<typeof setTimeout> | null = null;
function emitSoon() { if (!pending) pending = setTimeout(() => { pending = null; emit(); }, 1000); }

export function mediaBytesToday(): number {
  try { const raw = JSON.parse(localStorage.getItem(METER) ?? '{}') as { d?: string; b?: number }; return raw.d === today() ? raw.b ?? 0 : 0; } catch { return 0; }
}

export function useMediaBytesToday(): number {
  return useSyncExternalStore(subscribe, mediaBytesToday, () => 0);
}
