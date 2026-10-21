// Voice notes (Kithwall 2 phase 4): pure helpers shared by the recorder, the sender and the player.
//
// A voice note is an ordinary chat attachment: the audio is recorded with MediaRecorder (Opus in WebM, or
// AAC in MP4 on Safari; never transcoded on a server), encrypted on this device and uploaded like a photo.
// Its length and a compact waveform (64 peak bytes) travel INSIDE the encrypted message payload, so the
// server learns nothing beyond the size of an opaque file. Unsend and disappearing timers delete it with
// the message, like every other attachment.
import { b64u } from '@kithwall/crypto';

/** Longest voice note, in seconds. Recording stops by itself here. */
export const MAX_VOICE_SECS = 5 * 60;
/** Shorter recordings are treated as an accidental tap and thrown away. */
export const MIN_VOICE_SECS = 0.7;
/** Number of bars in the stored waveform. */
export const VOICE_PEAKS = 64;
/** Recorded files are tiny (≈ 1–5 MB for five minutes); anything far larger is refused. */
export const MAX_VOICE_BYTES = 20 * 1024 * 1024;
/** Opus at 32 kbit/s is clear speech and keeps five minutes at about 1.2 MB. */
export const VOICE_BITRATE = 32_000;

/** Payload metadata of a voice note (inside the encrypted message). */
export interface VoiceMeta {
  /** Length in seconds (one decimal). */
  duration: number;
  /** b64u of VOICE_PEAKS bytes, 0–255 each. */
  peaks: string;
}

/** A finished recording waiting to be sent. */
export interface VoiceDraft {
  blob: Blob;
  /** Container type without codec parameters, e.g. audio/webm or audio/mp4. */
  mime: string;
  duration: number;
  peaks: Uint8Array;
}

/** Formats to try, best first. Safari has no WebM recording, so it falls back to MP4/AAC. */
export const VOICE_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm',
] as const;

/** The first recording format this browser supports ('' = let the browser choose). */
export function pickVoiceMime(isTypeSupported: (t: string) => boolean): string {
  for (const m of VOICE_MIME_CANDIDATES) {
    try { if (isTypeSupported(m)) return m; } catch { /* keep looking */ }
  }
  return '';
}

/** `audio/webm;codecs=opus` → `audio/webm`. Only audio/* types are kept; anything else becomes audio/webm. */
export function baseAudioMime(m: string | null | undefined): string {
  const base = (m ?? '').split(';')[0]!.trim().toLowerCase();
  return /^audio\/[a-z0-9.+-]+$/.test(base) ? base : 'audio/webm';
}

/**
 * Turn a run of loudness samples (0–1, e.g. RMS every 50 ms) into `n` peak bytes: the loudest sample of
 * each bucket, scaled so the loudest bar is full height, with a square-root curve so quiet speech is
 * still visible and a small floor so silence draws a dot rather than nothing.
 */
export function computePeaks(levels: ArrayLike<number>, n = VOICE_PEAKS): Uint8Array {
  const out = new Uint8Array(n);
  const len = levels.length;
  if (!len) return out.fill(8);
  const raw = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * len) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * len) / n));
    let m = 0;
    for (let j = from; j < to && j < len; j++) {
      const v = Number(levels[j]);
      if (Number.isFinite(v) && Math.abs(v) > m) m = Math.abs(v);
    }
    raw[i] = m;
  }
  const max = Math.max(...raw);
  for (let i = 0; i < n; i++) {
    const rel = max > 0.002 ? Math.sqrt(raw[i]! / max) : 0;
    out[i] = Math.max(8, Math.min(255, Math.round(rel * 255)));
  }
  return out;
}

export const encodePeaks = (p: Uint8Array): string => b64u.encode(p);

/** Peaks from a decrypted payload; a flat line if missing or malformed. */
export function decodePeaks(s: unknown, n = VOICE_PEAKS): Uint8Array {
  if (typeof s === 'string' && s.length <= 4 * n && /^[A-Za-z0-9_-]*$/.test(s)) {
    try {
      const raw = b64u.decode(s);
      if (raw.length === n) return raw;
      if (raw.length > 0 && raw.length < 1024) return resamplePeaks(raw, n);
    } catch { /* fall through */ }
  }
  return new Uint8Array(n).fill(24);
}

/** Stretch or squeeze a peak array to `n` bars (for narrow screens, or foreign lengths). */
export function resamplePeaks(p: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (!p.length) return out;
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * p.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * p.length) / n));
    let m = 0;
    for (let j = from; j < to && j < p.length; j++) m = Math.max(m, p[j]!);
    out[i] = m;
  }
  return out;
}

/** Round a recording length for the payload (one decimal, clamped to the limit). */
export const roundDuration = (secs: number): number =>
  Math.min(MAX_VOICE_SECS, Math.max(0, Math.round((Number.isFinite(secs) ? secs : 0) * 10) / 10));

/** Metadata from a decrypted payload, or null if it isn't a usable voice note. */
export function readVoiceMeta(v: unknown): VoiceMeta | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const d = o.duration;
  if (typeof d !== 'number' || !Number.isFinite(d) || d < 0 || d > MAX_VOICE_SECS + 5) return null;
  return { duration: d, peaks: typeof o.peaks === 'string' ? o.peaks : '' };
}

export function voiceMeta(d: Pick<VoiceDraft, 'duration' | 'peaks'>): VoiceMeta {
  return { duration: roundDuration(d.duration), peaks: encodePeaks(d.peaks) };
}

/** m:ss parts for a number of seconds (always rounded down, never negative). */
export function clockParts(secs: number): { m: number; s: number } {
  const t = Math.max(0, Math.floor(Number.isFinite(secs) ? secs : 0));
  return { m: Math.floor(t / 60), s: t % 60 };
}

/** Next playback speed in the 1× → 1.5× → 2× cycle. */
export const VOICE_RATES = [1, 1.5, 2] as const;
export function nextRate(r: number): number {
  const i = VOICE_RATES.indexOf(r as (typeof VOICE_RATES)[number]);
  return VOICE_RATES[(i + 1) % VOICE_RATES.length]!;
}

/**
 * Seek fraction for a pointer position over the waveform. In right-to-left layouts the waveform runs
 * from right to left, like the text around it.
 */
export function seekFraction(x: number, left: number, width: number, rtl: boolean): number {
  if (!(width > 0)) return 0;
  const f = (x - left) / width;
  return Math.min(1, Math.max(0, rtl ? 1 - f : f));
}
