'use client';
// Publisher "Video" tab: pick a video (≤ 100 MB), read its duration and size with a hidden
// <video>, grab a poster frame (~0.5 s) through a canvas (→ JPEG, no metadata), then encrypt the
// file on this device and upload it in parts (lib/media uploadLargeEncrypted).
import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react';
import { Icon } from '@/components/Icon';
import { fileRefPaths, MAX_VIDEO_BYTES, uploadLargeEncrypted, type ProgressFn } from '@/lib/media';
import { uploadPreparedImage, type PreparedImage } from '@/lib/feed/linkPreview';
import { formatBytes, formatDuration } from './MediaAtt';
import type { PostPayload } from '@/lib/types';
import '@/styles/feed-media.css';

export interface VideoAttachHandle {
  hasFile(): boolean;
  /** Encrypt + upload; returns the payload part and every storage path created. */
  upload(onProgress: ProgressFn): Promise<{ video: NonNullable<PostPayload['video']>; paths: string[] }>;
  clear(): void;
}

interface Probe { duration?: number; w?: number; h?: number; poster?: PreparedImage; playable: boolean }

const TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', qt: 'video/quicktime' };
const ALLOWED = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const POSTER_MAX = 1200;

export function videoMime(f: File): string | null {
  if (ALLOWED.has(f.type)) return f.type;
  const ext = /\.([a-z0-9]{2,4})$/i.exec(f.name)?.[1]?.toLowerCase();
  return ext ? TYPES[ext] ?? null : null;
}

function waitFor(el: HTMLVideoElement, event: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('decode')); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(event, ok); el.removeEventListener('error', bad); };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

/** Read duration/dimensions and grab a poster frame on this device. Never throws. */
async function probeVideo(file: File): Promise<Probe> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  try {
    const meta = waitFor(v, 'loadedmetadata', 15_000);
    v.src = url;
    await meta;
    if (v.duration === Infinity) {
      // WebM files from MediaRecorder carry no duration: seeking far past the end makes the
      // browser scan the file and report the real one.
      try {
        const changed = waitFor(v, 'durationchange', 8_000);
        v.currentTime = 1e9;
        await changed;
        if (v.duration === Infinity) await waitFor(v, 'durationchange', 4_000);
      } catch { /* unknown duration */ }
    }
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : undefined;
    const w = v.videoWidth || undefined;
    const h = v.videoHeight || undefined;
    if (!w || !h) return { duration, playable: false };
    let poster: PreparedImage | undefined;
    try {
      const seeked = waitFor(v, 'seeked', 8_000);
      v.currentTime = Math.min(0.5, (duration ?? 1) / 2);
      await seeked;
      const scale = Math.min(1, POSTER_MAX / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(v, 0, 0, cw, ch);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.84));
        if (blob) poster = { blob, w: cw, h: ch };
      }
    } catch { /* no poster frame */ }
    return { duration, w, h, poster, playable: true };
  } catch {
    return { playable: false };
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

export function VideoAttach({ handleRef, disabled, onChange }:
  { handleRef: RefObject<VideoAttachHandle | null>; disabled?: boolean; onChange?: (has: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const gen = useRef(0);

  useEffect(() => {
    if (!probe?.poster) return;
    const u = URL.createObjectURL(probe.poster.blob);
    setPosterUrl(u);
    return () => { URL.revokeObjectURL(u); setPosterUrl(null); };
  }, [probe]);

  const clear = () => {
    gen.current++;
    setFile(null); setProbe(null); setTitle(''); setErr(null);
    if (input.current) input.current.value = '';
    onChange?.(false);
  };

  const pick = async (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    const mime = videoMime(f);
    if (!mime) { setErr('Please choose an MP4, WebM or MOV video.'); return; }
    if (f.size > MAX_VIDEO_BYTES) {
      setErr(`This video is ${formatBytes(f.size)}. Videos can be up to ${formatBytes(MAX_VIDEO_BYTES)}.`);
      if (input.current) input.current.value = '';
      return;
    }
    if (f.size === 0) { setErr('That file is empty.'); return; }
    const g = ++gen.current;
    setFile(f); setProbe(null);
    onChange?.(true);
    const p = await probeVideo(f);
    if (g === gen.current) setProbe(p);
  };

  useImperativeHandle(handleRef, () => ({
    hasFile: () => !!file,
    clear,
    upload: async (onProgress) => {
      if (!file) throw new Error('Choose a video to upload.');
      const mime = videoMime(file);
      if (!mime) throw new Error('Please choose an MP4, WebM or MOV video.');
      if (file.size > MAX_VIDEO_BYTES) throw new Error(`Videos can be up to ${formatBytes(MAX_VIDEO_BYTES)}.`);
      const p = probe ?? await probeVideo(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ref = await uploadLargeEncrypted(bytes, mime, { onProgress });
      const poster = p.poster ? await uploadPreparedImage(p.poster).catch(() => undefined) : undefined;
      const t = title.trim().slice(0, 200);
      const video: NonNullable<PostPayload['video']> = {
        file: { ...ref, ...(p.w && p.h ? { w: p.w, h: p.h } : {}) },
        ...(poster ? { poster } : {}),
        ...(t ? { title: t } : {}),
        ...(p.duration ? { duration: Math.round(p.duration * 10) / 10 } : {}),
        ...(p.w && p.h ? { w: p.w, h: p.h } : {}),
      };
      return { video, paths: [...fileRefPaths(ref), ...(poster ? [poster.path] : [])] };
    },
  }));

  if (!file) {
    return (
      <div>
        <label className="kw-vchoose">
          <Icon name="video" />
          <input ref={input} type="file" accept="video/mp4,video/webm,video/quicktime" disabled={disabled}
            aria-label="Choose a video" onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        <div className="kw-pub-note">MP4, WebM or MOV, up to {formatBytes(MAX_VIDEO_BYTES)}. Videos are encrypted on your device before they’re uploaded.</div>
        {err && <div className="err" role="alert" style={{ margin: '4px 0' }}>{err}</div>}
      </div>
    );
  }
  const dur = formatDuration(probe?.duration);
  return (
    <div className="kw-vpick">
      <div className="kw-vpick-th" style={probe?.w && probe.h ? { aspectRatio: `${probe.w} / ${probe.h}`, maxHeight: 240 } : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {posterUrl ? <img src={posterUrl} alt="Video preview" /> : <span className="kw-ph" style={{ display: 'block', height: '100%' }} />}
        {dur ? <span className="kw-dur">{dur}</span> : null}
      </div>
      <div className="kw-vpick-info">
        <b title={file.name}>{file.name}</b>
        {formatBytes(file.size)}{dur ? ` · ${dur}` : ''}{probe?.w ? ` · ${probe.w}×${probe.h}` : ''}
        {!probe && <><br />Reading video…</>}
        {probe && !probe.playable && <><br />This browser can’t preview this format. You can still share it; friends whose browsers can’t play it can download it.</>}
        <input type="text" placeholder="Title (optional)" aria-label="Video title" value={title} maxLength={200} disabled={disabled}
          onChange={(e) => setTitle(e.target.value)} />
      </div>
      <button type="button" className="kw-lc-x" aria-label="Remove video" title="Remove" disabled={disabled} onClick={clear}>&times;</button>
    </div>
  );
}
