'use client';
// Coalesced cache invalidation. One user action often invalidates the same key several times within a
// few milliseconds (sending a message: the send itself, our own Realtime echo, the conversation's
// "last message" update, mark-as-read), and every invalidation of a mounted query starts a new fetch,
// cancelling the one in flight. Keys passed here are invalidated once, shortly after the burst.
import type { QueryClient, QueryKey } from '@tanstack/react-query';

const WINDOW_MS = 150;
const queues = new WeakMap<QueryClient, { keys: Map<string, QueryKey>; timer: ReturnType<typeof setTimeout> | null }>();

export function invalidateSoon(qc: QueryClient, key: QueryKey): void {
  let q = queues.get(qc);
  if (!q) { q = { keys: new Map(), timer: null }; queues.set(qc, q); }
  q.keys.set(JSON.stringify(key), key);
  if (q.timer) return;
  const queue = q;
  queue.timer = setTimeout(() => {
    queue.timer = null;
    const keys = [...queue.keys.values()];
    queue.keys.clear();
    for (const k of keys) void qc.invalidateQueries({ queryKey: k });
  }, WINDOW_MS);
}
