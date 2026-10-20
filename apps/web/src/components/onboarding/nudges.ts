'use client';
// Gentle post-sign-up nudges (docs/v2/00-brief.md §5.5). Local, per-device flags only.
import { useSyncExternalStore } from 'react';

const RECOVERY = 'kw.nudge.recovery';
const listeners = new Set<() => void>();

function read(): boolean {
  try { return localStorage.getItem(RECOVERY) === 'show'; } catch { return false; }
}

export function markRecoveryNudge() {
  try { localStorage.setItem(RECOVERY, 'show'); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}

export function dismissRecoveryNudge() {
  try { localStorage.setItem(RECOVERY, 'dismissed'); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}

export function useRecoveryNudge(): boolean {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    read,
    () => false,
  );
}
