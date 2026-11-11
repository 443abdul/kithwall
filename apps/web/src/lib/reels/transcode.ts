'use client';
// Reels: re-encoding a picked or recorded video on this device before it is encrypted and uploaded
// (docs/v2/12-reels.md §2). Nothing here touches the network.
//
// The source is played by the browser's own <video> element (so every format the device can play works:
// MP4, MOV, WebM, phone rotation included), from the trim start to the trim end, at normal speed; every frame
// it shows is drawn, scaled, onto a canvas, and its sound is routed through a Web Audio graph instead of the
// speakers. What happens to those frames and that sound depends on the device:
//
//  1. WebCodecs (Chrome, Edge, Android WebView): frames go to a VideoEncoder (H.264, VP9 where there is no
//     H.264 encoder) and sound to an AudioEncoder (AAC, else Opus) with exact timestamps, and the result is
//     written as an MP4 by mp4-muxer (MIT, no network, no dependencies; the one library this feature adds).
//  2. MediaRecorder (Firefox, Safari, anything without WebCodecs): the canvas and the sound are recorded as
//     the browser's own WebM or MP4 at the same target bitrate.
//  3. Neither: ReelEncodeError('unsupported'). The caller may then upload the original, but only when it is
//     already short and small enough (lib/reels/plan originalVerdict), and says so otherwise.
//
// Playing the source once takes as long as the reel is: a 30-second reel is ready in about 30 seconds.
// While the page is hidden the work pauses (browsers stop presenting frames of a hidden page) and it
// continues when the person comes back.
import type { PreparedImage } from '../feed/linkPreview';
import type { ReelTarget } from './plan';

export type ReelMethod = 'webcodecs' | 'recorder' | 'original';

export interface EncodeInput {
  file: Blob;
  /** Trim, in seconds of the source. */
  start: number;
  end: number;
  target: ReelTarget;
  signal?: AbortSignal;
  /** 0…1 of the reel encoded so far. */
  onProgress?: (fraction: number) => void;
  /** Where to show the video while it is worked on (a preview for the person); hidden when absent. */
  mount?: HTMLElement | null;
}

export interface EncodedReel {
  blob: Blob;
  mime: 'video/mp4' | 'video/webm';
  w: number; h: number;
  /** Seconds. */
  duration: number;
  method: ReelMethod;
  /** Whether the result has a sound track. */
  audio: boolean;
}

export class ReelEncodeError extends Error {
  constructor(public reason: 'unsupported' | 'decode' | 'stalled' | 'failed') { super(`reel encode: ${reason}`); this.name = 'ReelEncodeError'; }
}

const abortError = () => new DOMException('Cancelled.', 'AbortError');
export const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

// MediaStreamTrackProcessor is not in TypeScript's DOM library yet.
interface TrackProcessor<T> { readable: ReadableStream<T> }
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => TrackProcessor<AudioData>;
const trackProcessor = (): TrackProcessorCtor | null =>
  (typeof window !== 'undefined' ? (window as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor ?? null : null);

/** What this device can re-encode with (decided without touching the video). */
export function encodeSupport(): { webcodecs: boolean; recorder: boolean } {
  if (typeof window === 'undefined' || typeof document === 'undefined') return { webcodecs: false, recorder: false };
  const rvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  // The sound needs an AudioEncoder and a way to read the captured track; a browser with only the video half
  // of WebCodecs records instead, rather than producing a silent reel.
  const webcodecs = typeof VideoEncoder === 'function' && typeof VideoFrame === 'function' && rvfc
    && typeof AudioEncoder === 'function' && typeof AudioData === 'function' && !!trackProcessor();
  const recorder = typeof MediaRecorder === 'function' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  return { webcodecs, recorder };
}

// ------------------------------------------------------------------------------------- the source
function once(el: EventTarget, event: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new ReelEncodeError('stalled')); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new ReelEncodeError('decode')); };
    const stop = () => { cleanup(); reject(abortError()); };
    const cleanup = () => {
      clearTimeout(timer); el.removeEventListener(event, ok); el.removeEventListener('error', bad); signal?.removeEventListener('abort', stop);
    };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
    signal?.addEventListener('abort', stop, { once: true });
  });
}

interface Source {
  video: HTMLVideoElement;
  /** The video's sound as a track (null when this browser can't route it; the result is then silent). */
  audioTrack: MediaStreamTrack | null;
  sampleRate: number;
  close: () => void;
}

type AudioCtor = typeof AudioContext;

