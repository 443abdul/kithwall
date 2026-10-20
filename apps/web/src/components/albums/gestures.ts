// Photo viewer gesture maths (pure; unit-tested in gestures.test.ts).

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** New zoom after a pinch from distance d0 (at zoom z0) to distance d1. */
export function pinchZoom(z0: number, d0: number, d1: number): number {
  if (d0 <= 0) return clampZoom(z0);
  return clampZoom(z0 * (d1 / d0));
}

/**
 * What a one-finger drag means when released, at zoom 1. `dx`/`dy` in px, `ms` duration, `width` of the
 * stage. In right-to-left layouts the "next" photo is to the left, so a swipe right goes forward.
 */
export function swipeAction(dx: number, dy: number, ms: number, width: number, rtl = false): 'next' | 'prev' | 'close' | null {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const fast = ms > 0 && ms < 300;
  if (ay > ax && dy > 0 && (dy > 120 || (fast && dy > 50))) return 'close';
  if (ax > ay && (ax > width * 0.25 || (fast && ax > 40))) {
    const forward = rtl ? dx > 0 : dx < 0;
    return forward ? 'next' : 'prev';
  }
  return null;
}

/** Keep a zoomed image's pan offset inside the stage. */
export function clampPan(x: number, y: number, zoom: number, w: number, h: number): { x: number; y: number } {
  const mx = ((zoom - 1) * w) / 2, my = ((zoom - 1) * h) / 2;
  return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) };
}

/** "1:05", "12:00", "1:02:03" for video durations in seconds. */
export function formatDuration(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** Overall progress (0..1) of an upload queue where each item reports 0..1. */
export function queueProgress(items: { progress: number; state: string }[]): number {
  if (!items.length) return 0;
  return items.reduce((a, i) => a + (i.state === 'done' || i.state === 'error' ? 1 : Math.min(1, Math.max(0, i.progress))), 0) / items.length;
}
