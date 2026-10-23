'use client';
// Pop-out gallery ("photo theatre") for one post or one chat message: every photo and video of it, full
// screen, without leaving the page.
//  - Swipe / arrow keys / buttons / thumbnails (desktop) between items, "3 / 7"; pinch, double-tap, wheel and
//    + / - keys zoom photos, drag pans; swipe down, Esc, Back (browser, and Android via lib/native/runtime.ts,
//    which closes the top-most open <dialog> first) close it. Opening pushes a history entry (same URL).
//  - Desktop (≥ 1024 px): media on the left, the post (author, text, like, comments) on the right.
//    Phone: media full screen; a tap shows / hides the caption, like and comment buttons; comments in a sheet.
//  - Download (decrypted on this device), share the post's internal link, report.
// Performance: rendered only while open (and loaded as its own chunk); only the current item is decoded
// at full size (neighbours are prefetched into lib/media's object-URL cache, thumbnails use the small
// "thumb" files); a video is downloaded and decrypted only when played, and its object URL is revoked as
// soon as it is left.
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as RPointerEvent } from 'react';
import { useFormat, useLocale, useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { swipeAction } from '@/components/albums/gestures';
import { RelativeTime, RichText, formatBytes, formatDuration } from '@/components/posts/bits';
import { Comments, useComments } from '@/components/posts/Comments';
import { ReportDialog } from '@/components/posts/ReportDialog';
import { usePostLike } from '@/components/posts/useLike';
import { postContentKey } from '@/lib/content';
import { useSession } from '@/lib/keys/session';
import { downloadFile, fileUrl, useFileUrl } from '@/lib/media';
import { usePerson, usePeopleVersion } from '@/lib/people';
import { downloadPhoto } from '@/lib/photos';
import type { FileRef, PostPayload, PostRow } from '@/lib/types';
import type { GalleryItem } from './items';
import { Stage, type StageHandle } from './Stage';
import { useVideoUrl } from './useVideoUrl';

export interface GalleryPost { row: PostRow; payload: PostPayload }

const WIDE = '(min-width: 1024px)';
function useWide(): boolean {
  return useSyncExternalStore(
    (l) => { const m = matchMedia(WIDE); m.addEventListener('change', l); return () => m.removeEventListener('change', l); },
    () => matchMedia(WIDE).matches,
    () => false,
  );
}

async function saveFile(ref: FileRef, base: string) {
  const bytes = await downloadFile(ref);
  const ext = (ref.mime.split('/')[1] ?? 'bin').replace('quicktime', 'mov').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: ref.mime }));
  const a = document.createElement('a');
  a.href = url; a.download = `${base}.${ext}`; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------------------------

function PhotoView({ item, alt, rtl, handle, onSwipe, onSingleTap, onZoom }: {
  item: Extract<GalleryItem, { kind: 'photo' }>; alt: string; rtl: boolean; handle: React.RefObject<StageHandle | null>;
  onSwipe: (a: 'next' | 'prev' | 'close') => void; onSingleTap: () => void; onZoom: (z: number) => void;
}) {
  // The feed already decrypted "med"; show it at once and swap in "big" when it is ready.
  const med = useFileUrl(item.med);
  const big = useFileUrl(item.big);
  const src = big ?? med;
  return (
    <Stage resetKey={item.key} rtl={rtl} wheel="always" handle={handle} onSwipe={onSwipe} onSingleTap={onSingleTap} onZoom={onZoom} className="kg-stage">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="kg-img" draggable={false} decoding="async" />
      ) : <span className="kg-wait" role="img" aria-label={alt}><Spinner /></span>}
    </Stage>
  );
}