/** A <video> playing the file, seeked to `start`, with its sound routed into a capture track instead of the speakers. */
async function openSource(file: Blob, start: number, mount: HTMLElement | null | undefined, signal?: AbortSignal): Promise<Source> {
  if (signal?.aborted) throw abortError();
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.disablePictureInPicture = true;
  if (mount) video.className = 'k-reelmake-work';
  // Browsers only present (and so only hand us) frames of a video that is part of the page. Without a
  // preview slot it sits in a corner, two pixels large and next to invisible.
  else video.style.cssText = 'position:fixed;inset-block-end:0;inset-inline-start:0;inline-size:2px;block-size:2px;opacity:0.01;pointer-events:none;z-index:-1';
  video.setAttribute('aria-hidden', 'true');
  (mount ?? document.body).appendChild(video);
  let ctx: AudioContext | null = null;
  const close = () => {
    try { video.pause(); } catch { /* already gone */ }
    video.removeAttribute('src');
    try { video.load(); } catch { /* ignore */ }
    video.remove();
    URL.revokeObjectURL(url);
    void ctx?.close().catch(() => undefined);
  };
  try {
    const meta = once(video, 'loadedmetadata', 20_000, signal);
    video.src = url;
    await meta;
    if (!video.videoWidth || !video.videoHeight) throw new ReelEncodeError('decode');
    let audioTrack: MediaStreamTrack | null = null;
    let sampleRate = 48_000;
    const Ctor: AudioCtor | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (Ctor) {
      try {
        try { ctx = new Ctor({ sampleRate: 48_000 }); } catch { ctx = new Ctor(); }
        const node = ctx.createMediaElementSource(video);
        const dest = ctx.createMediaStreamDestination();
        node.connect(dest); // and NOT to ctx.destination: nothing is heard while the reel is made
        await ctx.resume().catch(() => undefined);
        audioTrack = dest.stream.getAudioTracks()[0] ?? null;
        sampleRate = ctx.sampleRate;
      } catch { audioTrack = null; }
    }
    // Without a capture graph the sound would come out of the speakers: keep it quiet (the reel is then silent).
    if (!audioTrack) video.muted = true;
    if (start > 0.01) {
      const seeked = once(video, 'seeked', 20_000, signal);
      video.currentTime = start;
      await seeked;
    }
    return { video, audioTrack, sampleRate, close };
  } catch (e) {
    close();
    throw e;
  }
}

/**
 * Play the source from where it stands to `end`, calling `onFrame(mediaTime)` for every frame shown.
 * Resolves when `end` (or the end of the file) is reached. Pauses while the page is hidden.
 * `onRunning(true|false)` follows whether the video is actually advancing (sound is captured only then).
 */
function playThrough(src: Source, start: number, end: number, signal: AbortSignal | undefined,
  onFrame: (mediaTime: number) => void, onRunning: (running: boolean) => void, onProgress?: (f: number) => void): Promise<void> {
  const v = src.video;
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let lastMove = Date.now();
    let handle = 0;
    const useRvfc = typeof (v as Partial<HTMLVideoElement>).requestVideoFrameCallback === 'function';
    const span = Math.max(0.05, end - start);
    const done = (err?: unknown) => {
      if (finished) return;
      finished = true;
      onRunning(false);
      clearInterval(watchdog);
      if (useRvfc) v.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle);
      for (const [ev, fn] of events) v.removeEventListener(ev, fn);
      document.removeEventListener('visibilitychange', onVisibility);
      signal?.removeEventListener('abort', onAbort);
      try { v.pause(); } catch { /* ignore */ }
      if (err) reject(err); else resolve();
    };
    const tick = (t: number) => {
      lastMove = Date.now();
      if (t >= end - 0.005) { onProgress?.(1); done(); return; }
      if (t >= start - 0.05) onFrame(t);
      onProgress?.(Math.min(1, Math.max(0, (t - start) / span)));
    };
    const loop = () => {
      if (finished) return;
      if (useRvfc) handle = v.requestVideoFrameCallback((_now, meta) => { if (!finished) { tick(meta.mediaTime); loop(); } });
      else handle = requestAnimationFrame(() => { if (!finished) { if (!v.paused && !v.seeking) tick(v.currentTime); loop(); } });
    };
    const onAbort = () => done(abortError());
    const onVisibility = () => {
      lastMove = Date.now();
      if (document.visibilityState === 'hidden') v.pause();
      else void v.play().catch(() => done(new ReelEncodeError('failed')));
    };
    const events: [string, () => void][] = [
      ['playing', () => { lastMove = Date.now(); onRunning(true); }],
      ['pause', () => onRunning(false)],
      ['waiting', () => onRunning(false)],
      ['ended', () => { onProgress?.(1); done(); }],
      ['error', () => done(new ReelEncodeError('decode'))],
      // Frame callbacks can stop a little before the trim end; the clock still gets there.
      ['timeupdate', () => { if (v.currentTime >= end - 0.005) { onProgress?.(1); done(); } }],
    ];
    for (const [ev, fn] of events) v.addEventListener(ev, fn);
    document.addEventListener('visibilitychange', onVisibility);
    signal?.addEventListener('abort', onAbort, { once: true });
    // No frame for a long time while the page is visible: the device can't play this file.
    const watchdog = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - lastMove > 20_000) done(new ReelEncodeError('stalled'));
    }, 2000);
    if (signal?.aborted) { done(abortError()); return; }
    loop();
    if (document.visibilityState !== 'hidden') v.play().catch(() => done(new ReelEncodeError('failed')));
  });
}

