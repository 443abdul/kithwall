'use client';
// Call preferences (docs/v2/04-calls.md §2). Kept in the encrypted vault (namespace "calls"), with a
// non-sensitive localStorage mirror so the first call after a reload uses the right setting.
//
// relay: "Always relay calls (hide my IP from the other person)". ON by default (brief §2: protection is
// the default). Every call then goes through Cloudflare's TURN relay, so the other person only ever sees
// the relay's address. Trade-off: slightly more delay, and Cloudflare sees that two relay addresses
// exchanged encrypted packets. Off: a direct connection when possible (each side learns the other's IP).
//
// saver: "Data saver for calls" (docs §11). Off by default. Calls start at the smallest video size, Opus is
// capped at 12 kbps and the others are asked to send small video; for 2G/3G, metered or patchy data.
// camOff: "Start video calls with my camera off". Off by default.
import { useSyncExternalStore } from 'react';
import { getSession } from '../keys/session';
import { vaultGet, vaultUpdate } from '../settings';

export interface CallPrefs { relay: boolean; saver: boolean; camOff: boolean }
export const DEFAULT_CALL_PREFS: CallPrefs = { relay: true, saver: false, camOff: false };
export const CALLS_NS = 'calls';
const MIRROR = 'kw.calls.prefs';

const listeners = new Set<() => void>();
let current: CallPrefs = readMirror();
let loadedFor: string | null = null;

function normalise(m: Partial<CallPrefs> | null | undefined): CallPrefs {
  const pick = (k: keyof CallPrefs): boolean => { const v = m?.[k]; return typeof v === 'boolean' ? v : DEFAULT_CALL_PREFS[k]; };
  return { relay: pick('relay'), saver: pick('saver'), camOff: pick('camOff') };
}

function readMirror(): CallPrefs {
  try {
    return normalise(JSON.parse(localStorage.getItem(MIRROR) ?? '{}') as Partial<CallPrefs>);
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
  publish(normalise(v));
  return current;
}

export async function saveCallPrefs(patch: Partial<CallPrefs>): Promise<void> {
  const next = await vaultUpdate<Partial<CallPrefs>>(CALLS_NS, (prev) => ({ ...(prev ?? {}), ...patch }));
  publish(normalise(next));
}

export function useCallPrefs(): CallPrefs {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => current, () => DEFAULT_CALL_PREFS);
}
