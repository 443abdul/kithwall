'use client';
// Reels (docs/v2/12-reels.md): a full-screen, vertical feed of short videos, one per screen, snapping from
// one to the next. Reels of the people I follow and public reels from everyone are mixed and ordered ON
// THIS DEVICE (./useReelFeed, lib/reels/rank); "You're all caught up" comes when the followed ones run out.
// Nothing about what I watch is sent anywhere: no view, no impression, no watch time.
//
//  - Only the reel on screen plays; the next one is fetched ahead and the one just left is kept (neither
//    with Data Saver).
//  - Keys: ↓ / PgDn / J next, ↑ / PgUp / K previous, M sound, L like. Every control is a real button.
//  - Android's Back closes an open sheet (comments, more, report) first, then leaves reels.
//  - The optional daily limit and break reminder (lib/reels/time) show a calm screen over the feed.
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '@/i18n';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Comments, useComments } from '@/components/posts/Comments';
import { isWide } from '@/components/posts/data';
import { ReportDialog } from '@/components/posts/ReportDialog';
import { ShareDialog } from '@/components/posts/Share';
import { postContentKey } from '@/lib/content';
import { follow, myFollowingIds } from '@/lib/follow/follow';
import { myFriendIds } from '@/lib/friends';
import { useAppSetting } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { useDataSaver } from '@/lib/net/dataSaver';
import { publicName, publicPostPath } from '@/lib/public/posts';
import { recordReelSignal, reelCard, type Reel } from '@/lib/reels/data';
import type { ReelCandidate } from '@/lib/reels/rank';
import { getReelState, updateReelState, useReelState } from '@/lib/reels/store';
import { addWatch, breakDue, dismissLimit, limitReached, watchedToday } from '@/lib/reels/time';
import { useBackCloses, useReducedMotion } from './hooks';
import { ReelSlide } from './ReelSlide';
import { useReelFeed, type FeedItem } from './useReelFeed';
import '@/styles/v2/reels.css';

// The maker (trim, cover, encoder) is its own chunk, loaded when someone starts a reel.
const ReelComposer = dynamic(() => import('./ReelComposer').then((m) => m.ReelComposer), { ssr: false });

type ReelItem = Extract<FeedItem, { kind: 'reel' }>;
type Sheet = { kind: 'comments' | 'more' | 'report' | 'share'; id: string };

