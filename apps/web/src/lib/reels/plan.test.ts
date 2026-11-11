// What a reel is encoded to (docs/v2/12-reels.md §2). Run: npx vitest run src/lib/reels
import { describe, expect, it } from 'vitest';
import { cipherSize } from '../media';
import {
  clampTrim, estimateBytes, initialTrim, maxVideoBytes, originalVerdict, planEncode, REEL_COVER_ALLOWANCE, REEL_MAX_SECONDS, targetSize, videoBitrate,
} from './plan';

describe('reel encoding plan', () => {
  it('fits 720p either way round, never scales up, keeps even sides', () => {
    expect(targetSize(1080, 1920)).toEqual({ w: 720, h: 1280 });
    expect(targetSize(1920, 1080)).toEqual({ w: 1280, h: 720 });
    expect(targetSize(2160, 3840)).toEqual({ w: 720, h: 1280 });
    expect(targetSize(480, 854)).toEqual({ w: 480, h: 854 });
    expect(targetSize(1080, 1080)).toEqual({ w: 720, h: 720 });
    expect(targetSize(1080, 2400)).toEqual({ w: 576, h: 1280 }); // a tall phone screen: the long side decides
    expect(targetSize(641, 479)).toEqual({ w: 642, h: 480 });
    expect(targetSize(1080, 1920, true)).toEqual({ w: 540, h: 960 });
    expect(targetSize(0, 0)).toEqual({ w: 720, h: 1280 });
  });

  it('aims at five to eight megabytes a minute at 720p', () => {
    const t = planEncode(1080, 1920);
    expect(t).toMatchObject({ w: 720, h: 1280, fps: 30 });
    const perMinute = estimateBytes(60, t) / 1_000_000;
    expect(perMinute).toBeGreaterThan(5);
    expect(perMinute).toBeLessThan(8);
    // Data Saver: smaller picture, well under five.
    expect(estimateBytes(60, planEncode(1080, 1920, true)) / 1_000_000).toBeLessThan(5);
    // A small video doesn't get a 720p bitrate, and nothing goes below a watchable floor.
    expect(videoBitrate(360, 640)).toBeLessThan(videoBitrate(720, 1280));
    expect(videoBitrate(100, 100)).toBe(250_000);
  });

  it('a whole minute fits the cap with room to spare', () => {
    const max = maxVideoBytes(16);
    expect(estimateBytes(REEL_MAX_SECONDS, planEncode(1080, 1920))).toBeLessThan(max / 2);
    // The stored ciphertext of the largest allowed video plus the cover stays within the 16 MiB cap.
    expect(cipherSize(max) + REEL_COVER_ALLOWANCE).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it('trims to at most a minute and at least a second, inside the video', () => {
    expect(initialTrim(200)).toEqual({ start: 0, end: 60 });
    expect(initialTrim(12.345)).toEqual({ start: 0, end: 12.35 });
    // Dragging the end past a minute pulls the start along; dragging the start pulls the end.
    expect(clampTrim(10, 100, 200, 'end')).toEqual({ start: 40, end: 100 });
    expect(clampTrim(10, 100, 200, 'start')).toEqual({ start: 10, end: 70 });
    expect(clampTrim(50, 50.2, 200, 'end')).toEqual({ start: 49.2, end: 50.2 });
    expect(clampTrim(50, 50.2, 200, 'start')).toEqual({ start: 50, end: 51 });
    expect(clampTrim(-5, 999, 30)).toEqual({ start: 0, end: 30 });
    expect(clampTrim(29.8, 30, 30, 'start')).toEqual({ start: 29, end: 30 });
    expect(clampTrim(NaN, NaN, 20)).toEqual({ start: 0, end: 20 });
  });

  it('lets an original through only when it is whole, short, small and a common format', () => {
    const max = maxVideoBytes(16);
    const whole = { start: 0, end: 20 };
    expect(originalVerdict({ size: 4_000_000, mime: 'video/mp4' }, 20, whole, max)).toBe('ok');
    expect(originalVerdict({ size: 4_000_000, mime: 'video/quicktime' }, 20, whole, max)).toBe('type');
    expect(originalVerdict({ size: 40_000_000, mime: 'video/mp4' }, 20, whole, max)).toBe('too_big');
    expect(originalVerdict({ size: 4_000_000, mime: 'video/webm' }, 75, { start: 0, end: 60 }, max)).toBe('too_long');
    expect(originalVerdict({ size: 4_000_000, mime: 'video/mp4' }, 20, { start: 3, end: 20 }, max)).toBe('trimmed');
    expect(originalVerdict({ size: 4_000_000, mime: 'video/mp4' }, undefined, whole, max)).toBe('too_long');
  });
});
