'use client';
// Encrypted photos, videos and link cards inside a chat bubble. Everything is downloaded from our own
// storage and decrypted on this device into blob: URLs; nothing is fetched from the linked site.
import { useEffect, useRef, useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { downloadFile, fileUrl, useFileUrl } from '@/lib/media';
import type { FileRef } from '@/lib/types';
import type { ChatPayload } from '@/lib/messages';
import { Spinner } from '@/components/ui/Spinner';
import { Dialog } from '@/components/ui/Dialog';
import { cx } from '@/components/ui/cx';
import { ChatIcon } from './ChatIcon';
import { safeHref } from './chatModel';

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

function Photo({ file, onOpen }: { file: FileRef; onOpen: (url: string) => void }) {
  const t = useT();
  const { url, failed } = usePhotoUrl(file);
  const ratio = file.w && file.h ? `${file.w} / ${file.h}` : '4 / 3';
  if (failed) return <span className="k-chat-photo is-failed" style={{ aspectRatio: ratio }}>{t('messages.media.unavailable')}</span>;
  if (!url) return <span className="k-chat-photo is-loading" style={{ aspectRatio: ratio }} role="img" aria-label={t('messages.media.loading')}><Spinner /></span>;
  return (
    <button type="button" className="k-chat-photo" style={{ aspectRatio: ratio }} onClick={() => onOpen(url)} aria-label={t('messages.media.openPhoto')}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" width={file.w} height={file.h} />
    </button>
  );
}

function Video({ file }: { file: FileRef }) {
  const t = useT();
  const f = useFormat();
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [progress, setProgress] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => { abort.current?.abort(); if (url) URL.revokeObjectURL(url); }, [url]);
  async function load() {
    setState('loading');
    const ac = new AbortController();
    abort.current = ac;
    try {
      const bytes = await downloadFile(file, { signal: ac.signal, onProgress: (a, b) => setProgress(b ? a / b : 0) });
      setUrl(URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.mime })));
      setState('ready');
    } catch { if (!ac.signal.aborted) setState('failed'); }
  }
  const ratio = file.w && file.h ? `${file.w} / ${file.h}` : '16 / 9';
  if (state === 'ready' && url) {
    return <video className="k-chat-video" style={{ aspectRatio: ratio }} src={url} controls autoPlay playsInline />;
  }
  const mb = f.number(file.bytes / 1048576, { maximumFractionDigits: 1 });
  return (
    <button type="button" className={cx('k-chat-video k-chat-video-tile', state === 'failed' && 'is-failed')} style={{ aspectRatio: ratio }}
      onClick={() => void load()} disabled={state === 'loading'}>
      <span className="k-chat-video-play" aria-hidden>{state === 'loading' ? <Spinner /> : <ChatIcon name="play" />}</span>
      <span className="k-chat-video-meta">
        {state === 'loading' ? t('messages.media.decrypting', { percent: Math.round(progress * 100) })
          : state === 'failed' ? t('messages.media.videoFailed') : t('messages.media.playVideo', { size: mb })}
      </span>
    </button>
  );
}

export function ChatAttachments({ files }: { files: FileRef[] }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const valid = files.filter(validRef).slice(0, 6);
  if (!valid.length) return null;
  const photos = valid.filter((x) => x.mime.startsWith('image/'));
  const videos = valid.filter((x) => x.mime.startsWith('video/'));
  return (
    <div className="k-chat-media">
      {photos.length ? (
        <div className="k-chat-photos" data-count={Math.min(photos.length, 4)}>
          {photos.map((p) => <Photo key={p.path} file={p} onOpen={setOpen} />)}
        </div>
      ) : null}
      {videos.map((v) => <Video key={v.path} file={v} />)}
      <Dialog open={!!open} onClose={() => setOpen(null)} title={t('messages.media.photo')} className="k-chat-lightbox">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {open ? <img src={open} alt="" /> : null}
      </Dialog>
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
  return (
    <a className="k-chat-link" href={href} target="_blank" rel="noopener noreferrer nofollow">
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img} alt="" className="k-chat-link-img" />
      ) : null}
      <span className="k-chat-link-body">
        <span className="k-chat-link-site" dir="ltr">{typeof link.site === 'string' && link.site ? link.site : host}</span>
        {title ? <span className="k-chat-link-title">{title}</span> : null}
        {desc ? <span className="k-chat-link-desc">{desc}</span> : null}
      </span>
    </a>
  );
}