// ------------------------------------------------------------------------------------- 1. WebCodecs
interface VideoChoice { config: VideoEncoderConfig; mux: 'avc' | 'vp9' }
interface AudioChoice { config: AudioEncoderConfig; mux: 'aac' | 'opus' }

async function pickVideo(t: ReelTarget): Promise<VideoChoice | null> {
  const base = { width: t.w, height: t.h, bitrate: t.videoBps, framerate: t.fps, latencyMode: 'quality' as const };
  const list: VideoChoice[] = [
    ...['avc1.640028', 'avc1.4d0028', 'avc1.42001f'].map((codec) => ({ mux: 'avc' as const, config: { ...base, codec, avc: { format: 'avc' as const } } })),
    { mux: 'vp9', config: { ...base, codec: 'vp09.00.31.08' } },
  ];
  // Constant bitrate keeps the file near the size that was promised (a "variable" encoder spends twice the
  // target on a busy picture); where an encoder only offers variable, that is used.
  for (const c of list) {
    for (const bitrateMode of ['constant', 'variable'] as const) {
      const config = { ...c.config, bitrateMode };
      try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { ...c, config }; } catch { /* try the next one */ }
    }
  }
  return null;
}

async function pickAudio(sampleRate: number, bitrate: number): Promise<AudioChoice | null> {
  if (typeof AudioEncoder !== 'function' || typeof AudioData !== 'function') return null;
  const list: AudioChoice[] = [
    { mux: 'aac', config: { codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate } },
    { mux: 'opus', config: { codec: 'opus', sampleRate, numberOfChannels: 2, bitrate } },
  ];
  for (const c of list) {
    try { if ((await AudioEncoder.isConfigSupported(c.config)).supported) return c; } catch { /* try the next one */ }
  }
  return null;
}

