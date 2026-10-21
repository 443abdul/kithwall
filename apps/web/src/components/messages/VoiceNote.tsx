'use client';
// Voice-note player (Kithwall 2 phase 4): play/pause, a waveform you can click, drag or arrow-key through,
// 1× / 1.5× / 2× speed and an "unplayed" dot. In a chat bubble the audio is downloaded from our storage and
// decrypted on this device only when the person presses play (or seeks); the length and waveform come from
// the encrypted message itself, so nothing is fetched just to draw the bubble. Only one note plays at a time.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useFormat, useT } from '@/i18n';
import { downloadFile } from '@/lib/media';
import type { FileRef } from '@/lib/types';
import { clockParts, decodePeaks, nextRate, readVoiceMeta, seekFraction, VOICE_RATES, type VoiceMeta } from '@/lib/chat/voice';
import { Spinner } from '@/components/ui/Spinner';
import { cx } from '@/components/ui/cx';
import { VoiceIcon } from './VoiceIcon';

// ------------------------------------------------------------------------------------------------
// Small shared state: the one element that is playing, the chosen speed, which notes I've played.

let playing: HTMLAudioElement | null = null;
function claim(el: HTMLAudioElement) {
  if (playing && playing !== el) playing.pause();
  playing = el;
}

const RATE_KEY = 'kw.voice.rate';
const PLAYED_KEY = 'kw.voice.played';
const MAX_PLAYED = 400;

function readRate(): number {
  try {
    const r = Number(localStorage.getItem(RATE_KEY));
    return (VOICE_RATES as readonly number[]).includes(r) ? r : 1;
  } catch { return 1; }
}
function saveRate(r: number) { try { localStorage.setItem(RATE_KEY, String(r)); } catch { /* storage blocked */ } }

/** Ids of notes from other people that I've played, on this device only (the server never learns it). */
function playedList(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PLAYED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
function markPlayed(id: string) {
  try {
    const xs = playedList().filter((x) => x !== id);
    xs.push(id);
    localStorage.setItem(PLAYED_KEY, JSON.stringify(xs.slice(-MAX_PLAYED)));
  } catch { /* storage blocked */ }
}

// Decrypted audio, cached by storage path so replaying doesn't download again (small, bounded).
const cache = new Map<string, Promise<string>>();
const MAX_CACHE = 30;
const RETRY = [700, 1500, 3000];

function decryptedUrl(file: FileRef): Promise<string> {
  const hit = cache.get(file.path);
  if (hit) return hit;
  const p = (async () => {
    let last: unknown;
    for (let i = 0; i <= RETRY.length; i++) {
      try {
        const bytes = await downloadFile(file);
        return URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.mime }));
      } catch (e) {
        last = e;
        // The sender may still be linking the file to the message: try again shortly.
        if (i < RETRY.length) await new Promise((r) => setTimeout(r, RETRY[i]));
      }
    }
    throw last;
  })();
  p.catch(() => cache.delete(file.path));
  cache.set(file.path, p);
  if (cache.size > MAX_CACHE) {
    const [oldest, op] = cache.entries().next().value as [string, Promise<string>];
    cache.delete(oldest);
    void op.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
  }
  return p;
}

/** MediaRecorder's WebM files carry no length; asking for a far-away time makes the browser find it. */
function primeDuration(a: HTMLAudioElement): Promise<void> {
  if (Number.isFinite(a.duration) && a.duration > 0) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      a.removeEventListener('durationchange', check); a.removeEventListener('timeupdate', check);
      a.currentTime = 0;
      resolve();
    };
    const check = () => { if (Number.isFinite(a.duration)) done(); };
    a.addEventListener('durationchange', check);
    a.addEventListener('timeupdate', check);
    const timer = setTimeout(done, 1500);
    try { a.currentTime = 1e7; } catch { done(); }
  });
}

function useClock() {
  const f = useFormat();
  return useCallback((secs: number) => {
    const { m, s } = clockParts(secs);
    return `${f.number(m)}:${f.number(s, { minimumIntegerDigits: 2 })}`;
  }, [f]);
}

// ------------------------------------------------------------------------------------------------

