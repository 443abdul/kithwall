'use client';
// Chronological feed for a scope (home, a profile, a circle, an event). Pages of 12, loaded as you
// scroll (and with a "Show older posts" button for keyboards), ending in a clear "You're all caught up".
// Posts are decrypted on this device as their keys arrive; likes and comments for a page are fetched in
// two batched queries (lib/feed/feed prefetchEngagement). Home leaves out people I muted (lib/social/prefs);
// a profile shows its pinned post first.
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { prefetchEngagement } from '@/lib/feed/feed';
import { useSession } from '@/lib/keys/session';
import type { FeedProps } from '.';
import { feedKey, fetchScopePage, refetchPost } from './data';
import { dedupeById } from './logic';
import { PostCard, PostCardSkeleton } from './PostCard';
import { usePostsLive } from './live';
import { isMuted, loadSocialPrefs, useSocialPrefs } from '@/lib/social/prefs';
import { usePerson } from '@/lib/people';

export function Feed({ scope, empty }: FeedProps) {
  const t = useT();
  const qc = useQueryClient();
  const { status, userId } = useSession();
  const sentinel = useRef<HTMLDivElement>(null);
  usePostsLive();
  const prefs = useSocialPrefs();
  useEffect(() => { if (status === 'ready') void loadSocialPrefs().catch(() => undefined); }, [status]);
  const owner = usePerson(scope.kind === 'profile' ? scope.userId : null);
  const pinnedId = scope.kind === 'profile' ? owner?.info?.pinnedPost ?? null : null;
  const pinned = useQuery({
    queryKey: ['pinned-post', pinnedId], enabled: status === 'ready' && !!pinnedId,
    queryFn: () => refetchPost(pinnedId!),
  });
  const q = useInfiniteQuery({
    queryKey: feedKey(scope),
    enabled: status === 'ready',
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await fetchScopePage(scope, pageParam);
      await prefetchEngagement(qc, page.rows).catch(() => undefined);
      return page;
    },
    getNextPageParam: (last) => last.cursor,
  });

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

  if (q.isPending) {
    return (
      <div className="k-feed" role="status" aria-label={t('feed.loading')}>
        <PostCardSkeleton /><PostCardSkeleton /><PostCardSkeleton />
      </div>
    );
  }
  if (q.isError) {
    return (
      <Card>
        <EmptyState icon="alert" title={t('feed.loadError')}
          actions={<Button variant="soft" icon="refresh" onClick={() => void q.refetch()}>{t('feed.retry')}</Button>} />
      </Card>
    );
  }
  const pin = pinned.data && pinned.data.author_id === (scope.kind === 'profile' ? scope.userId : '') ? pinned.data : null;
  const rows = dedupeById(q.data.pages.flatMap((p) => p.rows))
    .filter((r) => r.id !== pin?.id)
    .filter((r) => scope.kind !== 'home' || r.author_id === userId || !isMuted(prefs.muted, r.author_id));
  if (!rows.length && !pin && !hasNextPage) {
    return <>{empty ?? <Card><EmptyState icon="home" title={t('feed.emptyTitle')} body={t('feed.emptyBody')} /></Card>}</>;
  }
  return (
    <section className="k-feed" aria-label={t('profile.posts')} aria-busy={isFetchingNextPage || undefined}>
      {pin ? <PostCard key={`pin-${pin.id}`} row={pin} pinned /> : null}
      {rows.map((row) => <PostCard key={row.id} row={row} />)}
      <div ref={sentinel} className="k-feed-end">
        {hasNextPage ? (
          isFetchingNextPage
            ? <p className="k-feed-loading" role="status"><Spinner /> {t('feed.loadingMore')}</p>
            : <Button variant="ghost" onClick={() => void fetchNextPage()}>{t('feed.loadMore')}</Button>
        ) : (
          <div className="k-caughtup" role="status">
            <span className="k-caughtup-ico" aria-hidden><Icon name="check" /></span>
            <p className="k-caughtup-title">{t('feed.caughtUp')}</p>
            <p className="k-muted k-small">{t('feed.caughtUpBody')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
