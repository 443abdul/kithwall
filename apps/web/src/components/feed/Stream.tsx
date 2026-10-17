'use client';
// A stream of stories with infinite scroll (cursor pagination by created_at). Each page's likes
// and comments are loaded in two batched queries and seeded into the per-story caches.
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Story } from './Story';
import { prefetchEngagement } from '@/lib/feed/feed';
import { getPrefs } from '@/lib/social/local';
import { useSession } from '@/lib/keys/session';
import type { PostRow } from '@/lib/types';

export interface StreamPage { rows: PostRow[]; next?: string }

export function pageOf(rows: PostRow[], pageSize: number): StreamPage {
  return { rows, next: rows.length >= pageSize ? rows[rows.length - 1]!.created_at : undefined };
}

export function Stream({ queryKey, load, wallContext, empty, arrange, canModerate, onRows }: {
  queryKey: readonly unknown[];
  load: (before?: string) => Promise<StreamPage>;
  wallContext?: string;
  empty: ReactNode;
  arrange?: (rows: PostRow[]) => PostRow[];
  canModerate?: boolean;
  /** Called (in an effect) with the rows shown, e.g. to derive a side panel. */
  onRows?: (rows: PostRow[]) => void;
}) {
  const { status } = useSession();
  const qc = useQueryClient();
  const q = useInfiniteQuery({
    queryKey, enabled: status === 'ready',
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await load(pageParam);
      await prefetchEngagement(qc, page.rows).catch(() => undefined);
      return page;
    },
    getNextPageParam: (last) => last.next,
  });
  const hiddenAtLoad = useMemo(() => new Set(getPrefs().hiddenPosts), []);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const all = (q.data?.pages ?? []).flatMap((p) => p.rows).filter((r) => {
      if (seen.has(r.id) || hiddenAtLoad.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    return arrange ? arrange(all) : all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, hiddenAtLoad]);

  useEffect(() => { onRows?.(rows); }, [rows, onRows]);

  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (q.isLoading) return <div className="stream"><div className="gray kw-pad">Loading stories…</div></div>;
  if (q.isError) {
    return <div className="stream"><div className="err" role="alert">Couldn&rsquo;t load stories. <a role="button" tabIndex={0} onClick={() => void q.refetch()}>Try again</a></div></div>;
  }
  return (
    <>
      <div className="stream">
        {rows.map((r) => <Story key={r.id} row={r} wallContext={wallContext} canModerate={canModerate} />)}
        {!rows.length && <div className="gray kw-pad">{empty}</div>}
      </div>
      {hasNextPage && (
        <div className="kw-older" ref={sentinel}>
          <button type="button" className="kw-link" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            <b>{isFetchingNextPage ? 'Loading…' : 'Older Posts'}</b>
          </button>
        </div>
      )}
    </>
  );
}