export interface VoicePlayerProps {
  /** Resolves to a playable URL (blob:). Called on first play or seek. */
  load: () => Promise<string>;
  duration: number;
  peaks: Uint8Array;
  /** Shows the unplayed dot until first played. */
  unplayed?: boolean;
  onPlayed?: () => void;
  className?: string;
}

export function VoicePlayer({ load, duration, peaks, unplayed, onPlayed, className }: VoicePlayerProps) {
  const t = useT();
  const clock = useClock();
  const audio = useRef<HTMLAudioElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [isPlaying, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  // Client-only component (messages render after decryption), so storage can be read during render.
  const [rate, setRate] = useState(readRate);
  const [dragging, setDragging] = useState(false);
  const loading = useRef<Promise<boolean> | null>(null);
  // The file's own length once it's loaded (the stored one is measured while recording and can be a bit short).
  const [fileDur, setFileDur] = useState<number | null>(null);
  const total = fileDur ?? (duration > 0 ? duration : 0);

  useEffect(() => { if (audio.current) audio.current.playbackRate = rate; }, [rate]);

  const ensure = useCallback((): Promise<boolean> => {
    const a = audio.current;
    if (!a) return Promise.resolve(false);
    if (status === 'ready') return Promise.resolve(true);
    if (loading.current) return loading.current;
    setStatus('loading');
    const p = (async () => {
      try {
        const url = await load();
        a.src = url;
        await new Promise<void>((resolve, reject) => {
          if (a.readyState >= 1) { resolve(); return; }
          a.addEventListener('loadedmetadata', () => resolve(), { once: true });
          a.addEventListener('error', () => reject(new Error('media error')), { once: true });
          a.load();
        });
        await primeDuration(a);
        if (Number.isFinite(a.duration) && a.duration > 0 && Math.abs(a.duration - duration) < 5) setFileDur(a.duration);
        a.playbackRate = readRate();
        setStatus('ready');
        return true;
      } catch {
        setStatus('failed');
        return false;
      } finally {
        loading.current = null;
      }
    })();
    loading.current = p;
    return p;
  }, [load, status, duration]);

  // Smooth progress while playing.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const step = () => {
      const a = audio.current;
      if (a && !dragging) setPos(a.currentTime);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, dragging]);

  // Pause when the player leaves the screen (message expired, unsent, chat closed).
  useEffect(() => {
    const a = audio.current;
    return () => { if (a) { a.pause(); if (playing === a) playing = null; } };
  }, []);

  async function toggle() {
    const a = audio.current;
    if (!a) return;
    if (!a.paused) { a.pause(); return; }
    if (!(await ensure())) return;
    if (total && pos >= total - 0.05) setPos(0);
    try {
      if (Math.abs(a.currentTime - pos) > 0.25 && pos < total - 0.05) a.currentTime = pos;
      claim(a);
      await a.play();
    } catch { setStatus('failed'); }
  }

  async function seekTo(secs: number) {
    const target = Math.min(total, Math.max(0, secs));
    setPos(target);
    const a = audio.current;
    if (!a || status !== 'ready') return;
    try { a.currentTime = target; } catch { /* not seekable yet */ }
  }

  const rtl = () => (wave.current ? getComputedStyle(wave.current).direction === 'rtl' : false);
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return seekFraction(e.clientX, r.left, r.width, rtl()) * total;
  };
  function onDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !total) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setPos(fromPointer(e));
  }
  function onMove(e: PointerEvent<HTMLDivElement>) { if (dragging) setPos(fromPointer(e)); }
  function onUp(e: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setDragging(false);
    const secs = fromPointer(e);
    void seekTo(secs);
    if (status !== 'ready') void ensure().then((ok) => { if (ok && audio.current) audio.current.currentTime = secs; });
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const back = rtl() ? 'ArrowRight' : 'ArrowLeft';
    const fwd = rtl() ? 'ArrowLeft' : 'ArrowRight';
    let to: number | null = null;
    if (e.key === fwd || e.key === 'ArrowUp') to = pos + 5;
    else if (e.key === back || e.key === 'ArrowDown') to = pos - 5;
    else if (e.key === 'PageUp') to = pos + 15;
    else if (e.key === 'PageDown') to = pos - 15;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = total;
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); void toggle(); return; }
    if (to === null) return;
    e.preventDefault();
    void seekTo(to);
  }

  function cycleRate() {
    const r = nextRate(rate);
    setRate(r);
    saveRate(r);
  }

  const bars = useMemo(() => Array.from(peaks), [peaks]);
  const frac = total ? Math.min(1, pos / total) : 0;
  const playedBars = Math.round(frac * bars.length);
  const shownTime = isPlaying || pos > 0 ? pos : total;
  const rateText = `${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })}×`;

  return (
    <div className={cx('k-voice', isPlaying && 'is-playing', status === 'failed' && 'is-failed', className)}>
      <button type="button" className="k-voice-play" onClick={() => void toggle()}
        aria-label={isPlaying ? t('voice.pause') : t('voice.play')} title={isPlaying ? t('voice.pause') : t('voice.play')}>
        {status === 'loading' ? <Spinner size={18} /> : <VoiceIcon name={isPlaying ? 'pause' : 'play'} />}
      </button>
      <div className="k-voice-main">
        <div ref={wave} className="k-voice-wave" role="slider" tabIndex={0}
          aria-label={t('voice.position')} aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(pos)}
          aria-valuetext={t('voice.positionText', { current: clock(pos), total: clock(total) })}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDragging(false)} onKeyDown={onKey}>
          {bars.map((v, i) => (
            <span key={i} className={cx('k-voice-bar', i < playedBars && 'is-played')} style={{ blockSize: `${Math.max(10, Math.round((v / 255) * 100))}%` }} />
          ))}
        </div>
        <div className="k-voice-meta">
          <span className="k-voice-time" dir="ltr">{clock(shownTime)}</span>
          {unplayed ? <span className="k-voice-dot" role="img" aria-label={t('voice.unplayed')} /> : null}
          {status === 'failed' ? <span className="k-voice-err" role="alert">{t('voice.failed')}</span> : null}
        </div>
      </div>
      <button type="button" className="k-voice-rate" onClick={cycleRate} aria-label={t('voice.speed', { rate: rateText })} title={t('voice.speed', { rate: rateText })}>
        <span aria-hidden dir="ltr">{rateText}</span>
      </button>
      <audio ref={audio} preload="none" hidden
        onPlay={() => { setPlaying(true); onPlayed?.(); }}
        onPause={() => { setPlaying(false); if (audio.current) setPos(audio.current.currentTime); }}
        onEnded={() => { setPlaying(false); setPos(0); if (audio.current) audio.current.currentTime = 0; }} />
    </div>
  );
}

