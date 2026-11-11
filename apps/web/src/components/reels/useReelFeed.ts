'use client';
// The reels feed as the screen sees it (docs/v2/12-reels.md §3): candidates are fetched in whole pages that
// are the same for everyone, and the order is worked out here, on this device.
//
// Requests this makes, all of them per page and none of them per reel watched:
//   - reel_feed (reels of people I follow, my connections, my circles),
//   - explore_posts for public reels, once by popularity and once by time,
//   - which of the reels on those pages I already liked (one query for the page),
//   - the kind of audience of the encrypted ones (one query for the page), and the authors' public keys.
// A new page is asked for when few unseen reels are left, always the next page of every list that has one.
// What was watched, skipped, replayed or marked "not interested" stays in lib/reels/store on this device.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocale } from '@/i18n';
import { rememberAudienceKinds } from '@/components/posts/data';
import { setLike } from '@/lib/content';
import { fetchPost, notifySafe } from '@/lib/feed/feed';
import { me, useSession } from '@/lib/keys/session';
import { fetchPublicPost, type PublicCursor } from '@/lib/public/posts';
import { fetchFollowedReels, fetchPublicReels, openReel, reelCandidate, type Reel } from '@/lib/reels/data';
import { buildQueue, type QueueItem, type ReelCandidate } from '@/lib/reels/rank';
import { getReelState, loadReelState } from '@/lib/reels/store';
import { loadHiddenStore, useHiddenStore } from '@/lib/social/hiddenStore';
import { matchesHidden } from '@/lib/social/hiddenWords';
import { isMuted, loadSocialPrefs, useSocialPrefs, type MuteMap } from '@/lib/social/prefs';
import { sb, must } from '@/lib/supabase';
import type { PostPayload } from '@/lib/types';

export type FeedItem = { kind: 'reel'; reel: Reel; payload: PostPayload; candidate: ReelCandidate } | { kind: 'caughtUp' };

export interface FeedView {
  items: FeedItem[];
  status: 'loading' | 'ready' | 'error';
  /** Every list has been read to its end. */
  exhausted: boolean;
  loadingMore: boolean;
  /** There are reels I have seen that could be queued again. */
  canWatchAgain: boolean;
  /** Ids of the reels I like (as the pages said, moved by what I did here). */
  liked: ReadonlySet<string>;
  /** My own likes and unlikes in this sitting, to move the public count by. */
  likeDelta: ReadonlyMap<string, number>;
}

const EMPTY_VIEW: FeedView = { items: [], status: 'loading', exhausted: false, loadingMore: false, canWatchAgain: false, liked: new Set(), likeDelta: new Map() };

const sameQueue = (a: QueueItem[], b: QueueItem[]) => a.length === b.length && a.every((x, i) => x.kind === b[i]!.kind && (x.kind !== 'reel' || x.id === (b[i] as { id: string }).id));

/** One sitting in the reels screen: the candidates fetched so far and the queue built from them. */
export class ReelFeed {
  private reels = new Map<string, Reel>();
  private payloads = new Map<string, PostPayload>();
  private cands = new Map<string, ReelCandidate>();
  /** undefined: not asked yet; null: no further page. */
  private cursors: { followed: string | null | undefined; popular: PublicCursor | null | undefined; recent: PublicCursor | null | undefined } = { followed: undefined, popular: undefined, recent: undefined };
  private queue: QueueItem[] = [];
  private index = 0;
  private fetching = false;
  private includeSeen = false;
  private status: FeedView['status'] = 'loading';
  private liked = new Set<string>();
  private likeDelta = new Map<string, number>();
  private filters: { words: readonly string[]; muted: MuteMap; lang: string } = { words: [], muted: {}, lang: 'en' };
  private closed = false;
  /** Waiting for the reel the screen was opened on before anything is queued. */
  private holding = false;
  private view: FeedView = EMPTY_VIEW;
  private listeners = new Set<() => void>();
  // Changes the small shuffle between sittings (lib/reels/rank jitter).
  private readonly seed = Math.floor(Math.random() * 0x7fffffff);

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getView = () => this.view;

