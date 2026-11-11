'use client';
// A list of public posts for one query (lib/public/posts PublicPostQuery): the building block of Explore.
// Pages are loaded as you scroll (and with a button, for keyboards). Reusable for any slice of public posts,
// e.g. <PublicFeed query={{ kinds: ['video'] }} /> for a video feed. Works signed in or out; when signed in,
// people I muted and posts containing my hidden words are left out or folded away on this device.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { PostCardSkeleton } from '@/components/posts/PostCard';
import { useSession } from '@/lib/keys/session';
import { fetchPublicPosts, publicPostsKey, type PublicCursor, type PublicPostQuery, type PublicPostRow } from '@/lib/public/posts';
import { useHiddenStore } from '@/lib/social/hiddenStore';
import { isMuted, loadSocialPrefs, useSocialPrefs } from '@/lib/social/prefs';
import { PublicPostCard } from './PublicPostCard';

/** Infinite pages of public posts for a query, shared by every screen that lists them. */
export function usePublicPosts(query: PublicPostQuery) {
  return useInfiniteQuery({
    queryKey: publicPostsKey(query),
    initialPageParam: null as PublicCursor | null,
    queryFn: ({ pageParam }) => fetchPublicPosts(query, pageParam),
    getNextPageParam: (last) => last.next,
    staleTime: 60_000,
  });
}

export function PublicFeed({ query, empty, label }: { query: PublicPostQuery; empty?: ReactNode; label: string }) {
  const t = useT();
  const { status, userId } = useSession();
  const signedIn = status === 'ready';
  const hidden = useHiddenStore();
  const prefs = useSocialPrefs();
  useEffect(() => { if (signedIn) void loadSocialPrefs().catch(() => undefined); }, [signedIn]);
  const q = usePublicPosts(query);
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

  if (q.isPending) return <div className="k-feed" role="status" aria-label={t('feed.loading')}><PostCardSkeleton /><PostCardSkeleton /></div>;
  if (q.isError) {
    return (
      <Card>
        <EmptyState icon="alert" title={t('feed.loadError')}
          actions={<Button variant="soft" icon="refresh" onClick={() => void q.refetch()}>{t('feed.retry')}</Button>} />
      </Card>
    );
  }
  const seen = new Set<string>();
  const rows: PublicPostRow[] = [];
  for (const r of q.data.pages.flatMap((p) => p.rows)) {
    if (seen.has(r.id)) continue; // "popular" can move a post between pages while you scroll
    seen.add(r.id);
    if (signedIn && r.author_id !== userId && isMuted(prefs.muted, r.author_id)) continue;
    rows.push(r);
  }
  if (!rows.length && !hasNextPage) return <>{empty ?? <Card><EmptyState icon="globe" title={t('explore.emptyTitle')} body={t('explore.emptyBody')} /></Card>}</>;
  return (
    <section className="k-feed" aria-label={label} aria-busy={isFetchingNextPage || undefined}>
      {rows.map((row) => (
        <PublicPostCard key={row.id} row={row} hiddenWords={signedIn && row.author_id !== userId ? hidden.words : undefined}
          href={signedIn ? `/post/${row.id}` : `/p/${row.id}`} authorHref={signedIn ? `/u/${row.author_username}` : undefined} />
      ))}
      <div ref={sentinel} className="k-feed-end">
        {hasNextPage ? (
          isFetchingNextPage
            ? <p className="k-feed-loading" role="status"><Spinner /> {t('feed.loadingMore')}</p>
            : <Button variant="ghost" onClick={() => void fetchNextPage()}>{t('feed.loadMore')}</Button>
        ) : <p className="k-muted k-small k-center">{t('explore.end')}</p>}
      </div>
    </section>
  );
}
