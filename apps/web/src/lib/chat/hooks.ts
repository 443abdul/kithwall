'use client';
// React Query hooks for Messages. Keys sit under ['conversations'] and ['messages', convId] so the
// Realtime bridge (Providers.tsx) refreshes them when rows change.
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { useSession } from '../keys/session';
import { fetchMessages, getConversation, markRead, type ConversationSummary } from '../messages';
import type { MessageRow } from '../types';
import { signals, useSignalsVersion } from './signals';
import { visibleNow } from './ephemeral';
import { useClock } from './clock';

export { useClock };

const PAGE = 50;

export function useConversation(id: string | null | undefined) {
  const { status } = useSession();
  return useQuery({
    queryKey: ['conversations', 'one', id], enabled: status === 'ready' && !!id,
    queryFn: () => getConversation(id!),
  });
}

/** Messages of a conversation, oldest first; `loadOlder` pages back 50 at a time. */
export function useMessages(convId: string | null | undefined) {
  const { status } = useSession();
  const q = useInfiniteQuery({
    queryKey: ['messages', convId], enabled: status === 'ready' && !!convId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchMessages({ id: convId! }, pageParam, PAGE),
    getNextPageParam: (first: MessageRow[]) => (first.length === PAGE ? first[0]!.created_at : undefined),
  });
  const all = useMemo(() => {
    const pages = q.data?.pages ?? [];
    const seen = new Set<string>();
    const out: MessageRow[] = [];
    for (let i = pages.length - 1; i >= 0; i--) for (const m of pages[i]!) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
    return out;
  }, [q.data]);
  // Expired messages and unsend tombstones never show (the server hides/deletes them too).
  const now = useClock(all);
  const rows = useMemo(() => visibleNow(all, now), [all, now]);
  return { ...q, rows, loadOlder: q.fetchNextPage, hasOlder: q.hasNextPage };
}

/** Mark a conversation read while it's on screen and the tab is visible. */
export function useMarkRead(conv: ConversationSummary | null | undefined, active: boolean) {
  const qc = useQueryClient();
  const lastId = conv?.last?.id;
  const unread = conv?.unread;
  const run = useCallback(() => {
    if (!conv || !active || document.visibilityState !== 'visible' || !unread) return;
    void markRead(conv).then(() => qc.invalidateQueries({ queryKey: ['conversations'] })).catch(() => undefined);
  }, [conv, active, unread, qc]);
  useEffect(() => { run(); }, [run, lastId]);
  useEffect(() => {
    const v = () => run();
    document.addEventListener('visibilitychange', v);
    return () => document.removeEventListener('visibilitychange', v);
  }, [run]);
}

/** Who (other than me) is typing in this conversation right now. */
export function useTyping(convId: string | null | undefined): string[] {
  useSignalsVersion();
  return convId ? signals.typingIn(convId) : [];
}
