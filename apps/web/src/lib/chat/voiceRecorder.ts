'use client';
// Voice-note recorder (Kithwall 2 phase 4). Records the microphone with MediaRecorder on this device
// (Opus/WebM, or AAC/MP4 on Safari), samples loudness for the live waveform and the stored peaks, and stops
// by itself at MAX_VOICE_SECS. Nothing leaves the device until the person presses send; the audio is then
// encrypted and uploaded like any other attachment (components/messages/send.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  baseAudioMime, computePeaks, MAX_VOICE_SECS, MIN_VOICE_SECS, pickVoiceMime, VOICE_BITRATE, type VoiceDraft,
} from './voice';

export type VoiceState = 'idle' | 'starting' | 'recording' | 'preview';
export type VoiceMode = 'hold' | 'locked';
export type VoiceErrorCode = 'denied' | 'no_mic' | 'unsupported' | 'failed' | 'too_short';

/** Bars shown while recording (the newest at the end). */
export const LIVE_BARS = 40;
const TICK_MS = 50;

interface Session {
  stream: MediaStream;
  recorder: MediaRecorder;
  ctx: AudioContext | null;
  analyser: AnalyserNode | null;
  buf: Float32Array<ArrayBuffer> | null;
  chunks: Blob[];
  levels: number[];
  t0: number;
  timer: ReturnType<typeof setInterval> | null;
  cancelled: boolean;
}