/** A voice note inside a chat bubble. */
export function VoiceNote({ file, meta, messageId, mine }: { file: FileRef; meta: VoiceMeta; messageId: string; mine: boolean }) {
  const t = useT();
  const clock = useClock();
  const peaks = useMemo(() => decodePeaks(meta.peaks), [meta.peaks]);
  const [unplayed, setUnplayed] = useState(() => !mine && !playedList().includes(messageId));
  const load = useCallback(() => decryptedUrl(file), [file]);
  return (
    <div className="k-voice-note" role="group" aria-label={t('voice.label', { duration: clock(meta.duration) })}>
      <VoicePlayer load={load} duration={meta.duration} peaks={peaks} unplayed={unplayed}
        onPlayed={() => { if (unplayed) { setUnplayed(false); markPlayed(messageId); } }} />
    </div>
  );
}

const AUDIO_PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}(-[a-z0-9]+)?$/;

/** The audio file and metadata of a decrypted message, if it is a voice note. */
export function voiceOf(p: { voice?: unknown; attachments?: FileRef[] } | null | undefined): { file: FileRef; meta: VoiceMeta } | null {
  if (!p?.voice) return null;
  const meta = readVoiceMeta(p.voice);
  const file = (p.attachments ?? []).find((a) => !!a && typeof a.mime === 'string' && a.mime.startsWith('audio/')
    && typeof a.path === 'string' && AUDIO_PATH_RE.test(a.path) && typeof a.key === 'string');
  return meta && file ? { file, meta } : null;
}