function VideoView({ item, label, autoStart, rtl, onSwipe, onSingleTap }: {
  item: Extract<GalleryItem, { kind: 'video' }>; label: string; autoStart: boolean; rtl: boolean;
  onSwipe: (a: 'next' | 'prev' | 'close') => void; onSingleTap: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const [go, setGo] = useState(autoStart);
  const poster = useFileUrl(item.poster);
  const v = useVideoUrl(item.file, go);
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const ratio = item.w && item.h ? `${item.w} / ${item.h}` : '16 / 9';
  const dur = formatDuration(item.duration);
  if (v.url) {
    return <video className="kg-video" src={v.url} poster={poster ?? undefined} controls playsInline autoPlay aria-label={label} />;
  }
  // Not playing yet: swipes still move between items (no pointer capture, so the play button keeps working).
  const down = (e: RPointerEvent) => { start.current = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  const up = (e: RPointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.hypot(dx, dy) < 8) { if (e.target === e.currentTarget) onSingleTap(); return; }
    const a = swipeAction(dx, dy, performance.now() - s.t, (e.currentTarget as HTMLElement).clientWidth, rtl);
    if (a) onSwipe(a);
  };
  return (
    <div className="kg-video-wait" onPointerDown={down} onPointerUp={up} onPointerCancel={() => { start.current = null; }}>
      <div className="kg-video-poster" style={{ aspectRatio: ratio }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {poster ? <img src={poster} alt="" draggable={false} /> : null}
        {!go ? (
          <button type="button" className="kg-play" onClick={() => setGo(true)}
            aria-label={`${t('feed.playVideo')}${item.title ? `: ${item.title}` : ''}${dur ? ` (${dur})` : ''}`}>
            <span className="k-play" aria-hidden><Icon name="play" /></span>
            <span className="kg-play-meta k-small">{[dur, formatBytes(item.file.bytes, f.number), t('feed.encrypted')].filter(Boolean).join(' · ')}</span>
          </button>
        ) : v.error ? (
          <p className="kg-video-status" role="alert">
            <Icon name="alert" /> {t('feed.videoError')}{' '}
            <button type="button" className="k-linkbtn" onClick={() => { setGo(false); setTimeout(() => setGo(true), 0); }}>{t('feed.retry')}</button>
          </p>
        ) : (
          <p className="kg-video-status" role="status">
            <Spinner /> {v.progress < 1 ? t('feed.downloading', { pct: Math.round(v.progress * 100) }) : t('feed.decrypting')}
          </p>
        )}
      </div>
    </div>
  );
}

function Thumb({ item, label, active, onClick }: { item: GalleryItem; label: string; active: boolean; onClick: () => void }) {
  // Small files only: the photo's "thumb" (or the chat photo itself, already small) and the video's poster.
  const url = useFileUrl(item.kind === 'photo' ? (item.thumb ?? item.med ?? item.big) : item.poster);
  return (
    <button type="button" className="kg-thumb" aria-label={label} aria-current={active ? 'true' : undefined} onClick={onClick}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url ? <img src={url} alt="" draggable={false} loading="lazy" /> : <span className="k-media-ph" />}
      {item.kind === 'video' ? <span className="kg-thumb-play" aria-hidden><Icon name="play" /></span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------

function PostPanel({ post, focusSignal, onComment, onNavigate }: {
  post: GalleryPost; focusSignal: number; onComment: () => void; onNavigate: () => void;
}) {
  const t = useT();
  const { userId } = useSession();
  usePeopleVersion();
  const author = usePerson(post.row.author_id);
  const avatar = useFileUrl(author?.info?.avatar?.thumb);
  const like = usePostLike(post.row);
  const comments = useComments(post.row.id);
  const n = comments.data?.length ?? 0;
  const name = author?.name ?? '…';
  const text = [post.payload.text, post.payload.sharedText].filter(Boolean).join('\n\n');
  return (
    <aside className="kg-panel" aria-label={t('gallery.post')}>
      <header className="kg-panel-head">
        <Avatar name={name} src={avatar} size={40} />
        <div className="kg-panel-who">
          {author ? <Link href={`/u/${author.username}`} className="k-post-name" onClick={onNavigate}>{name}</Link> : <span className="k-post-name">{name}</span>}
          <span className="k-post-meta"><RelativeTime iso={post.row.created_at} /></span>
        </div>
      </header>
      {text ? <RichText text={text} clamp={500} className="kg-panel-text" /> : null}
      <div className="k-post-actions">
        <button type="button" className="k-action" aria-pressed={like.liked} data-on={like.liked ? '' : undefined} onClick={() => void like.toggle()}>
          <Icon name="heart" /><span>{like.liked ? t('feed.liked') : t('feed.like')}</span>
        </button>
        <button type="button" className="k-action" onClick={onComment}>
          <Icon name="comment" /><span>{n ? t('feed.commentCount', { count: n }) : t('feed.comment')}</span>
        </button>
        {post.row.author_id === userId && like.count > 0 ? (
          <span className="k-post-likes k-small k-muted" title={t('feed.likeCountPrivate')}><Icon name="lock" /> {t('feed.likeCount', { count: like.count })}</span>
        ) : null}
      </div>
      <Comments post={post.row} contentKey={postContentKey(post.row)} focusSignal={focusSignal} />
    </aside>
  );
}

/** Phone: caption + like / comment over the bottom of the media (shown and hidden with a tap). */
function PhoneBar({ post, caption, onComments }: { post: GalleryPost | null; caption: string; onComments: () => void }) {
  return (
    <div className="kg-bottom">
      {caption ? <p className="kg-caption" dir="auto">{caption}</p> : null}
      {post ? <PhoneActions post={post} onComments={onComments} /> : null}
    </div>
  );
}

function PhoneActions({ post, onComments }: { post: GalleryPost; onComments: () => void }) {
  const t = useT();
  const like = usePostLike(post.row);
  const comments = useComments(post.row.id);
  const n = comments.data?.length ?? 0;
  return (
    <div className="kg-actions">
      <button type="button" className="kg-action" aria-pressed={like.liked} data-on={like.liked ? '' : undefined} onClick={() => void like.toggle()}>
        <Icon name="heart" /><span>{like.liked ? t('feed.liked') : t('feed.like')}</span>
      </button>
      <button type="button" className="kg-action" onClick={onComments}>
        <Icon name="comment" /><span>{n ? t('feed.commentCount', { count: n }) : t('feed.comment')}</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export default function Gallery({ items, start, post = null, onClose }: {
  items: GalleryItem[]; start: number; post?: GalleryPost | null; onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { dir } = useLocale();
  const rtl = dir === 'rtl';
  const wide = useWide();
  const { userId } = useSession();
  const author = usePerson(post?.row.author_id);
  const n = items.length;
  const [first] = useState(() => Math.max(0, Math.min(n - 1, start)));
  const [i, setI] = useState(first);
  const [ui, setUi] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [sheet, setSheet] = useState(false);
  const [focus, setFocus] = useState(0);
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const stage = useRef<StageHandle>(null);
  const closeCb = useRef(onClose);
  useEffect(() => { closeCb.current = onClose; });
  const hist = useRef<{ token: string; pushed: boolean }>({ token: '', pushed: false });

  const item = items[i]!;
  const go = (delta: number) => setI((x) => Math.max(0, Math.min(n - 1, x + delta)));

  // Close: through history when we added an entry (so Back and the close button behave the same).
  const close = () => {
    const h = hist.current;
    const st = history.state as { kwGallery?: string } | null;
    if (h.pushed && st?.kwGallery === h.token) { h.pushed = false; history.back(); } else closeCb.current();
  };
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });

  useEffect(() => {
    const d = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    if (d && !d.open) d.showModal();
    const root = document.documentElement;
    const prevOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    const token = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try {
      history.pushState({ ...((history.state as object | null) ?? {}), kwGallery: token }, '');
      hist.current = { token, pushed: true };
    } catch { hist.current = { token, pushed: false }; }
    const onPop = () => {
      const st = history.state as { kwGallery?: string } | null;
      if (st?.kwGallery !== token) { hist.current.pushed = false; closeCb.current(); }
    };
    addEventListener('popstate', onPop);
    return () => {
      removeEventListener('popstate', onPop);
      root.style.overflow = prevOverflow;
      opener?.focus?.({ preventScroll: true });
    };
  }, []);

  // Prefetch the neighbours' full-size photos into the shared object-URL cache.
  useEffect(() => {
    for (const j of [i + 1, i - 1]) {
      const it = items[j];
      if (it?.kind === 'photo') void fileUrl(it.big).catch(() => undefined);
    }
  }, [i, items]);

  const onKey = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest('textarea, input, select, [contenteditable="true"], .k-dialog')) return;
    const fwd = rtl ? -1 : 1;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(fwd); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-fwd); }
    else if (e.key === 'Home') { e.preventDefault(); setI(0); }
    else if (e.key === 'End') { e.preventDefault(); setI(n - 1); }
    else if ((e.key === '+' || e.key === '=') && item.kind === 'photo') { e.preventDefault(); stage.current?.zoomBy(1.5); }
    else if (e.key === '-' && item.kind === 'photo') { e.preventDefault(); stage.current?.zoomBy(1 / 1.5); }
    else if (e.key === '0' && item.kind === 'photo') { e.preventDefault(); stage.current?.reset(); }
  };
  const onSwipe = (a: 'next' | 'prev' | 'close') => (a === 'close' ? close() : go(a === 'next' ? 1 : -1));
  const toggleUi = () => setUi((x) => !x);

  const itemLabel = (it: GalleryItem, j: number) => (it.kind === 'video'
    ? t('gallery.videoN', { n: j + 1, total: n })
    : it.caption || t('feed.photoAlt', { n: j + 1, total: n }));
  const caption = item.kind === 'photo' ? item.caption ?? '' : item.title ?? '';
  const phoneCaption = caption || (post && !wide ? [post.payload.text, post.payload.sharedText].filter(Boolean).join('\n\n') : '');

  const download = async () => {
    setBusy(true);
    try {
      if (item.kind === 'photo' && item.files) await downloadPhoto(item.files, `kithwall-${i + 1}`);
      else await saveFile(item.kind === 'photo' ? item.big : item.file, `kithwall-${i + 1}`);
    } catch { toast({ message: t('gallery.downloadFailed'), tone: 'danger' }); }
    setBusy(false);
  };
  const share = async () => {
    if (!post) return;
    const url = `${location.origin}/post/${post.row.id}`;
    if (typeof navigator.share === 'function') {
      try { await navigator.share({ url }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast({ message: t('gallery.linkCopied') }); }
    catch { toast({ message: t('feed.failed'), tone: 'danger' }); }
  };
  const comment = () => { if (wide) setFocus((x) => x + 1); else setSheet(true); };

  const panel = !!post && wide;
  const label = post && author ? t('gallery.labelFrom', { name: author.name }) : t('gallery.label');
  const contentKey = useMemo(() => (post ? postContentKey(post.row) : null), [post]);

  return (
    <dialog ref={ref} className="kg" aria-label={label} data-panel={panel ? '' : undefined} data-ui={ui ? undefined : 'off'}
      onKeyDown={onKey} onCancel={(e) => { e.preventDefault(); close(); }}>
      <div className="kg-media">
        <div className="kg-top">
          <IconButton icon="close" label={t('common.close')} onClick={close} />
          {n > 1 ? <span className="kg-count" aria-live="polite">{t('feed.photoPosition', { n: i + 1, total: n })}</span> : null}
          <span className="k-spacer" />
          {wide && item.kind === 'photo' ? (
            <>
              <IconButton icon="search" label={t('gallery.zoomIn')} onClick={() => stage.current?.zoomBy(1.5)} disabled={zoom >= 4} />
              <IconButton icon="refresh" label={t('gallery.resetZoom')} onClick={() => stage.current?.reset()} disabled={zoom <= 1} />
            </>
          ) : null}
          <IconButton icon="download" label={t('gallery.download')} onClick={() => void download()} disabled={busy} />
          {post ? <IconButton icon="share" label={t('gallery.share')} onClick={() => void share()} /> : null}
          {post && post.row.author_id !== userId ? <IconButton icon="flag" label={t('feed.report')} onClick={() => setReporting(true)} /> : null}
        </div>

        <div className="kg-main">
          {item.kind === 'photo'
            ? <PhotoView key={item.key} item={item} alt={itemLabel(item, i)} rtl={rtl} handle={stage} onSwipe={onSwipe} onSingleTap={toggleUi} onZoom={setZoom} />
            : <VideoView key={item.key} item={item} label={itemLabel(item, i)} autoStart={i === first} rtl={rtl} onSwipe={onSwipe} onSingleTap={toggleUi} />}
          {n > 1 && i > 0 ? <button type="button" className="kg-nav kg-prev" aria-label={t('gallery.previous')} onClick={() => go(-1)}><Icon name="back" /></button> : null}
          {n > 1 && i < n - 1 ? <button type="button" className="kg-nav kg-next" aria-label={t('gallery.next')} onClick={() => go(1)}><Icon name="forward" /></button> : null}
        </div>

        {wide ? (
          <>
            {caption ? <p className="kg-caption kg-caption-wide" dir="auto">{caption}</p> : null}
            {n > 1 ? (
              <div className="kg-thumbs" role="group" aria-label={t('gallery.all')}>
                {items.map((it, j) => <Thumb key={it.key} item={it} label={itemLabel(it, j)} active={j === i} onClick={() => setI(j)} />)}
              </div>
            ) : null}
          </>
        ) : (phoneCaption || post) ? <PhoneBar post={post} caption={phoneCaption} onComments={comment} /> : null}
      </div>

      {panel && post ? <PostPanel post={post} focusSignal={focus} onComment={comment} onNavigate={() => { hist.current.pushed = false; closeCb.current(); }} /> : null}

      {post && !wide ? (
        <Dialog open={sheet} onClose={() => setSheet(false)} title={t('gallery.comments')} sheet className="kg-sheet">
          <Comments post={post.row} contentKey={contentKey} focusSignal={0} />
        </Dialog>
      ) : null}
      {post ? (
        <ReportDialog open={reporting} onClose={() => setReporting(false)} kind="post" id={post.row.id}
          disclosure={() => ({ plaintext: post.payload, contentKey: postContentKey(post.row), keyKind: 'content' })} />
      ) : null}
      <span className="k-sr-only" aria-live="polite">{ui ? '' : t('gallery.controlsHidden')}</span>
    </dialog>
  );
}
