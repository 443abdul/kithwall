'use client';
// React hooks for the on-device search (lib/search): the switch, a query's results, and the index size.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useHiddenChats } from '../safety/hidden';
import { searchEnabled, searchIndex, subscribeSearchEnabled, type DocKind, type SearchHit } from './index';

export function useSearchEnabled(): boolean {
  return useSyncExternalStore(subscribeSearchEnabled, searchEnabled, () => true);
}

/** Changes whenever the index does (content noted, removed, loaded, deleted). */
export function useSearchVersion(): number {
  return useSyncExternalStore(searchIndex.subscribe, searchIndex.getVersion, () => 0);
}

export interface SearchState { hits: SearchHit[]; searching: boolean }
const EMPTY: SearchHit[] = [];

/**
 * Results for a query, found on this device. Chats hidden behind the app PIN are left out unless they are
 * revealed right now (the same rule as the chat list). Typing is followed with a short delay.
 */
export function useSearch(query: string, opts: { kinds: readonly DocKind[]; ctx?: string; limit?: number }): SearchState {
  const enabled = useSearchEnabled();
  const version = useSearchVersion();
  const hidden = useHiddenChats();
  const [state, setState] = useState<SearchState & { key: string }>({ hits: EMPTY, searching: false, key: '' });
  const q = query.trim();
  const kinds = opts.kinds.join(',');
  const key = `${q}|${kinds}|${opts.ctx ?? ''}|${opts.limit ?? ''}`;
  useEffect(() => {
    if (!enabled || q.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      void searchIndex.search(q, {
        kinds: kinds.split(',') as DocKind[], ctx: opts.ctx, limit: opts.limit,
        exclude: (d) => d.kind === 'message' && hidden.has(d.ctx),
      }).then((hits) => { if (live) setState({ hits, searching: false, key }); })
        .catch(() => { if (live) setState({ hits: EMPTY, searching: false, key }); });
    }, 160);
    return () => { live = false; clearTimeout(timer); };
    // `version`: search again when the index changed (an edit, an unsend, older messages arriving).
  }, [enabled, q, kinds, key, opts.ctx, opts.limit, hidden, version]);
  if (!enabled || q.length < 2) return { hits: EMPTY, searching: false };
  // Results of an earlier query are not shown under a new one.
  return state.key === key ? { hits: state.hits, searching: false } : { hits: EMPTY, searching: true };
}

/** How many items the index holds (null until it has been read from the device's storage). */
export function useIndexSize(): number | null {
  useSearchVersion();
  const enabled = useSearchEnabled();
  useEffect(() => { if (enabled && searchIndex.isOpen) void searchIndex.ready(); });
  return searchIndex.isLoaded ? searchIndex.size : null;
}
