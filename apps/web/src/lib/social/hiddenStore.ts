'use client';
// My hidden words (./hiddenWords.ts), the suggested accounts I dismissed, and whether I have read the
// "Public means anyone" explanation: all kept only in my encrypted vault. Loaded once per unlock and shared
// by every screen through useSyncExternalStore.
import { useEffect, useSyncExternalStore } from 'react';
import { vaultGet, vaultUpdate } from '../settings';
import { onLock, useSession } from '../keys/session';
import { cleanHiddenWords } from './hiddenWords';

interface State { words: string[]; dismissed: string[]; publicExplained: boolean; loaded: boolean }
const EMPTY: State = { words: [], dismissed: [], publicExplained: false, loaded: false };
let state: State = EMPTY;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
onLock(() => { state = EMPTY; loading = null; listeners.forEach((l) => l()); });

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 1000) : []);

export function loadHiddenStore(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  loading ??= Promise.all([vaultGet<unknown>('hiddenWords'), vaultGet<unknown>('suggestDismissed'), vaultGet<{ at?: string }>('publicExplained')])
    .then(([w, d, p]) => set({ words: cleanHiddenWords(w), dismissed: ids(d), publicExplained: !!p?.at, loaded: true }))
    .finally(() => { loading = null; });
  return loading;
}

/** My hidden words and dismissed suggestions (empty until the vault is read). */
export function useHiddenStore(): State {
  const { status } = useSession();
  useEffect(() => { if (status === 'ready') void loadHiddenStore().catch(() => undefined); }, [status]);
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state, () => EMPTY);
}

export async function saveHiddenWords(words: string[]): Promise<string[]> {
  const next = await vaultUpdate<string[]>('hiddenWords', () => cleanHiddenWords(words));
  set({ words: next });
  return next;
}

/** Don't suggest this account again. */
export async function dismissSuggestion(id: string): Promise<void> {
  const next = await vaultUpdate<string[]>('suggestDismissed', (prev) => [id, ...ids(prev).filter((x) => x !== id)].slice(0, 1000));
  set({ dismissed: next });
}

/** Has the one-time explanation before the first public post been read on any of my devices? */
export async function publicExplained(): Promise<boolean> {
  await loadHiddenStore();
  return state.publicExplained;
}

export async function markPublicExplained(): Promise<void> {
  await vaultUpdate<{ at: string }>('publicExplained', (prev) => prev ?? { at: new Date().toISOString() });
  set({ publicExplained: true });
}