  private publish() {
    const items: FeedItem[] = [];
    for (const q of this.queue) {
      if (q.kind === 'caughtUp') { items.push({ kind: 'caughtUp' }); continue; }
      const reel = this.reels.get(q.id);
      const payload = this.payloads.get(q.id);
      const candidate = this.cands.get(q.id);
      if (reel && payload && candidate) items.push({ kind: 'reel', reel, payload, candidate });
    }
    this.view = {
      items, status: this.status,
      exhausted: this.cursors.followed === null && this.cursors.popular === null && this.cursors.recent === null,
      loadingMore: this.fetching && this.status === 'ready',
      canWatchAgain: !this.includeSeen && this.cands.size > this.queue.filter((q) => q.kind === 'reel').length,
      liked: new Set(this.liked), likeDelta: new Map(this.likeDelta),
    };
    this.listeners.forEach((l) => l());
  }

  /** My hidden words, the people I muted and my language: read on this device, applied on this device. */
  setFilters(f: { words: readonly string[]; muted: MuteMap; lang: string }) { this.filters = f; }

  close() { this.closed = true; this.listeners.clear(); }

  private rebuild(): boolean {
    const next = buildQueue([...this.cands.values()], getReelState().profile, {
      now: Date.now(), lang: this.filters.lang, seed: this.seed, fixed: this.queue.slice(0, this.index + 2), includeSeen: this.includeSeen,
      moreFollowed: this.cursors.followed !== null,
    });
    if (sameQueue(next, this.queue)) return false;
    this.queue = next;
    return true;
  }

  /** Take reels from a page into the candidate set. Unreadable ones, my own and filtered ones are left out. */
  private ingest(reels: Reel[], force = false) {
    const self = me();
    for (const reel of reels) {
      const had = this.reels.get(reel.id);
      if (had) {
        // Seen in a second list: keep the followed copy, take the public counts.
        const merged: Reel = had.source === 'discover' && reel.source === 'followed' ? { ...reel, likes: had.likes, comments: had.comments }
          : had.likes === undefined && reel.likes !== undefined ? { ...had, likes: reel.likes, comments: reel.comments } : had;
        if (merged !== had) {
          this.reels.set(reel.id, merged);
          const p = this.payloads.get(reel.id);
          if (p) this.cands.set(reel.id, reelCandidate(merged, p));
        }
        continue;
      }
      if (reel.row.author_id === self && !force) continue;
      const d = openReel(reel);
      if (!d.ok) continue; // key not here yet, or not verified: nothing to play
      if (!force) {
        if (isMuted(this.filters.muted, reel.row.author_id)) continue;
        if (matchesHidden(d.value.text, this.filters.words)) continue;
      }
      this.reels.set(reel.id, reel);
      this.payloads.set(reel.id, d.value);
      this.cands.set(reel.id, reelCandidate(reel, d.value));
    }
  }

