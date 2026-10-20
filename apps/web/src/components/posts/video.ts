'use client';
// Composer video helpers (adapted from the v1 publisher): accept MP4/WebM/MOV up to 100 MB, read the
// duration and size with a hidden <video>, grab a poster frame through a canvas (→ JPEG, no metadata),
// then encrypt on this device and upload in parts (lib/media uploadLargeEncrypted).
import { fileRefPaths, MAX_VIDEO_BYTES, uploadLargeEncrypted, type ProgressFn } from '@/lib/media';
import { uploadPreparedImage, type PreparedImage } from '@/lib/feed/linkPreview';
import type { PostPayload } from '@/lib/types';

export { MAX_VIDEO_BYTES };

export interface VideoProbe { duration?: number; w?: number; h?: number; poster?: PreparedImage; playable: boolean }

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
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('decode')); };
    const cleanup = () => { clearTimeout(timer); el.removeEventListener(event, ok); el.removeEventListener('error', bad); };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

/** Read duration/dimensions and grab a poster frame on this device. Never throws. */
export async function probeVideo(file: File): Promise<VideoProbe> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  try {
    const meta = waitFor(v, 'loadedmetadata', 15_000);
    v.src = url;
    await meta;
    if (v.duration === Infinity) {
      try {
        const changed = waitFor(v, 'durationchange', 8_000);
        v.currentTime = 1e9;
        await changed;
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

/** Encrypt + upload a picked video; returns the payload part and every storage path created. */
export async function uploadVideo(file: File, probe: VideoProbe | null, onProgress: ProgressFn): Promise<{ video: NonNullable<PostPayload['video']>; paths: string[] }> {
  const mime = videoMime(file);
  if (!mime) throw new Error('type');
  const p = probe ?? await probeVideo(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ref = await uploadLargeEncrypted(bytes, mime, { onProgress });
  const poster = p.poster ? await uploadPreparedImage(p.poster).catch(() => undefined) : undefined;
  const video: NonNullable<PostPayload['video']> = {
    file: { ...ref, ...(p.w && p.h ? { w: p.w, h: p.h } : {}) },
    ...(poster ? { poster } : {}),
    ...(p.duration ? { duration: Math.round(p.duration * 10) / 10 } : {}),
    ...(p.w && p.h ? { w: p.w, h: p.h } : {}),
  };
  return { video, paths: [...fileRefPaths(ref), ...(poster ? [poster.path] : [])] };
}
