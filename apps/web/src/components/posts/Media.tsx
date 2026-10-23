'use client';
// Post media: photo grid, the lightbox (profile photos; posts use components/gallery), the encrypted video
// player, link preview cards and click-to-play embeds. Every image is decrypted on this device into a
// blob: URL (lib/media useFileUrl); embeds load nothing from the provider until the viewer presses play.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useFormat, useLocale, useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Button, IconButton } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { downloadFile, useFileUrl } from '@/lib/media';
import { EMBED_PROVIDERS, embedSrc, validEmbed, type Embed } from '@/lib/embeds';
import { displayHost } from '@/lib/feed/linkMeta';
import { isWide } from '@/lib/feed/linkPreview';
import type { FileRef, PhotoFiles, PostPayload } from '@/lib/types';
import { formatBytes, formatDuration } from './bits';
import { ExternalLink } from '@/components/links/ExternalLink';
import { isolate } from '@/lib/links/leave';
import { gridLayout, safeHref, stepIndex } from './logic';

type Photo = NonNullable<PostPayload['photos']>[number];

function DecryptedImg({ file, alt, className, eager }: { file: FileRef | undefined; alt: string; className?: string; eager?: boolean }) {
  const url = useFileUrl(file);
  return url
    // eslint-disable-next-line @next/next/no-img-element
    ? <img className={className} src={url} alt={alt} width={file?.w} height={file?.h} decoding="async" loading={eager ? 'eager' : 'lazy'} draggable={false} />
    : <span className={`k-media-ph${className ? ` ${className}` : ''}`} role="img" aria-label={alt}><Spinner size={20} /></span>;
}