export function ReelsScreen({ startId }: { startId?: string }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const { userId, status } = useSession();
  useDocumentTitle(t('reels.title'));
  const saver = useDataSaver();
  const reduced = useReducedMotion();
  const enabled = useAppSetting('reels_enabled');
  const { feed, view } = useReelFeed(startId);
  const mine = useReelState();
  const [index, setIndex] = useState(0);
  // Sound is off until the person asks for it, then stays on for this visit.
  const [soundOn, setSoundOn] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [making, setMaking] = useState(false);
  const [breakAt, setBreakAt] = useState<number | null>(null);
  const [justFollowed, setJustFollowed] = useState<ReadonlySet<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const sitting = useRef({ secs: 0, lastBreak: 0 });
  const closeSheet = useBackCloses(!!sheet, () => setSheet(null));

  // Whom I already follow or am connected to (one request per visit): only strangers get a Follow button.
  const graph = useQuery({
    queryKey: ['reels', 'graph', userId], enabled: status === 'ready', staleTime: 5 * 60_000,
    queryFn: async () => new Set([...(await myFollowingIds()), ...(await myFriendIds())]),
  });

  const items = view.items;
  const count = items.length + 1; // plus the closing slide
  const slots = items.map((x) => (x.kind === 'reel' ? x.reel.id : '*')).join(',');
  const at = Math.min(index, count - 1);
  const current = items[at]?.kind === 'reel' ? (items[at] as ReelItem) : null;
  const byId = (id: string | undefined) => items.find((x): x is ReelItem => x.kind === 'reel' && x.reel.id === id) ?? null;
  const sheetItem = byId(sheet?.id);

  useEffect(() => { feed?.setIndex(at); }, [feed, at]);

  // Which slide is on screen.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio >= 0.6) setIndex(Number((e.target as HTMLElement).dataset.i));
      }
    }, { root, threshold: [0.6] });
    root.querySelectorAll('[data-i]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [slots, view.status]);

  const go = useCallback((i: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-i="${Math.max(0, Math.min(count - 1, i))}"]`);
    el?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  }, [count, reduced]);

  const leave = () => { if (window.history.length > 1) router.back(); else router.replace('/explore?tab=reels'); };

  // Time controls: count what actually played, on this device only.
  const onWatched = useCallback((secs: number) => {
    updateReelState((s) => ({ time: addWatch(s.time, secs, new Date()) }));
    const sit = sitting.current;
    sit.secs += secs;
    if (breakDue(getReelState().time.breakMin, sit.secs, sit.lastBreak)) { sit.lastBreak = sit.secs; setBreakAt(Math.round(sit.secs / 60)); }
  }, []);
  // The day and today's count depend on the clock.
  const now = new Date();
  const limit = mine.loaded && limitReached(mine.time, now);
  const blocked = !!sheet || making || limit || breakAt !== null;

  async function like(item: ReelItem, on: boolean) {
    if (!feed) return;
    if (on) recordReelSignal(item.candidate, 'like');
    if (!(await feed.setLiked(item.reel, on))) toast({ message: t('feed.failed'), tone: 'danger' });
  }

  async function followAuthor(item: ReelItem, name: string) {
    const id = item.reel.row.author_id;
    try {
      await follow(id);
      setJustFollowed((s) => new Set(s).add(id));
      recordReelSignal(item.candidate, 'follow');
      toast({ message: t('follow.followed', { name }) });
    } catch { toast({ message: t('feed.failed'), tone: 'danger' }); }
  }

  async function share(item: ReelItem) {
    const row = item.reel.row;
    if (!(row.is_public && row.wall_owner_id)) { setSheet({ kind: 'share', id: row.id }); return; }
    // A public reel has a link anyone can open.
    const url = `${location.origin}${publicPostPath(row.id)}`;
    try {
      if (typeof navigator.share === 'function') await navigator.share({ url });
      else { await navigator.clipboard.writeText(url); toast({ message: t('follow.public.linkCopied') }); }
      recordReelSignal(item.candidate, 'share');
    } catch { /* the share sheet was dismissed */ }
  }

  function notInterested(item: ReelItem) {
    recordReelSignal(item.candidate, 'not_interested');
    closeSheet();
    toast({ message: t('reels.notInterestedDone') });
    go(at + 1);
  }

  async function copyLink(item: ReelItem) {
    closeSheet();
    try {
      await navigator.clipboard.writeText(`${location.origin}${publicPostPath(item.reel.id)}`);
      toast({ message: t('follow.public.linkCopied') });
    } catch { toast({ message: t('feed.failed'), tone: 'danger' }); }
  }

  function onKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (e.altKey || e.ctrlKey || e.metaKey || el.closest('textarea, input, select, [contenteditable="true"], dialog')) return;
    const k = e.key.toLowerCase();
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || k === 'j') { e.preventDefault(); go(at + 1); }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp' || k === 'k') { e.preventDefault(); go(at - 1); }
    else if (k === 'm') { e.preventDefault(); setSoundOn((x) => !x); }
    else if (k === 'l' && current) { e.preventDefault(); void like(current, !view.liked.has(current.reel.id)); }
  }

  const followingOf = (reel: Reel): boolean | null => {
    const a = reel.row.author_id;
    if (a === userId) return null;
    if (justFollowed.has(a)) return true;
    // Only for public reels of people I neither follow nor am connected to.
    return reelCard(reel) && graph.data && !graph.data.has(a) ? false : null;
  };
  const likeCountOf = (reel: Reel): number | null => (reel.likes === undefined ? null : Math.max(0, reel.likes + (view.likeDelta.get(reel.id) ?? 0)));

  const off = enabled.data === false;
  const first = view.status === 'loading';
  return (
    <main id="main" className="k-reels" onKeyDown={onKey}>
      <header className="k-reels-top">
        <button type="button" className="k-reel-act" onClick={leave} aria-label={t('reels.leave')}><Icon name="back" /></button>
        <h1 className="k-reels-title">{t('reels.title')}</h1>
        {!off ? (
          <button type="button" className="k-reel-act k-reels-new" aria-haspopup="dialog" onClick={() => setMaking(true)} aria-label={t('reels.new')}><Icon name="plus" /></button>
        ) : null}
      </header>

      {off ? (
        <div className="k-reels-note">
          <Icon name="info" /><h2>{t('reels.offTitle')}</h2><p>{t('reels.offBody')}</p>
          <ButtonLink href="/home" variant="soft">{t('nav.home')}</ButtonLink>
        </div>
      ) : first ? (
        <div className="k-reels-note" role="status"><Spinner /><p>{t('reels.loading')}</p></div>
      ) : view.status === 'error' ? (
        <div className="k-reels-note" role="alert">
          <Icon name="alert" /><h2>{t('feed.loadError')}</h2>
          <Button variant="soft" icon="refresh" onClick={() => void feed?.loadBatch()}>{t('feed.retry')}</Button>
        </div>
      ) : (
        <div ref={scroller} className="k-reels-scroll" tabIndex={-1} aria-label={t('reels.feedLabel')} role="feed" aria-busy={view.loadingMore || undefined}>
          {items.map((item, i) => (
            <div key={item.kind === 'reel' ? item.reel.id : 'caught-up'} data-i={i} className="k-reels-slot" role="article"
              aria-posinset={i + 1} aria-setsize={-1}>
              {item.kind === 'caughtUp' ? (
                <section className="k-reel k-reel-card" aria-label={t('reels.caughtUpTitle')} inert={i !== at} data-active={i === at ? '' : undefined}>
                  <span className="k-reel-card-ico" aria-hidden><Icon name="check" /></span>
                  <h2>{t('reels.caughtUpTitle')}</h2>
                  <p>{i < items.length - 1 ? t('reels.caughtUpMore') : t('reels.caughtUpEnd')}</p>
                  {i < items.length - 1 ? <button type="button" className="k-reel-pill" onClick={() => go(i + 1)}><Icon name="down" /> {t('reels.keepGoing')}</button> : null}
                </section>
              ) : (
                <ReelSlide item={item} n={i + 1} active={i === at} near={Math.abs(i - at) <= 2} preload={i === at + 1} keep={i === at - 1}
                  saver={saver} reduced={reduced} blocked={blocked} soundOn={soundOn} onSound={setSoundOn}
                  liked={view.liked.has(item.reel.id)} likeCount={likeCountOf(item.reel)} onLike={(on) => void like(item, on)}
                  following={followingOf(item.reel)}
                  onFollow={() => void followAuthor(item, reelCard(item.reel) ? publicName(reelCard(item.reel)!) : '')}
                  onComments={() => setSheet({ kind: 'comments', id: item.reel.id })}
                  onShare={() => void share(item)}
                  onMore={() => setSheet({ kind: 'more', id: item.reel.id })}
                  onWatched={onWatched} />
              )}
            </div>
          ))}
          <div data-i={items.length} className="k-reels-slot">
            <section className="k-reel k-reel-card" aria-label={t('reels.endTitle')} inert={at !== items.length} data-active={at === items.length ? '' : undefined}>
              {!view.exhausted ? (
                <><Spinner /><p role="status">{t('reels.loadingMore')}</p></>
              ) : (
                <>
                  <span className="k-reel-card-ico" aria-hidden><Icon name={items.length ? 'check' : 'reel'} /></span>
                  <h2>{items.length ? t('reels.endTitle') : view.canWatchAgain ? t('reels.caughtUpTitle') : t('reels.emptyTitle')}</h2>
                  <p>{items.length || view.canWatchAgain ? t('reels.endBody') : t('reels.emptyBody')}</p>
                  <div className="k-reel-card-actions">
                    {view.canWatchAgain ? <button type="button" className="k-reel-pill" onClick={() => feed?.watchAgain()}><Icon name="refresh" /> {t('reels.watchAgain')}</button> : null}
                    <button type="button" className="k-reel-pill" onClick={() => setMaking(true)}><Icon name="plus" /> {t('reels.new')}</button>
                    <button type="button" className="k-reel-pill" onClick={leave}>{t('reels.leave')}</button>
                  </div>
                  <p className="k-reel-card-note">{t('reels.privateNote')}</p>
                </>
              )}
            </section>
          </div>
        </div>
      )}

      {/* Comments: the existing thread, in a sheet. Back closes it before it leaves reels. */}
      <Dialog open={sheet?.kind === 'comments'} onClose={closeSheet} title={t('reels.comments')} sheet className="k-reels-sheet">
        {sheet?.kind === 'comments' && sheetItem ? <CommentsBody item={sheetItem} /> : null}
      </Dialog>

      <Dialog open={sheet?.kind === 'more'} onClose={closeSheet} title={t('reels.more')} sheet>
        {sheet?.kind === 'more' && sheetItem ? (
          <ul className="k-list" role="list">
            <li>
              <button type="button" className="k-item" onClick={() => notInterested(sheetItem)}>
                <span className="k-item-lead k-item-icon"><Icon name="eyeOff" /></span>
                <span className="k-item-body"><span className="k-item-title">{t('reels.notInterested')}</span><span className="k-item-sub">{t('reels.notInterestedSub')}</span></span>
              </button>
            </li>
            {sheetItem.reel.row.is_public && sheetItem.reel.row.wall_owner_id ? (
              <li>
                <button type="button" className="k-item" onClick={() => void copyLink(sheetItem)}>
                  <span className="k-item-lead k-item-icon"><Icon name="link" /></span>
                  <span className="k-item-body"><span className="k-item-title">{t('follow.public.copyLink')}</span></span>
                </button>
              </li>
            ) : null}
            <li>
              <button type="button" className="k-item" onClick={() => setSheet({ kind: 'report', id: sheetItem.reel.id })}>
                <span className="k-item-lead k-item-icon"><Icon name="flag" /></span>
                <span className="k-item-body"><span className="k-item-title">{t('feed.report')}</span><span className="k-item-sub">{t('reels.reportSub')}</span></span>
              </button>
            </li>
          </ul>
        ) : null}
      </Dialog>

      {sheetItem ? (
        <ReportDialog open={sheet?.kind === 'report'} onClose={closeSheet} kind="post" id={sheetItem.reel.id}
          disclosure={() => ({ plaintext: sheetItem.payload, contentKey: postContentKey(sheetItem.reel.row), keyKind: 'content' })} />
      ) : null}
      {sheet?.kind === 'share' && sheetItem ? <ShareDialog row={sheetItem.reel.row} onClose={closeSheet} /> : null}

      {/* The limit I set for myself (Settings → Reels). Calm, and mine to dismiss. */}
      <Dialog open={limit} onClose={leave} dismissible={false} title={t('reels.limit.title')}
        footer={<>
          <Button variant="ghost" onClick={() => updateReelState((s) => ({ time: dismissLimit(s.time, new Date()) }))}>{t('reels.limit.keep')}</Button>
          <Button variant="primary" onClick={leave}>{t('reels.leave')}</Button>
        </>}>
        <div className="k-stack">
          <p>{t('reels.limit.body', { limit: mine.time.limitMin, watched: Math.round(watchedToday(mine.time, now) / 60) })}</p>
          <p className="k-small k-muted">{t('reels.limit.note')} <Link href="/you/settings/reels" prefetch={false} className="k-linkbtn">{t('reels.limit.settings')}</Link></p>
        </div>
      </Dialog>
      <Dialog open={breakAt !== null && !limit} onClose={() => setBreakAt(null)} title={t('reels.break.title')}
        footer={<>
          <Button variant="ghost" onClick={() => setBreakAt(null)}>{t('reels.break.keep')}</Button>
          <Button variant="primary" onClick={leave}>{t('reels.leave')}</Button>
        </>}>
        <p>{t('reels.break.body', { count: breakAt ?? 0 })}</p>
      </Dialog>

      {making ? <ReelComposer open onClose={() => setMaking(false)} audience={{ kind: 'connections' }} /> : null}
    </main>
  );
}

/** The comments of one reel. A comment I add counts for my on-device profile (never sent anywhere as a signal). */
function CommentsBody({ item }: { item: ReelItem }) {
  const { userId } = useSession();
  const row = item.reel.row;
  const q = useComments(row.id, isWide(row));
  const mineCount = q.data ? q.data.filter((c) => c.author_id === userId).length : null;
  const seen = useRef<number | null>(null);
  const candidate: ReelCandidate = item.candidate;
  useEffect(() => {
    if (mineCount === null) return;
    if (seen.current !== null && mineCount > seen.current) recordReelSignal(candidate, 'comment');
    seen.current = mineCount;
  }, [mineCount, candidate]);
  return <Comments post={row} contentKey={postContentKey(row)} focusSignal={0} />;
}