async function viaWebCodecs(input: EncodeInput): Promise<EncodedReel> {
  const { target: t, start, end, signal } = input;
  const choice = await pickVideo(t);
  if (!choice) throw new ReelEncodeError('unsupported');
  const src = await openSource(input.file, start, input.mount, signal);
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(t.w, t.h) : Object.assign(document.createElement('canvas'), { width: t.w, height: t.h });
  const g = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  let failure: unknown = null;
  const vChunks: { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }[] = [];
  const aChunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];
  const venc = new VideoEncoder({ output: (chunk, meta) => { vChunks.push({ chunk, meta }); }, error: (e) => { failure = e; } });
  let aenc: AudioEncoder | null = null;
  let reader: ReadableStreamDefaultReader<AudioData> | null = null;
  let pump: Promise<void> = Promise.resolve();
  try {
    if (!g) throw new ReelEncodeError('unsupported');
    venc.configure(choice.config);

    // Sound: captured only while the video is actually advancing, and stamped by counting samples, so a
    // pause (the page was hidden) leaves no gap and no drift.
    const Processor = trackProcessor();
    const audio = src.audioTrack && Processor ? await pickAudio(src.sampleRate, t.audioBps) : null;
    if (src.audioTrack && !audio) throw new ReelEncodeError('unsupported'); // record instead: never drop the sound quietly
    let running = false;
    let heard = false;
    if (audio && src.audioTrack && Processor) {
      const enc = new AudioEncoder({ output: (chunk, meta) => { aChunks.push({ chunk, meta }); }, error: (e) => { failure = e; } });
      enc.configure(audio.config);
      aenc = enc;
      const r = new Processor({ track: src.audioTrack }).readable.getReader();
      reader = r;
      let frames = 0;
      pump = (async () => {
        for (;;) {
          const { done, value } = await r.read();
          if (done || !value) break;
          try {
            if (!running || enc.state !== 'configured') continue;
            const n = value.numberOfFrames;
            const channels = Math.min(2, value.numberOfChannels);
            const pcm = new Float32Array(n * 2);
            for (let c = 0; c < 2; c++) value.copyTo(pcm.subarray(c * n, (c + 1) * n), { planeIndex: Math.min(c, channels - 1), format: 'f32-planar' });
            if (!heard) for (let i = 0; i < pcm.length; i += 16) if (Math.abs(pcm[i]!) > 1e-4) { heard = true; break; }
            const data = new AudioData({ format: 'f32-planar', sampleRate: value.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((frames / value.sampleRate) * 1e6), data: pcm });
            frames += n;
            enc.encode(data);
            data.close();
          } finally { value.close(); }
        }
      })().catch(() => undefined);
    }

    const gap = 1 / t.fps;
    let lastTime = -1;
    let lastStamp = -1;
    let lastKey = -Infinity;
    let frames = 0;
    await playThrough(src, start, end, signal, (mediaTime) => {
      if (failure || venc.state !== 'configured') return;
      // At most `fps` frames a second, and none while the encoder is behind (a dropped frame beats a stall).
      if (lastTime >= 0 && mediaTime - lastTime < gap * 0.8) return;
      if (venc.encodeQueueSize > 8) return;
      const stamp = frames === 0 ? 0 : Math.round((mediaTime - start) * 1e6);
      if (stamp <= lastStamp) return;
      g.drawImage(src.video, 0, 0, t.w, t.h);
      const frame = new VideoFrame(canvas as CanvasImageSource, { timestamp: stamp });
      const keyFrame = stamp - lastKey >= 2_000_000;
      if (keyFrame) lastKey = stamp;
      venc.encode(frame, { keyFrame });
      frame.close();
      frames++; lastTime = mediaTime; lastStamp = stamp;
    }, (r) => { running = r; }, input.onProgress);
    if (failure) throw failure;
    if (!frames) throw new ReelEncodeError('decode');

    await venc.flush();
    await reader?.cancel().catch(() => undefined);
    await pump;
    if (aenc && aenc.state === 'configured') await aenc.flush();
    if (failure) throw failure;
    if (signal?.aborted) throw abortError();

    const withAudio = !!audio && heard && aChunks.length > 0;
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: choice.mux, width: t.w, height: t.h, frameRate: t.fps },
      ...(withAudio ? { audio: { codec: audio.mux, numberOfChannels: 2, sampleRate: src.sampleRate } } : {}),
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    // Interleaved by time, as a player expects.
    let a = 0;
    for (const v of vChunks) {
      while (withAudio && a < aChunks.length && aChunks[a]!.chunk.timestamp <= v.chunk.timestamp) { muxer.addAudioChunk(aChunks[a]!.chunk, aChunks[a]!.meta); a++; }
      muxer.addVideoChunk(v.chunk, v.meta);
    }
    while (withAudio && a < aChunks.length) { muxer.addAudioChunk(aChunks[a]!.chunk, aChunks[a]!.meta); a++; }
    muxer.finalize();
    const duration = Math.max(gap, (lastStamp / 1e6) + gap);
    return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), mime: 'video/mp4', w: t.w, h: t.h, duration: Math.round(duration * 10) / 10, method: 'webcodecs', audio: withAudio };
  } finally {
    await reader?.cancel().catch(() => undefined);
    try { if (venc.state !== 'closed') venc.close(); } catch { /* ignore */ }
    try { if (aenc && aenc.state !== 'closed') aenc.close(); } catch { /* ignore */ }
    src.close();
  }
}

// ------------------------------------------------------------------------------------- 2. MediaRecorder
const RECORDER_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
];

export function recorderType(): string | null {
  if (typeof MediaRecorder !== 'function') return null;
  return RECORDER_TYPES.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) ?? null;
}

