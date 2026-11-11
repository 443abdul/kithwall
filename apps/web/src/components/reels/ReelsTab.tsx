'use client';
// Reels in Explore and on Home (docs/v2/12-reels.md §2): the way into the full-screen feed.
//  - ReelsTab: the Explore tab. "Watch reels", a prominent "+", and the covers of popular public reels
//    (the generic list everyone gets; a tap opens the feed on that reel).
//  - ReelsShelf: a small shelf on Home with the covers of reels by people I follow or am connected to.
// Covers are small encrypted pictures like any post picture; with Data Saver they are not fetched.
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { usePublicPosts } from '@/components/explore/PublicFeed';
import { useAppSetting, useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { useFileUrl } from '@/lib/media';
import { useDataSaver } from '@/lib/net/dataSaver';
import { people, usePeopleVersion } from '@/lib/people';
import { openPublicPost, publicName, type PublicPostRow } from '@/lib/public/posts';
import { fetchFollowedReels, openReel, REEL_PAGE } from '@/lib/reels/data';
import { useReelState } from '@/lib/reels/store';
import { useHiddenStore } from '@/lib/social/hiddenStore';
import { matchesHidden } from '@/lib/social/hiddenWords';
import { isMuted, loadSocialPrefs, useSocialPrefs } from '@/lib/social/prefs';
import type { PostPayload } from '@/lib/types';
import '@/styles/v2/reels.css';

const ReelComposer = dynamic(() => import('./ReelComposer').then((m) => m.ReelComposer), { ssr: false });

/** One cover: opens the feed on that reel. */
function ReelTile({ id, payload, name, likes, saver }: { id: string; payload: PostPayload; name: string; likes?: number; saver: boolean }) {
  const t = useT();
  const f = useFormat();
  const cover = useFileUrl(saver ? null : payload.video?.poster);
  const caption = (payload.text ?? '').replace(/\s+/g, ' ').trim();
  return (
    <Link href={`/reels?start=${id}`} prefetch={false} className="k-reeltile" aria-label={caption ? t('reels.tileLabelCaption', { name, caption: caption.slice(0, 80) }) : t('reels.tileLabel', { name })}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {cover ? <img src={cover} alt="" decoding="async" loading="lazy" /> : <span className="k-reeltile-ph" aria-hidden><Icon name="reel" /></span>}
      <span className="k-reeltile-info" aria-hidden>
        <span className="k-reeltile-name">{name}</span>
        {likes !== undefined ? <span className="k-reeltile-likes"><Icon name="heart" /> {f.number(likes, { notation: 'compact', maximumFractionDigits: 1 })}</span> : null}
      </span>
    </Link>
  );
}

export function ReelsTab() {
  const t = useT();
  const { status, userId } = useSession();
  const signedIn = status === 'ready';
  const enabled = useAppSetting('reels_enabled');
  const saver = useDataSaver();
  const hidden = useHiddenStore();
  const prefs = useSocialPrefs();
  useEffect(() => { if (signedIn) void loadSocialPrefs().catch(() => undefined); }, [signedIn]);
  const [making, setMaking] = useState(false);
  const q = usePublicPosts({ kinds: ['reel'], sort: 'popular', limit: REEL_PAGE });
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: { row: PublicPostRow; payload: PostPayload }[] = [];
    for (const row of q.data?.pages.flatMap((p) => p.rows) ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const d = openPublicPost(row);
      if (!d.ok || !d.value.video?.file) continue;
      if (row.author_id !== userId && (isMuted(prefs.muted, row.author_id) || matchesHidden(d.value.text, hidden.words))) continue;
      out.push({ row, payload: d.value });
    }
    return out;
  }, [q.data, userId, prefs.muted, hidden.words]);

  if (enabled.data === false) return <Card><EmptyState icon="reel" title={t('reels.offTitle')} body={t('reels.offBody')} /></Card>;
  return (
    <div className="k-stack">
      <div className="k-reels-cta">
        <ButtonLink href="/reels" variant="primary" icon="play">{t('reels.watch')}</ButtonLink>
        <Button variant="secondary" icon="plus" aria-haspopup="dialog" onClick={() => setMaking(true)}>{t('reels.new')}</Button>
      </div>
      {q.isPending ? <p className="k-feed-loading" role="status"><Spinner /> {t('feed.loading')}</p>
        : q.isError ? (
          <Card><EmptyState icon="alert" title={t('feed.loadError')} actions={<Button variant="soft" icon="refresh" onClick={() => void q.refetch()}>{t('feed.retry')}</Button>} /></Card>
        ) : rows.length ? (
          <>
            <ul className="k-reelgrid" role="list" aria-label={t('reels.tab.popular')}>
              {rows.map(({ row, payload }) => <li key={row.id}><ReelTile id={row.id} payload={payload} name={publicName(row)} likes={row.like_count} saver={saver} /></li>)}
            </ul>
            {q.hasNextPage ? (
              <div className="k-feed-end">
                <Button variant="ghost" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('feed.loadMore')}</Button>
              </div>
            ) : null}
          </>
        ) : <Card><EmptyState icon="reel" title={t('reels.emptyTitle')} body={t('reels.emptyBody')} /></Card>}
      <p className="k-xs k-muted k-center">{t('reels.tab.note')}</p>
      {making ? <ReelComposer open onClose={() => setMaking(false)} audience={{ kind: 'connections' }} /> : null}
    </div>
  );
}

/** Home: reels by people I follow or am connected to (the ones I haven't seen first), and the way into the feed. */
export function ReelsShelf() {
  const t = useT();
  const { status, userId } = useSession();
  const enabled = useAppSetting('reels_enabled');
  const saver = useDataSaver();
  const hidden = useHiddenStore();
  const prefs = useSocialPrefs();
  const mine = useReelState();
  useKeyringVersion();
  usePeopleVersion();
  const on = status === 'ready' && enabled.data === true;
  const q = useQuery({ queryKey: ['reels', 'shelf', userId], enabled: on, staleTime: 5 * 60_000, queryFn: async () => (await fetchFollowedReels()).reels });
  if (!on) return null;
  const tiles: { id: string; payload: PostPayload; name: string; seen: boolean }[] = [];
  for (const reel of q.data ?? []) {
    const d = openReel(reel);
    if (!d.ok || isMuted(prefs.muted, reel.row.author_id) || matchesHidden(d.value.text, hidden.words) || mine.profile.hidden[reel.id]) continue;
    tiles.push({ id: reel.id, payload: d.value, name: people.person(reel.row.author_id)?.name ?? '…', seen: !!mine.profile.seen[reel.id] });
  }
  tiles.sort((a, b) => Number(a.seen) - Number(b.seen));
  return (
    <Card as="section" className="k-reelshelf" aria-label={t('reels.title')}>
      <div className="k-reelshelf-head">
        <h2 className="k-card-title"><Icon name="reel" /> {t('reels.title')}</h2>
        <ButtonLink href="/reels" variant="soft" size="sm" icon="play">{t('reels.watch')}</ButtonLink>
      </div>
      {tiles.length && !saver ? (
        <ul className="k-reelshelf-row" role="list">
          {tiles.slice(0, 8).map((x) => <li key={x.id} data-seen={x.seen ? '' : undefined}><ReelTile id={x.id} payload={x.payload} name={x.name} saver={saver} /></li>)}
        </ul>
      ) : <p className="k-muted k-small">{tiles.length ? t('reels.shelf.some', { count: tiles.length }) : t('reels.shelf.none')}</p>}
    </Card>
  );
}
