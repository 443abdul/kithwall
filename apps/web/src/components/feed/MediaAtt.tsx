'use client';
// Rich media attachments for stories and the publisher:
//   LinkCardView  – Facebook-style link preview (wide image on top, or a square thumbnail on the left)
//   EmbedView     – click-to-play facade for YouTube / Vimeo / Dailymotion / Streamable / TikTok.
//                   Nothing is loaded from the provider until the viewer presses play; the thumbnail
//                   is our own encrypted copy (fetched through the preview proxy when posting).
//   VideoAtt      – an encrypted uploaded video: poster → download (progress) → decrypt → <video>.
// Desktop keeps the 2010 attachment look (.att .th .ad .at, .vid); phones get modern full-bleed
// cards (styles/feed-media.css, colours from the mobile CSS variables).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { safeHref } from '@/components/social/bits';
import { downloadFile, useFileUrl } from '@/lib/media';
import { EMBED_PROVIDERS, embedSrc, validEmbed, type Embed } from '@/lib/embeds';
import { displayHost } from '@/lib/feed/linkMeta';
import { isWide } from '@/lib/feed/linkPreview';
import type { PostPayload } from '@/lib/types';
import '@/styles/feed-media.css';

const REL = 'noopener noreferrer nofollow';

export interface LinkCardViewProps {
  url: string;
  title?: string;
  description?: string;
  site?: string;
  /** Decrypted (or locally prepared) image URL; `null` while loading. */
  img?: string | null;
  hasImage?: boolean;
  imgW?: number;
  imgH?: number;
  onRemove?: () => void;
  className?: string;
}