async function viaRecorder(input: EncodeInput): Promise<EncodedReel> {
  const { target: t, start, end, signal } = input;
  const type = recorderType();
  if (!type) throw new ReelEncodeError('unsupported');
  const src = await openSource(input.file, start, input.mount, signal);
  let rec: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = t.w; canvas.height = t.h;
    const g = canvas.getContext('2d', { alpha: false });
    if (!g) throw new ReelEncodeError('unsupported');
    g.drawImage(src.video, 0, 0, t.w, t.h);
    stream = canvas.captureStream(t.fps);
    if (src.audioTrack) stream.addTrack(src.audioTrack);
    const parts: Blob[] = [];
    let failure: unknown = null;
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: t.videoBps, audioBitsPerSecond: t.audioBps });
    rec = recorder;
    recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    recorder.onerror = () => { failure = new ReelEncodeError('failed'); };
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    let first = -1;
    let last = 0;
    await playThrough(src, start, end, signal, (mediaTime) => {
      g.drawImage(src.video, 0, 0, t.w, t.h);
      if (first < 0) first = mediaTime;
      last = mediaTime;
    }, (running) => {
      // Record exactly while the video advances.
      try {
        if (running && recorder.state === 'inactive') recorder.start(1000);
        else if (running && recorder.state === 'paused') recorder.resume();
        else if (!running && recorder.state === 'recording') recorder.pause();
      } catch { failure = new ReelEncodeError('failed'); }
    }, input.onProgress);
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    if (failure) throw failure;
    if (signal?.aborted) throw abortError();
    const mime = type.startsWith('video/mp4') ? 'video/mp4' : 'video/webm';
    const blob = new Blob(parts, { type: mime });
    if (!blob.size || first < 0) throw new ReelEncodeError('decode');
    const duration = Math.max(0.1, last - first + 1 / t.fps);
    return { blob, mime, w: t.w, h: t.h, duration: Math.round(duration * 10) / 10, method: 'recorder', audio: !!src.audioTrack };
  } finally {
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    stream?.getVideoTracks().forEach((tr) => tr.stop());
    src.close();
  }
}

// ------------------------------------------------------------------------------------- entry points
/**
 * Re-encode the trimmed part of a video for a reel. Tries WebCodecs, then MediaRecorder; throws
 * ReelEncodeError('unsupported') when the device has neither, and an AbortError when cancelled.
 * `only`: use just this method (tests, and the retry at a lower bitrate).
 */
export async function encodeReel(input: EncodeInput, only?: Exclude<ReelMethod, 'original'>): Promise<EncodedReel> {
  const sup = encodeSupport();
  let last: unknown = new ReelEncodeError('unsupported');
  if (sup.webcodecs && only !== 'recorder') {
    try { return await viaWebCodecs(input); } catch (e) { if (isAbort(e)) throw e; last = e; }
    input.onProgress?.(0);
  }
  if (sup.recorder && only !== 'webcodecs') {
    try { return await viaRecorder(input); } catch (e) { if (isAbort(e)) throw e; last = e; }
  }
  if (last instanceof ReelEncodeError) throw last;
  throw new ReelEncodeError('failed');
}

export interface SourceInfo { duration: number; w: number; h: number }

/** Duration and size of a picked video, or null when this device can't play it. */
export async function probeSource(file: Blob): Promise<SourceInfo | null> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'metadata';
  try {
    const meta = once(v, 'loadedmetadata', 20_000);
    v.src = url;
    await meta;
    // Recordings made in the browser often carry no duration: seeking far ahead makes it known.
    if (v.duration === Infinity) {
      try { const changed = once(v, 'durationchange', 10_000); v.currentTime = 1e9; await changed; } catch { /* stays unknown */ }
    }
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    if (!duration || !v.videoWidth || !v.videoHeight) return null;
    return { duration, w: v.videoWidth, h: v.videoHeight };
  } catch {
    return null;
  } finally {
    v.removeAttribute('src');
    try { v.load(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  }
}

/** The frame showing in a <video> right now as a JPEG of at most `maxSide` pixels (the reel's cover). */
export async function grabCover(video: HTMLVideoElement, maxSide = 720): Promise<PreparedImage | null> {
  const w0 = video.videoWidth;
  const h0 = video.videoHeight;
  if (!w0 || !h0) return null;
  const scale = Math.min(1, maxSide / Math.min(w0, h0), (maxSide * 16) / 9 / Math.max(w0, h0));
  const w = Math.max(2, Math.round(w0 * scale));
  const h = Math.max(2, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d', { alpha: false });
  if (!g) return null;
  try {
    g.drawImage(video, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
    return blob ? { blob, w, h } : null;
  } catch {
    return null;
  }
}
