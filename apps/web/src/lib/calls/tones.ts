'use client';
// Ring and ring-back tones, synthesised with WebAudio (no audio files, nothing fetched).
//   incoming: a soft three-note chime every 3 s (and a vibration on phones)
//   outgoing: a quiet 425 Hz ring-back, 1 s on / 3 s off
// Browsers may refuse to start audio before the person has touched the page; then the call screen and the
// vibration still announce the call.

type Kind = 'incoming' | 'outgoing';

let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let playing: Kind | null = null;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  return ctx;
}

function note(c: AudioContext, freq: number, at: number, dur: number, gain: number) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(c.destination);
  o.start(at);
  o.stop(at + dur + 0.05);
}

function chime() {
  const c = context();
  if (c && c.state === 'running') {
    const t = c.currentTime + 0.02;
    note(c, 659.25, t, 0.45, 0.18);
    note(c, 783.99, t + 0.18, 0.45, 0.18);
    note(c, 987.77, t + 0.36, 0.7, 0.16);
  }
  // Browsers only allow vibration after the person has interacted with the page.
  const active = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;
  if (active) try { navigator.vibrate?.([300, 150, 300]); } catch { /* not supported */ }
}

function ringback() {
  const c = context();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime + 0.02;
  note(c, 425, t, 1.0, 0.06);
}

export function startTone(kind: Kind) {
  if (playing === kind) return;
  stopTone();
  playing = kind;
  const fn = kind === 'incoming' ? chime : ringback;
  fn();
  timer = setInterval(fn, kind === 'incoming' ? 3000 : 4000);
}

export function stopTone() {
  if (timer) clearInterval(timer);
  timer = null;
  playing = null;
  const active = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;
  if (active) try { navigator.vibrate?.(0); } catch { /* ignore */ }
}

/** A short two-note "call ended" sound. */
export function endTone() {
  const c = context();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime + 0.02;
  note(c, 523.25, t, 0.25, 0.1);
  note(c, 392, t + 0.2, 0.35, 0.1);
}