  /** Which of these reels I liked before: one query for the whole page. */
  private async loadLiked(ids: string[]) {
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      const rows = (must(await sb().from('likes').select('target_id').eq('target_kind', 'post').eq('user_id', me()).in('target_id', part)) ?? []) as { target_id: string }[];
      for (const r of rows) this.liked.add(r.target_id);
    }
  }

  /** Fetch the next page of every list that has one. */
  loadBatch = async (): Promise<void> => {
    if (this.fetching || this.closed) return;
    const c = this.cursors;
    const first = c.followed === undefined;
    if (!first && c.followed === null && c.popular === null && c.recent === null) return;
    this.fetching = true;
    if (!first) this.publish();
    try {
      const [f, p, r] = await Promise.allSettled([
        c.followed === null ? null : fetchFollowedReels(c.followed),
        c.popular === null ? null : fetchPublicReels('popular', c.popular),
        c.recent === null ? null : fetchPublicReels('recent', c.recent),
      ]);
      if (this.closed) return;
      if (first && f.status === 'rejected' && p.status === 'rejected' && r.status === 'rejected') { this.status = 'error'; return; }
      const got: Reel[] = [];
      // A list that fails is not asked again in this sitting; the others carry on.
      if (f.status === 'fulfilled') { if (f.value) { got.push(...f.value.reels); c.followed = f.value.next; } } else c.followed = null;
      if (p.status === 'fulfilled') { if (p.value) { got.push(...p.value.reels); c.popular = p.value.next; } } else c.popular = null;
      if (r.status === 'fulfilled') { if (r.value) { got.push(...r.value.reels); c.recent = r.value.next; } } else c.recent = null;
      const newIds = [...new Set(got.map((x) => x.id))].filter((id) => !this.reels.has(id));
      await Promise.all([
        rememberAudienceKinds(got.filter((x) => x.source === 'followed').map((x) => x.row)).catch(() => undefined),
        newIds.length ? this.loadLiked(newIds).catch(() => undefined) : undefined,
      ]);
      if (this.closed) return;
      this.ingest(got);
      // While the reel the screen was opened on is still being looked up, nothing is shown yet: putting it
      // above a queue that is already on screen would leave the person on the wrong reel.
      if (!this.holding) { this.status = 'ready'; this.rebuild(); }
    } finally {
      this.fetching = false;
      if (!this.closed) this.publish();
    }
  };

  /** Read what this device keeps (profile, mutes, hidden words), then the first pages; `startId` plays first. */
  async start(startId?: string | null): Promise<void> {
    await Promise.all([loadReelState().catch(() => undefined), loadSocialPrefs().catch(() => undefined), loadHiddenStore().catch(() => undefined)]);
    if (this.closed) return;
    this.holding = !!startId;
    await this.loadBatch();
    if (this.closed || !startId) return;
    if (this.status === 'error') { this.holding = false; return; }
    // Opened on one reel (from a grid, the shelf or a link): it plays first, whatever the ranking says.
    if (!this.reels.has(startId)) {
      const pub = await fetchPublicPost(startId).catch(() => null);
      if (pub && pub.kind === 'reel') this.ingest([{ id: pub.id, row: pub, source: 'discover', likes: pub.like_count, comments: pub.comment_count }], true);
      else {
        const row = await fetchPost(startId).catch(() => null);
        if (row && row.kind === 'reel') { await rememberAudienceKinds([row]).catch(() => undefined); this.ingest([{ id: row.id, row, source: 'followed' }], true); }
      }
      if (this.reels.has(startId)) await this.loadLiked([startId]).catch(() => undefined);
    }
    if (this.closed) return;
    this.holding = false;
    const c = this.cands.get(startId);
    // (A reel that is gone, or not mine to see, simply isn't there: the feed starts as usual.)
    if (c) this.queue = [{ kind: 'reel', id: c.id, source: c.source }];
    this.index = 0;
    this.status = 'ready';
    this.rebuild();
    this.publish();
  }

  /** The reel on screen changed: re-rank what comes after the next one, and fetch more when few are left. */
  setIndex = (i: number): void => {
    if (i === this.index) return;
    this.index = i;
    const changed = this.rebuild();
    const ahead = this.queue.slice(i + 1).filter((q) => q.kind === 'reel').length;
    if (ahead < 5) void this.loadBatch();
    if (changed) this.publish();
  };

  /** Nothing new is left: queue the reels I have already seen again. */
  watchAgain = (): void => {
    this.includeSeen = true;
    if (this.rebuild()) this.publish();
  };

  /** Like or unlike (shown at once, taken back if the server refuses). */
  setLiked = async (reel: Reel, on: boolean): Promise<boolean> => {
    const was = this.liked.has(reel.id);
    if (was === on) return true;
    const step = on ? 1 : -1;
    if (on) this.liked.add(reel.id); else this.liked.delete(reel.id);
    this.likeDelta.set(reel.id, (this.likeDelta.get(reel.id) ?? 0) + step);
    this.publish();
    try {
      await setLike('post', reel.id, on);
      if (on) await notifySafe(reel.row.author_id, 'like', 'post', reel.id);
      return true;
    } catch {
      if (was) this.liked.add(reel.id); else this.liked.delete(reel.id);
      this.likeDelta.set(reel.id, (this.likeDelta.get(reel.id) ?? 0) - step);
      if (!this.closed) this.publish();
      return false;
    }
  };
}

/** The feed for this visit to the reels screen (a new one per account and per starting reel). */
export function useReelFeed(startId?: string | null): { feed: ReelFeed | null; view: FeedView } {
  const { status, userId } = useSession();
  const { locale } = useLocale();
  const hidden = useHiddenStore();
  const prefs = useSocialPrefs();
  const [feed, setFeed] = useState<ReelFeed | null>(null);
  const ready = status === 'ready' && !!userId;
  useEffect(() => {
    if (!ready) return;
    const f = new ReelFeed();
    setFeed(f);
    void f.start(startId);
    return () => { f.close(); setFeed(null); };
  }, [ready, userId, startId]);
  useEffect(() => { feed?.setFilters({ words: hidden.words, muted: prefs.muted, lang: locale }); }, [feed, hidden.words, prefs.muted, locale]);
  const view = useSyncExternalStore(feed ? feed.subscribe : noSubscribe, feed ? feed.getView : emptyView, emptyView);
  return { feed, view };
}

const noSubscribe = () => () => undefined;
const emptyView = () => EMPTY_VIEW;
