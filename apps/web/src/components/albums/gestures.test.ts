import { describe, expect, it } from 'vitest';
import { clampPan, clampZoom, formatDuration, pinchZoom, queueProgress, swipeAction } from './gestures';

describe('viewer gestures', () => {
  it('zooms within bounds', () => {
    expect(pinchZoom(1, 100, 200)).toBe(2);
    expect(pinchZoom(2, 100, 1000)).toBe(4);
    expect(pinchZoom(1, 100, 50)).toBe(1);
    expect(pinchZoom(1.5, 0, 10)).toBe(1.5);
    expect(clampZoom(9)).toBe(4);
  });

  it('reads swipes', () => {
    expect(swipeAction(-200, 10, 400, 400)).toBe('next');
    expect(swipeAction(200, 10, 400, 400)).toBe('prev');
    expect(swipeAction(-60, 5, 150, 400)).toBe('next'); // quick flick
    expect(swipeAction(-60, 5, 600, 400)).toBeNull();
    expect(swipeAction(10, 160, 500, 400)).toBe('close');
    expect(swipeAction(10, -160, 500, 400)).toBeNull();
    expect(swipeAction(200, 10, 400, 400, true)).toBe('next'); // RTL
  });

  it('keeps pans inside the stage', () => {
    expect(clampPan(500, -500, 2, 400, 300)).toEqual({ x: 200, y: -150 });
    expect(clampPan(10, 10, 1, 400, 300)).toEqual({ x: 0, y: 0 });
  });

  it('formats durations', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(undefined)).toBe('');
  });

  it('sums queue progress', () => {
    expect(queueProgress([])).toBe(0);
    expect(queueProgress([{ progress: 0.5, state: 'uploading' }, { progress: 0, state: 'done' }])).toBe(0.75);
  });
});
