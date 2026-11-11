// Reels: what a reel is allowed to be and how it is encoded (docs/v2/12-reels.md §2). Pure and unit-tested
// (plan.test.ts); ./transcode.ts does the work with these numbers.
//
// A reel is at most a minute long and is re-encoded on the device before upload: at most 720p (720 on the
// short side, 1280 on the long side), 30 frames a second, at about 850 kbit/s for the picture and 96 kbit/s
// for the sound: roughly 7 MB per minute. With Data Saver on it is 540p at about 4.5 MB per minute, because
// the people watching may be on expensive data too. Re-encoding also drops whatever the camera wrote into the
// file (place, device, time).

export const REEL_MAX_SECONDS = 60;
export const REEL_MIN_SECONDS = 1;
export const REEL_CAPTION_MAX = 2200;
/** The largest video a reel may carry when the server's setting is not known yet (reel_max_mb, default 16). */
export const REEL_DEFAULT_MAX_MB = 16;
/** The source a person picks may be much bigger than the reel made from it (it never leaves the device). */
export const REEL_SOURCE_MAX_BYTES = 1024 * 1024 * 1024;
export const REEL_FPS = 30;
export const REEL_AUDIO_BPS = 96_000;

export interface ReelTarget { w: number; h: number; videoBps: number; audioBps: number; fps: number }

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Output size: scaled down (never up) to fit 720 × 1280 either way round, with even sides. */
export function targetSize(w: number, h: number, saver = false): { w: number; h: number } {
  const short = saver ? 540 : 720;
  const long = saver ? 960 : 1280;
  if (!(w > 0) || !(h > 0)) return { w: short, h: long };
  const scale = Math.min(1, short / Math.min(w, h), long / Math.max(w, h));
  return { w: even(w * scale), h: even(h * scale) };
}

/** Picture bitrate for an output size: 850 kbit/s at 720p (600 with Data Saver at 540p), less for smaller pictures, never below 250. */
export function videoBitrate(w: number, h: number, saver = false): number {
  const full = saver ? 540 * 960 : 720 * 1280;
  const top = saver ? 500_000 : 850_000;
  const share = Math.min(1, (w * h) / full);
  return Math.round(Math.max(250_000, top * (0.25 + 0.75 * share)) / 1000) * 1000;
}

export function planEncode(w: number, h: number, saver = false): ReelTarget {
  const size = targetSize(w, h, saver);
  return { ...size, videoBps: videoBitrate(size.w, size.h, saver), audioBps: saver ? 64_000 : REEL_AUDIO_BPS, fps: REEL_FPS };
}

/** About how many bytes `seconds` of reel will take. */
export function estimateBytes(seconds: number, t: Pick<ReelTarget, 'videoBps' | 'audioBps'>): number {
  return Math.round((Math.max(0, seconds) * (t.videoBps + t.audioBps)) / 8 * 1.03);
}

/** A trim that fits the video and the one-minute limit: `end` gives way first, both stay inside the video. */
export function clampTrim(start: number, end: number, duration: number, moved: 'start' | 'end' = 'end'): { start: number; end: number } {
  const d = Number.isFinite(duration) && duration > 0 ? duration : REEL_MAX_SECONDS;
  let s = Math.min(Math.max(0, Number.isFinite(start) ? start : 0), Math.max(0, d - REEL_MIN_SECONDS));
  let e = Math.min(Math.max(Number.isFinite(end) ? end : d, 0), d);
  if (e - s < REEL_MIN_SECONDS) { if (moved === 'start') e = Math.min(d, s + REEL_MIN_SECONDS); else s = Math.max(0, e - REEL_MIN_SECONDS); }
  if (e - s > REEL_MAX_SECONDS) { if (moved === 'start') e = s + REEL_MAX_SECONDS; else s = e - REEL_MAX_SECONDS; }
  const r = (n: number) => Math.round(n * 100) / 100;
  return { start: r(s), end: r(e) };
}

/** The trim a newly picked video starts with: from the beginning, at most a minute. */
export const initialTrim = (duration: number) => clampTrim(0, Math.min(duration, REEL_MAX_SECONDS), duration);

export type OriginalVerdict = 'ok' | 'too_long' | 'too_big' | 'trimmed' | 'type';

/**
 * When this device can re-encode nothing: may the picked file go up as it is? Only a whole MP4 or WebM of at
 * most a minute that is already within the size cap.
 */
export function originalVerdict(file: { size: number; mime: string | null }, duration: number | undefined, trim: { start: number; end: number }, maxBytes: number): OriginalVerdict {
  if (file.mime !== 'video/mp4' && file.mime !== 'video/webm') return 'type';
  if (!duration || duration > REEL_MAX_SECONDS + 0.5) return 'too_long';
  if (trim.start > 0.25 || trim.end < duration - 0.25) return 'trimmed';
  if (file.size > maxBytes) return 'too_big';
  return 'ok';
}

/** Room kept for the cover picture inside the cap (the cap is on a reel's files together). */
export const REEL_COVER_ALLOWANCE = 640 * 1024;

/**
 * The plaintext bytes a reel's video may have so that its stored ciphertext plus the cover stay within
 * `maxMb` (lib/media cipherSize: a 17-byte header and 16 bytes per 64 KiB chunk).
 */
export function maxVideoBytes(maxMb: number): number {
  const cap = Math.max(1, maxMb) * 1024 * 1024 - REEL_COVER_ALLOWANCE;
  return cap - 17 - Math.ceil(cap / 65536) * 16;
}