/** The whole card is one external link. */
export function LinkCardView({ url, title, description, site, img, hasImage, imgW, imgH, onRemove, className }: LinkCardViewProps) {
  const href = safeHref(url);
  const host = displayHost(url) || site || '';
  const wide = isWide(imgW, imgH);
  const showImg = hasImage ?? !!img;
  const body: ReactNode = (
    <>
      {showImg && (
        <span className={`th kw-lc-img${wide ? '' : ' sq'}`} style={wide && imgW && imgH ? { aspectRatio: `${imgW} / ${imgH}` } : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {img ? <img src={img} alt="" width={wide ? imgW : 90} height={wide ? imgH : 90} loading="lazy" decoding="async" /> : <span className="kw-ph" />}
        </span>
      )}
      <span className="ad kw-lc-txt">
        <span className="at kw-lc-t">{title || url}</span>
        <span className="kw-lc-site">{host}</span>
        {description ? <span className="kw-lc-d">{description}</span> : null}
      </span>
    </>
  );
  return (
    <div className={`att kw-lc ${wide && showImg ? 'wide' : 'side'}${onRemove ? ' kw-lc-draft' : ''}${className ? ` ${className}` : ''}`}>
      {href
        ? <a className="kw-lc-a" href={href} target="_blank" rel={REL}>{body}</a>
        : <span className="kw-lc-a">{body}</span>}
      {onRemove && <button type="button" className="kw-lc-x" aria-label="Remove link preview" title="Remove" onClick={onRemove}>&times;</button>}
    </div>
  );
}

/** Link attachment in a story: decrypts the preview image, plays known video providers in place. */
export function LinkAttachment({ link }: { link: NonNullable<PostPayload['link']> }) {
  const img = useFileUrl(link.image);
  const embed = validEmbed(link.embed);
  if (embed) {
    return <EmbedView embed={embed} url={link.url} title={link.title} description={link.description} img={img} hasImage={!!link.image} />;
  }
  return (
    <LinkCardView url={link.url} title={link.title} description={link.description} site={link.site}
      img={img} hasImage={!!link.image} imgW={link.image?.w} imgH={link.image?.h} />
  );
}

// ---------------------------------------------------------------------------------------
// Click-to-play embeds

function PlayIcon() {
  return (
    <span className="kw-play" aria-hidden="true">
      <svg className="kw-pi" viewBox="0 0 24 24" width="24" height="24" focusable="false"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
    </span>
  );
}

export interface EmbedViewProps {
  embed: Embed;
  url: string;
  title?: string;
  description?: string;
  img?: string | null;
  hasImage?: boolean;
  /** Publisher preview: show the facade only (no playing), with a remove button. */
  onRemove?: () => void;
}

export function EmbedView({ embed, url, title, description, img, hasImage = !!img, onRemove }: EmbedViewProps) {
  const [playing, setPlaying] = useState(false);
  const prov = EMBED_PROVIDERS[embed.provider];
  const src = embedSrc(embed);
  const href = safeHref(url);
  const tall = embed.aspect === '9:16';
  const label = `Play video${title ? `: ${title}` : ''} (plays from ${prov.host})`;
  return (
    <div className={`att kw-emb${tall ? ' tall' : ''}${onRemove ? ' kw-lc-draft' : ''}`}>
      <div className="kw-emb-stage"><div className="kw-emb-box">
        {playing && src ? (
          <iframe
            className="kw-emb-frame"
            src={src}
            title={title ? `${prov.name}: ${title}` : `${prov.name} video`}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
          />
        ) : (
          <button type="button" className="kw-emb-face" aria-label={label} disabled={!!onRemove || !src}
            onClick={() => setPlaying(true)}>
            {hasImage && (img
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={img} alt="" decoding="async" />
              : <span className="kw-ph" />)}
            <PlayIcon />
            <span className="kw-emb-prov">{prov.name}</span>
          </button>
        )}
      </div></div>
      <div className="ad kw-emb-txt">
        {href ? <a className="at kw-lc-t" href={href} target="_blank" rel={REL}>{title || url}</a> : <span className="at kw-lc-t">{title || url}</span>}
        <span className="kw-lc-site">{playing ? <>Playing from {prov.host}</> : prov.host}</span>
        {description && !playing ? <span className="kw-lc-d">{description}</span> : null}
      </div>
      {onRemove && <button type="button" className="kw-lc-x" aria-label="Remove link preview" title="Remove" onClick={onRemove}>&times;</button>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Uploaded (encrypted) videos

export function formatDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

const EXT: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

type VState =
  | { s: 'idle' }
  | { s: 'loading'; pct: number; phase: 'download' | 'decrypt' }
  | { s: 'ready'; url: string }
  | { s: 'error'; msg: string; url?: string };

export function VideoAtt({ video }: { video: NonNullable<PostPayload['video']> }) {
  const poster = useFileUrl(video.poster);
  const [st, setSt] = useState<VState>({ s: 'idle' });
  const owned = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const w = video.w ?? video.poster?.w;
  const h = video.h ?? video.poster?.h;
  const tall = !!w && !!h && h > w;
  const dur = formatDuration(video.duration);
  const mime = /^video\/(mp4|webm|quicktime)$/.test(video.file.mime) ? video.file.mime : 'video/mp4';

  useEffect(() => () => {
    abort.current?.abort();
    if (owned.current) URL.revokeObjectURL(owned.current);
    owned.current = null;
  }, []);

  const play = async () => {
    if (st.s === 'loading') return;
    const ac = new AbortController();
    abort.current = ac;
    setSt({ s: 'loading', pct: 0, phase: 'download' });
    try {
      let last = 0;
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
      if ((e as Error).name === 'AbortError') return;
      setSt({ s: 'error', msg: (e as Error).message || 'This video couldn’t be loaded.' });
    }
  };

  const cancel = () => { abort.current?.abort(); setSt({ s: 'idle' }); };
  const ratio = w && h ? `${w} / ${h}` : '16 / 9';

  return (
    <div className={`att kw-video${tall ? ' tall' : ''}`}>
      {st.s === 'ready' ? (
        <video className="kw-video-el" src={st.url} controls playsInline autoPlay preload="auto" style={{ aspectRatio: ratio }}
          onError={() => setSt({ s: 'error', msg: 'This video’s format can’t be played in this browser.', url: st.url })} />
      ) : (
        <button type="button" className="vid kw-vposter" style={{ aspectRatio: ratio }} onClick={() => void play()}
          aria-label={`Play video${video.title ? `: ${video.title}` : ''}${dur ? ` (${dur})` : ''}`} disabled={st.s === 'loading'}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {poster ? <img src={poster} alt="" decoding="async" /> : <span className="kw-ph" />}
          {st.s !== 'loading' && <PlayIcon />}
          {dur && st.s !== 'loading' ? <span className="kw-dur">{dur}</span> : null}
          {st.s === 'loading' && (
            <span className="kw-vprog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={st.pct}
              aria-label={st.phase === 'download' ? 'Downloading video' : 'Decrypting video'}>
              <span className="kw-vprog-l">{st.phase === 'download' ? `Downloading… ${st.pct}%` : 'Decrypting…'}</span>
              <span className="kw-vprog-bar"><span style={{ width: `${st.pct}%` }} /></span>
            </span>
          )}
        </button>
      )}
      {st.s === 'loading' && st.phase === 'download' && (
        <div className="kw-video-note"><a role="button" tabIndex={0} onClick={cancel} onKeyDown={(e) => { if (e.key === 'Enter') cancel(); }}>Cancel</a></div>
      )}
      {st.s === 'error' && (
        <div className="kw-video-note err" role="alert">
          {st.msg}{' '}
          {st.url
            ? <a href={st.url} download={`video.${EXT[mime] ?? 'mp4'}`}>Download</a>
            : <a role="button" tabIndex={0} onClick={() => void play()} onKeyDown={(e) => { if (e.key === 'Enter') void play(); }}>Try again</a>}
        </div>
      )}
      {(video.title || st.s === 'idle') && (
        <div className="ad kw-video-txt">
          {video.title ? <span className="at kw-lc-t">{video.title}</span> : null}
          {st.s === 'idle' ? <span className="kw-lc-site">{[dur, formatBytes(video.file.bytes), 'encrypted'].filter(Boolean).join(' · ')}</span> : null}
        </div>
      )}
    </div>
  );
}