export function PhotoGrid({ photos, onOpen }: { photos: Photo[]; onOpen: (i: number) => void }) {
  const t = useT();
  const { shown, more, layout } = gridLayout(photos.length);
  const single = photos.length === 1 ? photos[0]!.files.med : null;
  return (
    <div className="k-pgrid" data-layout={layout}>
      {photos.slice(0, shown).map((p, i) => {
        const alt = p.caption || t('feed.photoAlt', { n: i + 1, total: photos.length });
        const last = i === shown - 1 && more > 0;
        return (
          <button key={p.id} type="button" className="k-pgrid-cell" onClick={() => onOpen(i)}
            style={single?.w && single.h ? { aspectRatio: `${Math.max(single.w / single.h, 0.6)}` } : undefined}
            aria-label={last ? `${alt}. ${t('feed.morePhotos', { count: more })}` : alt}>
            <DecryptedImg file={p.files.med} alt="" />
            {last ? <span className="k-pgrid-more" aria-hidden>+{more}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Lightbox

export function Lightbox({ photos, index, onClose }: { photos: { files: PhotoFiles; caption?: string }[]; index: number; onClose: () => void }) {
  const t = useT();
  const { dir } = useLocale();
  const ref = useRef<HTMLDialogElement>(null);
  const [i, setI] = useState(index);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; pinch0?: number; zoom0: number; pan0: { x: number; y: number } } | null>(null);
  const lastTap = useRef(0);
  const n = photos.length;
  const p = photos[i]!;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    document.documentElement.style.overflow = 'hidden';
    return () => { document.documentElement.style.overflow = ''; };
  }, []);

  const go = (delta: number) => { setI((x) => stepIndex(x, delta, n)); setZoom(1); setPan({ x: 0, y: 0 }); };
  // "Next" follows the reading direction: in RTL the next photo is to the left.
  const fwd = dir === 'rtl' ? -1 : 1;

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(fwd); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-fwd); }
  }

  function down(e: RPointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      gesture.current = { startX: 0, startY: 0, pinch0: Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y), zoom0: zoom, pan0: pan };
    } else {
      gesture.current = { startX: e.clientX, startY: e.clientY, zoom0: zoom, pan0: pan };
    }
  }
  function move(e: RPointerEvent) {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (pts.length === 2 && g.pinch0) {
      const d = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      setZoom(Math.min(4, Math.max(1, g.zoom0 * (d / g.pinch0))));
    } else if (zoom > 1) {
      setPan({ x: g.pan0.x + (e.clientX - g.startX), y: g.pan0.y + (e.clientY - g.startY) });
    } else {
      setDrag(e.clientX - g.startX);
    }
  }
  function up(e: RPointerEvent) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    setDrag(0);
    if (g.pinch0) { if (zoom <= 1.05) { setZoom(1); setPan({ x: 0, y: 0 }); } return; }
    if (zoom > 1) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) { go(dx < 0 ? fwd : -fwd); return; }
    if (dy > 110 && Math.abs(dy) > Math.abs(dx)) { onClose(); return; }
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
      const now = Date.now();
      if (now - lastTap.current < 300) { setZoom(zoom > 1 ? 1 : 2.5); setPan({ x: 0, y: 0 }); lastTap.current = 0; }
      else lastTap.current = now;
    }
  }

  const transform = zoom > 1 ? `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` : drag ? `translateX(${drag}px)` : undefined;
  return (
    <dialog ref={ref} className="k-lightbox" aria-label={t('feed.viewer')} onKeyDown={onKey}
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="k-lightbox-bar">
        <span className="k-lightbox-pos" aria-live="polite">{n > 1 ? t('feed.photoPosition', { n: i + 1, total: n }) : ''}</span>
        <IconButton icon="close" label={t('common.close')} onClick={onClose} />
      </div>
      <div className="k-lightbox-stage" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="k-lightbox-img" style={transform ? { transform } : undefined} data-zoomed={zoom > 1 ? '' : undefined}>
          <DecryptedImg file={p.files.big} alt={p.caption || t('feed.photoAlt', { n: i + 1, total: n })} eager />
        </div>
      </div>
      {n > 1 ? (
        <>
          <IconButton className="k-lightbox-prev" icon="back" label={t('feed.prevPhoto')} disabled={i === 0} onClick={() => go(-1)} />
          <IconButton className="k-lightbox-next" icon="forward" label={t('feed.nextPhoto')} disabled={i === n - 1} onClick={() => go(1)} />
        </>
      ) : null}
      {p.caption ? <p className="k-lightbox-cap" dir="auto">{p.caption}</p> : null}
    </dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Link preview card and click-to-play embeds

export function LinkCard({ link, onRemove, localImg }: {
  link: NonNullable<PostPayload['link']>; onRemove?: () => void; localImg?: { url: string; w: number; h: number } | null;
}) {
  const t = useT();
  const decrypted = useFileUrl(localImg ? null : link.image);
  const img = localImg?.url ?? decrypted;
  const w = localImg?.w ?? link.image?.w;
  const h = localImg?.h ?? link.image?.h;
  const has = !!localImg || !!link.image;
  const embed = validEmbed(link.embed);
  if (embed) return <EmbedCard embed={embed} url={link.url} title={link.title} img={img} hasImage={has} onRemove={onRemove} />;
  const href = safeHref(link.url);
  const wide = isWide(w, h);
  const host = displayHost(link.url) || link.site || '';
  const body = (
    <>
      {has ? (
        <span className={wide ? 'k-lc-img k-lc-wide' : 'k-lc-img'} style={wide && w && h ? { aspectRatio: `${w} / ${h}` } : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {img ? <img src={img} alt="" decoding="async" loading="lazy" /> : <span className="k-media-ph" />}
        </span>
      ) : null}
      <span className="k-lc-text">
        <span className="k-lc-host k-ltr">{host}</span>
        <span className="k-lc-title" dir="auto">{link.title || link.url}</span>
        {link.description ? <span className="k-lc-desc" dir="auto">{link.description}</span> : null}
      </span>
    </>
  );
  return (
    <div className={wide && has ? 'k-lc k-lc-col' : 'k-lc'}>
      {href && !onRemove ? <ExternalLink className="k-lc-a" href={href} text={link.title}>{body}</ExternalLink> : <span className="k-lc-a">{body}</span>}
      {onRemove ? <IconButton className="k-lc-x" icon="close" size="sm" variant="soft" label={t('feed.removeLink')} onClick={onRemove} /> : null}
    </div>
  );
}

const EMBED_OK_KEY = 'kw.embeds.ok';
function embedAllowed(p: string): boolean {
  try { return (JSON.parse(localStorage.getItem(EMBED_OK_KEY) ?? '[]') as unknown[]).includes(p); } catch { return false; }
}
function allowEmbed(p: string) {
  try {
    const list = (JSON.parse(localStorage.getItem(EMBED_OK_KEY) ?? '[]') as unknown[]).filter((x) => typeof x === 'string' && x !== p);
    localStorage.setItem(EMBED_OK_KEY, JSON.stringify([...list, p]));
  } catch { /* ask again next time */ }
}

/**
 * Click-to-play: nothing loads from the provider until the viewer agrees. The first tap explains that the
 * player comes from the provider's site, which then sees their IP address ("don't ask again" per provider,
 * on this device). The player iframe is sandboxed to what a video player needs (scripts + its own origin):
 * no popups, no top navigation, no forms; the page CSP only allows these player origins (frame-src).
 */
function EmbedCard({ embed, url, title, img, hasImage, onRemove }: {
  embed: Embed; url: string; title?: string; img: string | null; hasImage: boolean; onRemove?: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<'face' | 'ask' | 'playing'>('face');
  const [remember, setRemember] = useState(false);
  const prov = EMBED_PROVIDERS[embed.provider];
  const src = embedSrc(embed);
  const href = safeHref(url);
  const host = <span className="k-ltr" translate="no">{prov.host}</span>;
  const play = () => {
    if (remember) allowEmbed(embed.provider);
    setState('playing');
  };
  return (
    <div className="k-emb" data-tall={embed.aspect === '9:16' ? '' : undefined}>
      <div className="k-emb-box">
        {state === 'playing' && src ? (
          <iframe className="k-emb-frame" src={src} title={title ? `${prov.name}: ${title}` : prov.name}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin" />
        ) : (
          <button type="button" className="k-emb-face" disabled={!!onRemove || !src || state === 'ask'}
            onClick={() => setState(embedAllowed(embed.provider) ? 'playing' : 'ask')}
            aria-label={t('feed.playFrom', { host: prov.host })}>
            {hasImage ? (img
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={img} alt="" decoding="async" />
              : <span className="k-media-ph" />) : null}
            <span className="k-play" aria-hidden><Icon name="play" /></span>
            <span className="k-emb-prov" aria-hidden>{prov.name}</span>
          </button>
        )}
        {state === 'ask' ? (
          <div className="k-emb-ask" role="group" aria-labelledby={`emb-ask-${embed.provider}-${embed.id}`}>
            <p id={`emb-ask-${embed.provider}-${embed.id}`}>
              <Icon name="globe" /> {t('feed.embedNotice', { host: isolate(prov.host) })}
            </p>
            <label className="k-emb-remember">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>{t('feed.embedRemember', { provider: prov.name })}</span>
            </label>
            <div className="k-emb-ask-row">
              <Button size="sm" variant="ghost" onClick={() => setState('face')}>{t('links.cancel')}</Button>
              <Button size="sm" variant="primary" icon="play" autoFocus onClick={play}>{t('feed.embedPlay')}</Button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="k-emb-text">
        {href && !onRemove ? <ExternalLink className="k-lc-title" href={href} text={title} dir="auto">{title || url}</ExternalLink>
          : <span className="k-lc-title" dir="auto">{title || url}</span>}
        <span className="k-lc-host">{state === 'playing' ? t('feed.playingFrom', { host: prov.host }) : host}</span>
      </div>
      {onRemove ? <IconButton className="k-lc-x" icon="close" size="sm" variant="soft" label={t('feed.removeLink')} onClick={onRemove} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Encrypted video: poster → download with progress → decrypt on device → <video>

type VState =
  | { s: 'idle' }
  | { s: 'loading'; pct: number; phase: 'download' | 'decrypt' }
  | { s: 'ready'; url: string }
  | { s: 'error'; url?: string };

/** `onOpen`: a tap opens the gallery (which plays it full screen) instead of playing here. */
export function VideoPlayer({ video, onOpen }: { video: NonNullable<PostPayload['video']>; onOpen?: () => void }) {
  const t = useT();
  const f = useFormat();
  const poster = useFileUrl(video.poster);
  const [st, setSt] = useState<VState>({ s: 'idle' });
  const owned = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const w = video.w ?? video.poster?.w;
  const h = video.h ?? video.poster?.h;
  const ratio = w && h ? `${w} / ${h}` : '16 / 9';
  const dur = formatDuration(video.duration);
  const mime = /^video\/(mp4|webm|quicktime)$/.test(video.file.mime) ? video.file.mime : 'video/mp4';

  useEffect(() => () => {
    abort.current?.abort();
    if (owned.current) URL.revokeObjectURL(owned.current);
  }, []);

  async function play() {
    if (st.s === 'loading') return;
    const ac = new AbortController();
    abort.current = ac;
    setSt({ s: 'loading', pct: 0, phase: 'download' });
    try {
      let last = -1;
      const plain = await downloadFile(video.file, {
        signal: ac.signal,
        onProgress: (got, total) => {
          const pct = Math.min(100, Math.floor((got / total) * 100));
          if (pct !== last) { last = pct; setSt({ s: 'loading', pct, phase: 'download' }); }
        },
      });
      setSt({ s: 'loading', pct: 100, phase: 'decrypt' });
      const url = URL.createObjectURL(new Blob([plain as BlobPart], { type: mime }));
      if (owned.current) URL.revokeObjectURL(owned.current);
      owned.current = url;
      setSt({ s: 'ready', url });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setSt({ s: 'error' });
    }
  }

  return (
    <div className="k-video" data-tall={w && h && h > w ? '' : undefined}>
      {st.s === 'ready' ? (
        <video className="k-video-el" src={st.url} controls playsInline autoPlay preload="auto" style={{ aspectRatio: ratio }}
          onError={() => setSt({ s: 'error', url: st.url })} />
      ) : (
        <button type="button" className="k-video-poster" style={{ aspectRatio: ratio }} onClick={() => (onOpen ? onOpen() : void play())} disabled={st.s === 'loading'}
          aria-label={`${t('feed.playVideo')}${video.title ? `: ${video.title}` : ''}${dur ? ` (${dur})` : ''}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {poster ? <img src={poster} alt="" decoding="async" /> : <span className="k-media-ph" />}
          {st.s === 'loading' ? (
            <span className="k-video-prog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={st.pct}
              aria-label={st.phase === 'download' ? t('feed.downloading', { pct: st.pct }) : t('feed.decrypting')}>
              <span>{st.phase === 'download' ? t('feed.downloading', { pct: st.pct }) : t('feed.decrypting')}</span>
              <span className="k-progress"><span style={{ inlineSize: `${st.pct}%` }} /></span>
            </span>
          ) : (
            <>
              <span className="k-play" aria-hidden><Icon name="play" /></span>
              {dur ? <span className="k-video-dur k-ltr" aria-hidden>{dur}</span> : null}
            </>
          )}
        </button>
      )}
      {st.s === 'error' ? (
        <p className="k-video-note" role="alert">
          {t('feed.videoError')}{' '}
          {st.url ? <a href={st.url} download="video">{t('feed.videoDownload')}</a>
            : <button type="button" className="k-linkbtn" onClick={() => void play()}>{t('feed.retry')}</button>}
        </p>
      ) : null}
      {video.title || st.s === 'idle' ? (
        <p className="k-video-meta">
          {video.title ? <span className="k-lc-title" dir="auto">{video.title}</span> : null}
          {st.s === 'idle' ? <span className="k-muted k-small">{[dur, formatBytes(video.file.bytes, f.number), t('feed.encrypted')].filter(Boolean).join(' · ')}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
