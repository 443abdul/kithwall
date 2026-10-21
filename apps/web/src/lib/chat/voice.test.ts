import { describe, expect, it } from 'vitest';
import {
  baseAudioMime, clockParts, computePeaks, decodePeaks, encodePeaks, MAX_VOICE_SECS, nextRate, pickVoiceMime,
  readVoiceMeta, resamplePeaks, roundDuration, seekFraction, VOICE_PEAKS, voiceMeta,
} from './voice';

describe('voice notes: waveform peaks', () => {
  it('makes 64 bytes from any number of samples, loudest bar at full height', () => {
    const levels = Array.from({ length: 1000 }, (_, i) => (i === 500 ? 0.8 : 0.1));
    const p = computePeaks(levels);
    expect(p).toHaveLength(VOICE_PEAKS);
    expect(Math.max(...p)).toBe(255);
    expect(p[32]).toBe(255); // sample 500 of 1000 lands in bucket 32
    expect(p[0]).toBeGreaterThan(8);
    expect(p[0]).toBeLessThan(255);
  });
  it('works with fewer samples than bars and with silence', () => {
    expect(computePeaks([0.2, 0.4])).toHaveLength(64);
    expect([...computePeaks([])].every((v) => v === 8)).toBe(true);
    expect([...computePeaks(new Array(300).fill(0))].every((v) => v === 8)).toBe(true);
  });
  it('ignores junk samples', () => {
    const p = computePeaks([NaN, Infinity, 0.5, -0.5]);
    expect([...p].every((v) => v >= 8 && v <= 255)).toBe(true);
  });
  it('round-trips through the payload and survives bad input', () => {
    const p = computePeaks(Array.from({ length: 200 }, (_, i) => Math.abs(Math.sin(i / 7))));
    const s = encodePeaks(p);
    expect(s.length).toBeLessThanOrEqual(88);
    expect(decodePeaks(s)).toEqual(p);
    expect(decodePeaks(undefined)).toHaveLength(64);
    expect(decodePeaks('not base64!')).toHaveLength(64);
    expect(decodePeaks(42)).toHaveLength(64);
    expect(decodePeaks(encodePeaks(new Uint8Array([10, 200, 30])))).toHaveLength(64);
  });
  it('resamples to other bar counts', () => {
    const p = new Uint8Array(64).map((_, i) => i * 4);
    const r = resamplePeaks(p, 32);
    expect(r).toHaveLength(32);
    expect(r[31]).toBe(252);
  });
});

describe('voice notes: duration and payload', () => {
  it('rounds and clamps the duration', () => {
    expect(roundDuration(12.345)).toBe(12.3);
    expect(roundDuration(999)).toBe(MAX_VOICE_SECS);
    expect(roundDuration(-3)).toBe(0);
    expect(roundDuration(NaN)).toBe(0);
  });
  it('builds and reads the encrypted payload metadata', () => {
    const meta = voiceMeta({ duration: 42.06, peaks: new Uint8Array(64).fill(100) });
    expect(meta.duration).toBe(42.1);
    expect(typeof meta.peaks).toBe('string');
    expect(readVoiceMeta(JSON.parse(JSON.stringify(meta)))).toEqual(meta);
  });
  it('rejects malformed metadata', () => {
    expect(readVoiceMeta(null)).toBeNull();
    expect(readVoiceMeta({ duration: 'long' })).toBeNull();
    expect(readVoiceMeta({ duration: -1 })).toBeNull();
    expect(readVoiceMeta({ duration: 10_000 })).toBeNull();
    expect(readVoiceMeta({ duration: 3 })).toEqual({ duration: 3, peaks: '' });
  });
  it('formats m:ss parts', () => {
    expect(clockParts(0)).toEqual({ m: 0, s: 0 });
    expect(clockParts(59.9)).toEqual({ m: 0, s: 59 });
    expect(clockParts(300)).toEqual({ m: 5, s: 0 });
    expect(clockParts(-4)).toEqual({ m: 0, s: 0 });
  });
});

describe('voice notes: formats, speed and seeking', () => {
  it('prefers Opus/WebM, falls back to MP4 (Safari)', () => {
    expect(pickVoiceMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickVoiceMime((t) => t.startsWith('audio/mp4'))).toBe('audio/mp4;codecs=mp4a.40.2');
    expect(pickVoiceMime(() => false)).toBe('');
    expect(pickVoiceMime(() => { throw new Error('x'); })).toBe('');
  });
  it('strips codec parameters and refuses non-audio types', () => {
    expect(baseAudioMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseAudioMime('audio/mp4')).toBe('audio/mp4');
    expect(baseAudioMime('text/html')).toBe('audio/webm');
    expect(baseAudioMime(undefined)).toBe('audio/webm');
  });
  it('cycles 1× → 1.5× → 2× → 1×', () => {
    expect(nextRate(1)).toBe(1.5);
    expect(nextRate(1.5)).toBe(2);
    expect(nextRate(2)).toBe(1);
    expect(nextRate(3)).toBe(1);
  });
  it('maps pointer positions to a fraction, mirrored in RTL', () => {
    expect(seekFraction(150, 100, 200, false)).toBe(0.25);
    expect(seekFraction(150, 100, 200, true)).toBe(0.75);
    expect(seekFraction(0, 100, 200, false)).toBe(0);
    expect(seekFraction(999, 100, 200, false)).toBe(1);
    expect(seekFraction(150, 100, 0, false)).toBe(0);
  });
});