export function voiceSupported(): boolean {
  return typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

function classify(e: unknown): VoiceErrorCode {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') return 'no_mic';
  return 'failed';
}

export interface VoiceRecorder {
  state: VoiceState;
  mode: VoiceMode;
  /** Seconds recorded so far (or the draft's length in preview). */
  elapsed: number;
  /** Recent loudness 0–1 for the live waveform (LIVE_BARS values). */
  live: number[];
  draft: VoiceDraft | null;
  /** True when recording stopped because it reached the 5-minute limit. */
  hitLimit: boolean;
  start: (mode: VoiceMode) => void;
  lock: () => void;
  /** Stop recording and show the preview. */
  stop: () => void;
  /** Stop and throw everything away. */
  cancel: () => void;
  /** Take the finished draft (for sending) and return to idle. */
  take: () => VoiceDraft | null;
}

export function useVoiceRecorder(onError: (code: VoiceErrorCode) => void): VoiceRecorder {
  const [state, setState] = useState<VoiceState>('idle');
  const [mode, setMode] = useState<VoiceMode>('hold');
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState<number[]>(() => new Array<number>(LIVE_BARS).fill(0));
  const [draft, setDraft] = useState<VoiceDraft | null>(null);
  const [hitLimit, setHitLimit] = useState(false);
  const session = useRef<Session | null>(null);
  const errRef = useRef(onError);
  useEffect(() => { errRef.current = onError; }, [onError]);
  // Stop requested while the microphone was still opening (a quick tap-release is handled by the caller).
  const pendingStop = useRef<null | 'stop' | 'cancel'>(null);
  // Bumped by every start and every cancel, so a microphone that opens late for an abandoned start is closed.
  const gen = useRef(0);

  const release = useCallback((s: Session) => {
    if (s.timer) clearInterval(s.timer);
    s.timer = null;
    for (const tr of s.stream.getTracks()) tr.stop();
    if (s.ctx) void s.ctx.close().catch(() => undefined);
  }, []);

  const finish = useCallback((s: Session, discard: boolean) => {
    if (session.current !== s) return;
    session.current = null;
    s.cancelled = discard;
    const duration = Math.min(MAX_VOICE_SECS, (performance.now() - s.t0) / 1000);
    const done = () => {
      release(s);
      if (s.cancelled) { setState('idle'); setDraft(null); return; }
      if (duration < MIN_VOICE_SECS || !s.chunks.length) {
        setState('idle'); setDraft(null);
        errRef.current('too_short');
        return;
      }
      const mime = baseAudioMime(s.recorder.mimeType || s.chunks[0]?.type);
      const blob = new Blob(s.chunks, { type: mime });
      setDraft({ blob, mime, duration, peaks: computePeaks(s.levels) });
      setElapsed(duration);
      setState('preview');
    };
    if (s.recorder.state === 'inactive') { done(); return; }
    s.recorder.addEventListener('stop', done, { once: true });
    try { s.recorder.requestData(); } catch { /* not recording */ }
    try { s.recorder.stop(); } catch { done(); }
  }, [release]);

  const start = useCallback((m: VoiceMode) => {
    if (session.current || state === 'starting' || state === 'recording') return;
    if (!voiceSupported()) { errRef.current('unsupported'); return; }
    pendingStop.current = null;
    const my = ++gen.current;
    setMode(m);
    setHitLimit(false);
    setDraft(null);
    setElapsed(0);
    setLive(new Array<number>(LIVE_BARS).fill(0));
    setState('starting');
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) {
        if (gen.current !== my) return;
        setState('idle');
        errRef.current(classify(e));
        return;
      }
      if (gen.current !== my) { for (const tr of stream.getTracks()) tr.stop(); return; }
      let recorder: MediaRecorder;
      const mimeType = pickVoiceMime((t) => MediaRecorder.isTypeSupported(t));
      try {
        recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: VOICE_BITRATE });
      } catch {
        try { recorder = new MediaRecorder(stream); } catch {
          for (const tr of stream.getTracks()) tr.stop();
          setState('idle');
          errRef.current('unsupported');
          return;
        }
      }
      let ctx: AudioContext | null = null;
      let analyser: AnalyserNode | null = null;
      try {
        ctx = new AudioContext();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
      } catch { ctx = null; analyser = null; }
      const s: Session = {
        stream, recorder, ctx, analyser, buf: analyser ? new Float32Array(analyser.fftSize) : null,
        chunks: [], levels: [], t0: performance.now(), timer: null, cancelled: false,
      };
      recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) s.chunks.push(e.data); });
      recorder.addEventListener('error', () => { finish(s, true); errRef.current('failed'); });
      // A track that ends (microphone unplugged, permission revoked) ends the recording.
      for (const tr of stream.getAudioTracks()) tr.addEventListener('ended', () => finish(s, false), { once: true });
      try { recorder.start(1000); } catch {
        release(s);
        setState('idle');
        errRef.current('failed');
        return;
      }
      s.t0 = performance.now();
      session.current = s;
      setState('recording');
      let tick = 0;
      s.timer = setInterval(() => {
        let level = 0;
        if (s.analyser && s.buf) {
          s.analyser.getFloatTimeDomainData(s.buf);
          let sum = 0;
          for (let i = 0; i < s.buf.length; i++) sum += s.buf[i]! * s.buf[i]!;
          level = Math.sqrt(sum / s.buf.length);
        }
        s.levels.push(level);
        const secs = (performance.now() - s.t0) / 1000;
        if (++tick % 2 === 0) {
          setElapsed(secs);
          const shown = Math.min(1, Math.sqrt(level * 4));
          setLive((cur) => [...cur.slice(1), shown]);
        }
        if (secs >= MAX_VOICE_SECS) { setHitLimit(true); finish(s, false); }
      }, TICK_MS);
      if (pendingStop.current) finish(s, pendingStop.current === 'cancel');
    })();
  }, [finish, release, state]);

  const stop = useCallback(() => {
    const s = session.current;
    if (s) finish(s, false); else pendingStop.current = 'stop';
  }, [finish]);

  const cancel = useCallback(() => {
    const s = session.current;
    if (s) finish(s, true);
    else { pendingStop.current = 'cancel'; gen.current++; }
    setDraft(null);
    setState('idle');
  }, [finish]);

  const lock = useCallback(() => setMode('locked'), []);

  const take = useCallback(() => {
    const d = draft;
    setDraft(null);
    setState('idle');
    return d;
  }, [draft]);

  // Leaving the chat mid-recording throws the recording away and frees the microphone.
  useEffect(() => () => {
    const s = session.current;
    if (s) { session.current = null; s.cancelled = true; try { s.recorder.stop(); } catch { /* ignore */ } release(s); }
  }, [release]);

  return { state, mode, elapsed, live, draft, hitLimit, start, lock, stop, cancel, take };
}
