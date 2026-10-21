'use client';
// Call preferences (docs/v2/04-calls.md §2). Kept in the encrypted vault (namespace "calls"), with a
// non-sensitive localStorage mirror so the first call after a reload uses the right setting.
//
// relay: "Always relay calls (hide my IP from the other person)". ON by default (brief §2: protection is
// the default). Every call then goes through Cloudflare's TURN relay, so the other person only ever sees
// the relay's address. Trade-off: slightly more delay, and Cloudflare sees that two relay addresses
// exchanged encrypted packets. Off: a direct connection when possible (each side learns the other's IP).
import { useSyncExternalStore } from 'react';
import { getSession } from '../keys/session';
import { vaultGet, vaultUpdate } from '../settings';

export interface CallPrefs { relay: boolean }
export const DEFAULT_CALL_PREFS: CallPrefs = { relay: true };
export const CALLS_NS = 'calls';
const MIRROR = 'kw.calls.prefs';

const listeners = new Set<() => void>();
let current: CallPrefs = readMirror();
let loadedFor: string | null = null;

function readMirror(): CallPrefs {
  try {
    const m = JSON.parse(localStorage.getItem(MIRROR) ?? '{}') as Partial<CallPrefs>;
    return { relay: typeof m.relay === 'boolean' ? m.relay : DEFAULT_CALL_PREFS.relay };
  } catch { return { ...DEFAULT_CALL_PREFS }; }
}

function publish(next: CallPrefs) {
  current = next;
  try { localStorage.setItem(MIRROR, JSON.stringify(next)); } catch { /* storage blocked */ }
  listeners.forEach((l) => l());
}

export function getCallPrefs(): CallPrefs { return current; }

export async function loadCallPrefs(force = false): Promise<CallPrefs> {
  const s = getSession();
  if (s.status !== 'ready' || !s.userId) return current;
  if (!force && loadedFor === s.userId) return current;
  const v = await vaultGet<Partial<CallPrefs>>(CALLS_NS).catch(() => undefined);
  loadedFor = s.userId;
  publish({ relay: typeof v?.relay === 'boolean' ? v.relay : DEFAULT_CALL_PREFS.relay });
  return current;
}

export async function saveCallPrefs(patch: Partial<CallPrefs>): Promise<void> {
  const next = await vaultUpdate<Partial<CallPrefs>>(CALLS_NS, (prev) => ({ ...(prev ?? {}), ...patch }));
  publish({ relay: typeof next.relay === 'boolean' ? next.relay : DEFAULT_CALL_PREFS.relay });
}

export function useCallPrefs(): CallPrefs {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => current, () => DEFAULT_CALL_PREFS);
}
