'use client';
// "Send crash reports" (Settings → Your data): a per-device choice, OFF until the person turns it on.
// Kept in localStorage like the other device preferences; a panic wipe clears it (back to off). This file is
// all a browser loads while the setting is off: the reporter itself (client.ts) is imported only when on.
import { useSyncExternalStore } from 'react';

const KEY = 'kw.crash';
/** The last report this device sent, exactly as transmitted (shown under "See what gets sent"). */
export const LAST_KEY = 'kw.crash.last';

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let wired = false;
const subscribe = (l: () => void) => {
  if (!wired && typeof window !== 'undefined') {
    wired = true;
    window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) emit(); });
  }
  listeners.add(l);
  return () => { listeners.delete(l); };
};

export function crashReportsOn(): boolean {
  try { return localStorage.getItem(KEY) === 'on'; } catch { return false; }
}

export function setCrashReportsOn(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, 'on');
    else { localStorage.removeItem(KEY); localStorage.removeItem(LAST_KEY); }
  } catch { /* storage blocked: stays off */ }
  emit();
}

export function useCrashReports(): boolean {
  return useSyncExternalStore(subscribe, crashReportsOn, () => false);
}
