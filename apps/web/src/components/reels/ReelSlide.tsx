'use client';
// One reel on the reels screen (docs/v2/12-reels.md §2): the video, its cover while it loads, and the controls
// over it. The video is fetched and decrypted on this device (hooks useReelVideo) and plays from a blob: URL.
//
//  - It plays by itself when it is the one on screen, muted until the person taps the video or the sound
//    button; after that sound stays on for the visit. A click that comes from the keyboard or from assistive
//    technology only plays or pauses: sound never starts without being asked for.
//  - With Data Saver nothing is fetched until the person taps play (the cover and the size are shown). With
//    "reduce motion" the video is fetched but waits for a tap.
//  - It pauses when another reel is on screen, when a sheet or a time screen is over it, and when the app
//    goes to the background.
//  - Tap: pause / play. Double tap: like. What I did with the reel (watched to the end, replayed, left it
//    quickly) is noted on this device only (lib/reels/data recordReelSignal).
import Link from 'next/link';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useFormat, useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { AudienceTag, formatBytes, RichText } from '@/components/posts/bits';
import { audienceOf } from '@/components/posts/data';
import { useFileUrl } from '@/lib/media';
import { people, usePerson } from '@/lib/people';
import { publicName } from '@/lib/public/posts';
import { recordReelSeen, recordReelSignal, reelCard } from '@/lib/reels/data';
import { isQuickSkip } from '@/lib/reels/rank';
import { useReelVideo } from './hooks';
import type { FeedItem } from './useReelFeed';

export interface ReelSlideProps {
  item: Extract<FeedItem, { kind: 'reel' }>;
  /** Position in the queue, for the accessible name. */
  n: number;
  /** This is the reel on screen. */
  active: boolean;
  /** Close to the one on screen: show its cover. */
  near: boolean;
  /** Fetch its video ahead (the next reel; never with Data Saver). */
  preload: boolean;
  /** The reel just left: its video stays in memory, so going back does not fetch it again. */
  keep: boolean;
  saver: boolean;
  /** "Reduce motion": never start playing without a tap. */
  reduced: boolean;
  /** Something is over the feed (a sheet, a time screen): stay paused. */
  blocked: boolean;
  soundOn: boolean;
  onSound: (on: boolean) => void;
  liked: boolean;
  /** Public like count (public reels only). */
  likeCount: number | null;
  onLike: (on: boolean) => void;
  /** false: show a Follow button; true: just followed; null: nothing to show. */
  following: boolean | null;
  onFollow: () => void;
  onComments: () => void;
  onShare: () => void;
  onMore: () => void;
  /** Seconds of this reel that just played, for the time controls. */
  onWatched: (secs: number) => void;
}

