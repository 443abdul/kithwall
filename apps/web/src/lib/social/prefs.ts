'use client';
// Personal lists kept only in my encrypted vault (the server never learns them): saved posts, muted
// people (for a while or until I unmute) and the composer draft. Loaded once per unlock and shared by
// every screen through useSyncExternalStore.
import { useSyncExternalStore } from 'react';
import { vaultGet, vaultUpdate } from '../settings';
import { onLock } from '../keys/session';

export interface SavedPost { id: string; at: string }
/** userId → ISO time the mute ends, or 'forever'. */
export type MuteMap = Record<string, string>;

interface State { saved: SavedPost[]; muted: MuteMap; loaded: boolean }
const EMPTY: State = { saved: [], muted: {}, loaded: false };
let state: State = EMPTY;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
onLock(() => { state = EMPTY; loading = null; listeners.forEach((l) => l()); });

export function loadSocialPrefs(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  loading ??= Promise.all([vaultGet<SavedPost[]>('saved'), vaultGet<MuteMap>('muted')])
    .then(([saved, muted]) => set({ saved: Array.isArray(saved) ? saved : [], muted: muted && typeof muted === 'object' ? muted : {}, loaded: true }))
    .finally(() => { loading = null; });
  return loading;
}

export function useSocialPrefs(): State {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state, () => EMPTY);
}

// ------------------------------------------------------------------------------------- saved posts
export const isSaved = (s: State, id: string) => s.saved.some((x) => x.id === id);

export async function setSaved(id: string, on: boolean): Promise<void> {
  const next = await vaultUpdate<SavedPost[]>('saved', (prev) => {
    const list = (Array.isArray(prev) ? prev : []).filter((x) => x.id !== id);
    return on ? [{ id, at: new Date().toISOString() }, ...list].slice(0, 2000) : list;
  });
  set({ saved: next });
}

// ------------------------------------------------------------------------------------- muting
/** Is this person muted right now? */
export function isMuted(m: MuteMap, userId: string, now = Date.now()): boolean {
  const until = m[userId];
  if (!until) return false;
  return until === 'forever' || Date.parse(until) > now;
}

/** Mute for `days` (0 = until I unmute), or unmute with null. */
export async function setMuted(userId: string, days: number | null): Promise<void> {
  const next = await vaultUpdate<MuteMap>('muted', (prev) => {
    const m: MuteMap = {};
    const now = Date.now();
    // Expired mutes are dropped whenever the map is written.
    for (const [k, v] of Object.entries(prev ?? {})) if (v === 'forever' || Date.parse(v) > now) m[k] = v;
    if (days === null) delete m[userId];
    else m[userId] = days === 0 ? 'forever' : new Date(now + days * 86_400_000).toISOString();
    return m;
  });
  set({ muted: next });
}

// ------------------------------------------------------------------------------------- drafts
export interface Draft { text: string; at: string }

export async function loadDraft(key: string): Promise<Draft | null> {
  const all = await vaultGet<Record<string, Draft>>('drafts');
  return all?.[key] ?? null;
}

/** Save (or with an empty text, clear) the draft for one composer. */
export async function saveDraft(key: string, text: string): Promise<void> {
  await vaultUpdate<Record<string, Draft>>('drafts', (prev) => {
    const all = { ...(prev ?? {}) };
    if (text.trim()) all[key] = { text: text.slice(0, 8000), at: new Date().toISOString() }; else delete all[key];
    return all;
  });
}
