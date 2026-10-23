'use client';
// Encrypted photos, videos and link cards inside a chat bubble. Everything is downloaded from our own
// storage and decrypted on this device into blob: URLs; nothing is fetched from the linked site. A tap on a
// photo or video opens the pop-out gallery (components/gallery) with all the media of that message.
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { fileUrl, useFileUrl } from '@/lib/media';
import type { FileRef } from '@/lib/types';
import type { ChatPayload } from '@/lib/messages';
import { Spinner } from '@/components/ui/Spinner';
import { chatItems } from '@/components/gallery/items';
import { ChatIcon } from './ChatIcon';
import { safeHref } from './chatModel';
import { ExternalLink } from '@/components/links/ExternalLink';

const Gallery = dynamic(() => import('@/components/gallery/Gallery'), { ssr: false });

const RETRY = [700, 1500, 3000, 6000];
const PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}(-[a-z0-9]+)?$/;
const validRef = (f: FileRef | undefined | null): f is FileRef => !!f && typeof f.path === 'string' && PATH_RE.test(f.path) && typeof f.key === 'string' && typeof f.mime === 'string';

/** Decrypted object URL for a photo, retrying while the sender is still linking it to the message. */
function usePhotoUrl(file: FileRef): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ path: string; url: string | null; failed: boolean }>({ path: file.path, url: null, failed: false });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      fileUrl(file).then((u) => { if (live) setState({ path: file.path, url: u, failed: false }); }).catch(() => {
        if (!live) return;
        if (n < RETRY.length) timer = setTimeout(() => attempt(n + 1), RETRY[n]);
        else setState({ path: file.path, url: null, failed: true });
      });
    };
    attempt(0);
    return () => { live = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);
  return state.path === file.path ? state : { url: null, failed: false };
}

function Photo({ file, onOpen }: { file: FileRef; onOpen: () => void }) {
  const t = useT();
  const { url, failed } = usePhotoUrl(file);
  const ratio = file.w && file.h ? `${file.w} / ${file.h}` : '4 / 3';
  if (failed) return <span className="k-chat-photo is-failed" style={{ aspectRatio: ratio }}>{t('messages.media.unavailable')}</span>;
  if (!url) return <span className="k-chat-photo is-loading" style={{ aspectRatio: ratio }} role="img" aria-label={t('messages.media.loading')}><Spinner /></span>;
  return (
    <button type="button" className="k-chat-photo" style={{ aspectRatio: ratio }} onClick={onOpen} aria-label={t('messages.media.openPhoto')}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" width={file.w} height={file.h} />
    </button>
  );
}

/** A video tile: a tap opens the gallery, which downloads, decrypts and plays it full screen. */
function Video({ file, onOpen }: { file: FileRef; onOpen: () => void }) {
  const t = useT();
  const f = useFormat();
  const ratio = file.w && file.h ? `${file.w} / ${file.h}` : '16 / 9';
  const mb = f.number(file.bytes / 1048576, { maximumFractionDigits: 1 });
  return (
    <button type="button" className="k-chat-video k-chat-video-tile" style={{ aspectRatio: ratio }} onClick={onOpen}>
      <span className="k-chat-video-play" aria-hidden><ChatIcon name="play" /></span>
      <span className="k-chat-video-meta">{t('messages.media.playVideo', { size: mb })}</span>
    </button>
  );
}

export function ChatAttachments({ files }: { files: FileRef[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const valid = files.filter(validRef).slice(0, 6);
  const photos = valid.filter((x) => x.mime.startsWith('image/'));
  const videos = valid.filter((x) => x.mime.startsWith('video/'));
  // Same order as shown: photos, then videos. The gallery renders nothing until opened.
  const items = useMemo(() => chatItems([...photos, ...videos]), [files]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!valid.length) return null;
  return (
    <div className="k-chat-media">
      {photos.length ? (
        <div className="k-chat-photos" data-count={Math.min(photos.length, 4)}>
          {photos.map((p, i) => <Photo key={p.path} file={p} onOpen={() => setOpen(i)} />)}
        </div>
      ) : null}
      {videos.map((v, i) => <Video key={v.path} file={v} onOpen={() => setOpen(photos.length + i)} />)}
      {open !== null ? <Gallery items={items} start={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

export function LinkCard({ link }: { link: NonNullable<ChatPayload['link']> }) {
  const href = typeof link.url === 'string' ? safeHref(link.url) : null;
  const img = useFileUrl(validRef(link.image) ? link.image : null);
  if (!href) return null;
  let host = '';
  try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
  const title = typeof link.title === 'string' ? link.title : '';
  const desc = typeof link.description === 'string' ? link.description : '';
  // The true hostname is always shown; the name the page gives itself is only a hint next to it.
  const site = typeof link.site === 'string' && link.site && link.site.toLowerCase() !== host.toLowerCase() ? link.site : '';
  return (
    <ExternalLink className="k-chat-link" href={href} text={title}>
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img} alt="" className="k-chat-link-img" />
      ) : null}
      <span className="k-chat-link-body">
        <span className="k-chat-link-site"><span dir="ltr" translate="no">{host}</span>{site ? <span className="k-muted" dir="auto"> · {site}</span> : null}</span>
        {title ? <span className="k-chat-link-title" dir="auto">{title}</span> : null}
        {desc ? <span className="k-chat-link-desc" dir="auto">{desc}</span> : null}
      </span>
    </ExternalLink>
  );
}