export function ReelSlide(p: ReelSlideProps) {
  const { item, active, soundOn } = p;
  const { reel, payload, candidate } = item;
  const t = useT();
  const f = useFormat();
  const video = payload.video!;
  const card = reelCard(reel);
  // A stranger from the public pages is never asked for from my people directory (it pins identity keys);
  // whoever it already knows is shown from there, with their picture.
  const known = people.person(reel.row.author_id);
  const author = usePerson(card && !known ? null : reel.row.author_id) ?? known;
  const avatar = useFileUrl(author?.info?.avatar?.thumb);
  const name = author?.name ?? (card ? publicName(card) : '…');
  const handle = author?.username ?? card?.author_username;
  const cover = useFileUrl(p.near ? video.poster : null);

  // Asked for by a tap (Data Saver, reduce motion). Starts over whenever the reel leaves the screen.
  const [asked, setAsked] = useState(false);
  const [paused, setPaused] = useState(false);
  // The first frame has been shown: from then on the video covers its cover picture.
  const [started, setStarted] = useState(false);
  const [burst, setBurst] = useState(0);
  const [visible, setVisible] = useState(true);
  if (!active && (asked || paused || started)) { setAsked(false); setPaused(false); setStarted(false); }

  const want = (active && (!p.saver || asked)) || ((p.preload || p.keep) && !p.saver);
  const { state, retry } = useReelVideo(video.file, want);
  const el = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stats = useRef({ watched: 0, loops: 0, started: false, last: 0, pending: 0 });
  const ready = state.s === 'ready';
  const auto = !p.saver && !p.reduced;
  const shouldPlay = active && ready && !p.blocked && !paused && visible && (auto || asked);

  // The app went to the background (or the tab was hidden): pause, and carry on when it is back.
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    on();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => { if (el.current) el.current.muted = !soundOn; }, [soundOn, ready]);

  const onSound = p.onSound;
  useEffect(() => {
    const v = el.current;
    if (!v) return;
    if (!shouldPlay) { v.pause(); return; }
    v.muted = !soundOn;
    v.play().catch(() => {
      // The browser refused sound without a tap on this page: play muted and show the sound button as off.
      if (!v.muted) { v.muted = true; onSound(false); void v.play().catch(() => undefined); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldPlay]);

  function rewind() {
    const v = el.current;
    if (v) { try { v.pause(); v.currentTime = 0; } catch { /* not loaded */ } }
    if (fill.current) fill.current.style.inlineSize = '0%';
  }

  // Shown for a moment: it counts as seen. Leaving it: note a quick skip, and start from the beginning next time.
  const onWatched = p.onWatched;
  useEffect(() => {
    if (!active) return;
    const s = stats.current;
    s.watched = 0; s.loops = 0; s.started = false; s.last = 0; s.pending = 0;
    const seen = setTimeout(() => recordReelSeen(reel.id), 1200);
    return () => {
      clearTimeout(seen);
      if (s.pending > 0) { onWatched(s.pending); s.pending = 0; }
      if (s.started) {
        recordReelSeen(reel.id);
        if (s.loops === 0 && isQuickSkip(s.watched, video.duration)) recordReelSignal(candidate, 'skip');
      }
      rewind();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reel.id]);

  useEffect(() => () => { if (tapTimer.current) clearTimeout(tapTimer.current); }, []);

  function onTime() {
    const v = el.current;
    if (!v || !active) return;
    const s = stats.current;
    const now = v.currentTime;
    const d = now - s.last;
    if (d > 0 && d < 1.5) { s.watched += d; s.pending += d; }
    // The video loops: jumping back to the start means it was watched to the end (and then again).
    else if (d < -0.5 && s.started) {
      s.loops++;
      if (s.loops === 1) recordReelSignal(candidate, 'complete');
      else if (s.loops === 2) recordReelSignal(candidate, 'replay');
    }
    s.last = now;
    s.started = true;
    if (s.pending >= 1) { onWatched(s.pending); s.pending = 0; }
    const total = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : video.duration ?? 0;
    const pct = total ? Math.min(100, Math.max(0, (now / total) * 100)) : 0;
    if (fill.current) fill.current.style.inlineSize = `${pct}%`;
    bar.current?.setAttribute('aria-valuenow', String(Math.round(pct)));
  }

  function toggle() {
    if (!ready || !(auto || asked)) { setAsked(true); setPaused(false); return; }
    setPaused((x) => !x);
  }

  function like() {
    if (!p.liked) p.onLike(true);
    setBurst((n) => n + 1);
  }

  function onTap(e: MouseEvent) {
    // Keyboard or assistive technology (no pointer): only play or pause. Sound is never turned on from here.
    if (e.detail === 0) { toggle(); return; }
    if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = null; like(); return; }
    tapTimer.current = setTimeout(() => {
      tapTimer.current = null;
      // The first tap turns the sound on (it stays on for this visit) without pausing.
      if (!soundOn) { p.onSound(true); if (shouldPlay) return; }
      toggle();
    }, 260);
  }

  const size = formatBytes(video.file.bytes, f.number);
  const waiting = active && !shouldPlay && !p.blocked;
  const tapLabel = shouldPlay ? t('reels.pause') : t('reels.play');
  const count = (n: number) => f.number(n, { notation: 'compact', maximumFractionDigits: 1 });

  return (
    <section className="k-reel" aria-label={t('reels.slideLabel', { n: p.n, name })} inert={!active} data-active={active ? '' : undefined}>
      <div className="k-reel-frame">
        <div className="k-reel-stage">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {cover ? <img className="k-reel-cover" src={cover} alt="" decoding="async" draggable={false} /> : null}
          {ready && (active || p.preload || p.keep) ? (
            <video ref={el} className="k-reel-video" src={state.url} playsInline loop muted={!soundOn} preload="auto" disablePictureInPicture
              data-shown={started ? '' : undefined} onPlaying={() => setStarted(true)} onTimeUpdate={onTime} />
          ) : null}
          <button type="button" className="k-reel-tap" aria-label={tapLabel} onClick={onTap} />
          {burst ? <span key={burst} className="k-reel-burst" aria-hidden><Icon name="heart" /></span> : null}
          {state.s === 'loading' && active ? (
            <span className="k-reel-wait" role="status"><Spinner size={20} /> {t('feed.downloading', { pct: state.pct })}</span>
          ) : state.s === 'error' && active ? (
            <span className="k-reel-wait" role="alert">
              {t('reels.loadFailed')} <button type="button" className="k-reel-pill" onClick={retry}>{t('feed.retry')}</button>
            </span>
          ) : waiting && state.s !== 'loading' ? (
            <button type="button" className="k-reel-bigplay" onClick={() => { setAsked(true); setPaused(false); }} aria-label={t('reels.play')}>
              <Icon name="play" />
              {/* Data Saver: say what a tap will cost before anything is fetched. */}
              {p.saver && !asked ? <span className="k-reel-bigplay-size">{size}</span> : null}
            </button>
          ) : null}
        </div>

        {shouldPlay && !soundOn ? <span className="k-reel-hint" aria-hidden><Icon name="volumeOff" /> {t('reels.tapForSound')}</span> : null}

        <div className="k-reel-info">
          <div className="k-reel-who">
            {/* prefetch={false}: fetching the author's profile page ahead would tell the web server which reel is on screen. */}
            {handle ? <Link href={`/u/${handle}`} prefetch={false} className="k-reel-av" tabIndex={-1} aria-hidden><Avatar name={name} src={avatar} size={40} /></Link> : <Avatar name={name} src={avatar} size={40} />}
            <span className="k-reel-names">
              {handle ? <Link href={`/u/${handle}`} prefetch={false} className="k-reel-name">{name}</Link> : <span className="k-reel-name">{name}</span>}
              {handle ? <span className="k-reel-handle k-ltr">@{handle}</span> : null}
            </span>
            {p.following === false ? (
              <button type="button" className="k-reel-pill" onClick={p.onFollow}>{t('follow.follow')}</button>
            ) : p.following === true ? (
              <span className="k-reel-pill" data-done=""><Icon name="check" /> {t('follow.following')}</span>
            ) : null}
          </div>
          {payload.text ? <RichText text={payload.text} clamp={90} className="k-reel-caption" /> : null}
          <div className="k-reel-meta">
            <AudienceTag audience={audienceOf(reel.row)} />
          </div>
        </div>

        <div className="k-reel-rail" role="group" aria-label={t('reels.actions')}>
          <button type="button" className="k-reel-act" aria-pressed={p.liked} data-on={p.liked ? '' : undefined} onClick={() => p.onLike(!p.liked)}
            aria-label={p.likeCount !== null ? t('reels.likeWithCount', { count: p.likeCount }) : p.liked ? t('feed.liked') : t('feed.like')}>
            <Icon name="heart" />
            {p.likeCount !== null ? <span aria-hidden>{count(p.likeCount)}</span> : null}
          </button>
          <button type="button" className="k-reel-act" aria-haspopup="dialog" onClick={p.onComments}
            aria-label={reel.comments !== undefined ? t('feed.commentCount', { count: reel.comments }) : t('feed.comment')}>
            <Icon name="comment" />
            {reel.comments !== undefined ? <span aria-hidden>{count(reel.comments)}</span> : null}
          </button>
          <button type="button" className="k-reel-act" onClick={p.onShare} aria-label={t('share.action')}><Icon name="share" /></button>
          <button type="button" className="k-reel-act" aria-pressed={soundOn} onClick={() => p.onSound(!soundOn)}
            aria-label={soundOn ? t('reels.soundOff') : t('reels.soundOn')}>
            <Icon name={soundOn ? 'volume' : 'volumeOff'} />
          </button>
          <button type="button" className="k-reel-act" aria-haspopup="dialog" onClick={p.onMore} aria-label={t('reels.more')}><Icon name="more" /></button>
        </div>

        <div ref={bar} className="k-reel-progress" role="progressbar" aria-label={t('reels.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}>
          <span ref={fill} />
        </div>
      </div>
    </section>
  );
}
