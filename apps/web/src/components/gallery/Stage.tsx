'use client';
// Gesture stage for a photo, shared by the post / chat gallery (Gallery.tsx) and the album viewer
// (components/albums/MediaViewer.tsx): pinch, double-tap and wheel zoom, pan while zoomed, swipe left/right
// for the next / previous item, swipe down to close, single tap (e.g. show / hide the controls). The
// transform is applied straight to the element (no React re-render per pointer move). Maths in
// components/albums/gestures.ts.
import { useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from 'react';
import { cx } from '@/components/ui/cx';
import { clampPan, clampZoom, pinchZoom, swipeAction } from '@/components/albums/gestures';

export interface StageHandle {
  /** Multiply the zoom (keyboard + / - and the zoom buttons). */
  zoomBy: (factor: number) => void;
  reset: () => void;
}

export function Stage({ children, resetKey, rtl, tagMode = false, wheel = 'ctrl', onSwipe, onTap, onSingleTap, onZoom, handle, className }: {
  children: ReactNode;
  /** Zoom and pan reset whenever this changes (a new photo). */
  resetKey: string;
  rtl: boolean;
  /** Album tagging: taps report their position (onTap) and drags don't swipe. */
  tagMode?: boolean;
  /** 'ctrl': zoom with Ctrl/⌘ + wheel only (pages that scroll); 'always': the wheel zooms (full-screen viewers). */
  wheel?: 'ctrl' | 'always';
  onSwipe: (a: 'next' | 'prev' | 'close') => void;
  onTap?: (clientX: number, clientY: number) => void;
  /** A single tap that wasn't the first half of a double tap. */
  onSingleTap?: () => void;
  onZoom?: (zoom: number) => void;
  handle?: Ref<StageHandle>;
  className?: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const s = useRef({ zoom: 1, x: 0, y: 0, pts: new Map<number, { x: number; y: number }>(), sx: 0, sy: 0, st: 0, px: 0, py: 0, pd: 0, pz: 1, lastTap: 0, moved: false });
  const single = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cb = useRef({ onZoom, onSingleTap });
  useEffect(() => { cb.current = { onZoom, onSingleTap }; });

  const apply = (dx = 0, dy = 0, animate = false) => {
    const el = content.current;
    if (!el) return;
    const st = s.current;
    el.style.transition = animate ? 'transform 180ms ease, opacity 180ms ease' : 'none';
    el.style.transform = `translate(${st.x + dx}px, ${st.y + dy}px) scale(${st.zoom})`;
    el.style.opacity = dy > 0 && st.zoom === 1 ? String(Math.max(0.3, 1 - dy / 400)) : '1';
  };
  const setZoom = (z: number, animate = false) => {
    const st = s.current;
    const prev = st.zoom;
    st.zoom = clampZoom(z);
    if (st.zoom === 1) { st.x = 0; st.y = 0; }
    else {
      const r = stage.current?.getBoundingClientRect();
      if (r) { const p = clampPan(st.x, st.y, st.zoom, r.width, r.height); st.x = p.x; st.y = p.y; }
    }
    apply(0, 0, animate);
    if (prev !== st.zoom) cb.current.onZoom?.(st.zoom);
  };

  useImperativeHandle(handle, () => ({
    zoomBy: (f: number) => setZoom(s.current.zoom * f, true),
    reset: () => setZoom(1, true),
  }));

  useEffect(() => {
    const st = s.current;
    st.zoom = 1; st.x = 0; st.y = 0; st.pts.clear();
    apply(0, 0, false);
    cb.current.onZoom?.(1);
  }, [resetKey]);
  useEffect(() => () => { if (single.current) clearTimeout(single.current); }, []);

  const dist = () => {
    const [a, b] = [...s.current.pts.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  return (
    <div ref={stage} className={cx('kv-stage', tagMode && 'kv-stage-tag', className)}
      onPointerDown={(e) => {
        const st = s.current;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        st.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (st.pts.size === 1) { st.sx = e.clientX; st.sy = e.clientY; st.st = performance.now(); st.px = st.x; st.py = st.y; st.moved = false; }
        if (st.pts.size === 2) { st.pd = dist(); st.pz = st.zoom; st.moved = true; }
      }}
      onPointerMove={(e) => {
        const st = s.current;
        if (!st.pts.has(e.pointerId)) return;
        st.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const dx = e.clientX - st.sx, dy = e.clientY - st.sy;
        if (Math.hypot(dx, dy) > 6) st.moved = true;
        if (st.pts.size >= 2) { st.zoom = pinchZoom(st.pz, st.pd, dist()); apply(); return; }
        if (tagMode) return;
        if (st.zoom > 1) {
          const r = stage.current!.getBoundingClientRect();
          const p = clampPan(st.px + dx, st.py + dy, st.zoom, r.width, r.height);
          st.x = p.x; st.y = p.y; apply();
        } else if (Math.abs(dx) > Math.abs(dy)) apply(dx, 0);
        else if (dy > 0) apply(0, dy);
      }}
      onPointerUp={(e) => {
        const st = s.current;
        if (!st.pts.has(e.pointerId)) return;
        st.pts.delete(e.pointerId);
        if (st.pts.size) return;
        const dx = e.clientX - st.sx, dy = e.clientY - st.sy, ms = performance.now() - st.st;
        if (st.zoom <= 1.01) { st.zoom = 1; st.x = 0; st.y = 0; }
        cb.current.onZoom?.(st.zoom);
        if (!st.moved && ms < 300) {
          if (tagMode) { onTap?.(e.clientX, e.clientY); return; }
          const now = performance.now();
          if (now - st.lastTap < 300) {
            if (single.current) { clearTimeout(single.current); single.current = null; }
            st.lastTap = 0;
            setZoom(st.zoom > 1 ? 1 : 2, true);
            return;
          }
          st.lastTap = now;
          if (cb.current.onSingleTap) {
            if (single.current) clearTimeout(single.current);
            single.current = setTimeout(() => { single.current = null; cb.current.onSingleTap?.(); }, 300);
          }
          return;
        }
        if (st.zoom === 1 && !tagMode) {
          const a = swipeAction(dx, dy, ms, stage.current?.clientWidth ?? 400, rtl);
          if (a) { onSwipe(a); return; }
        }
        apply(0, 0, true);
      }}
      onPointerCancel={(e) => { s.current.pts.delete(e.pointerId); apply(0, 0, true); }}
      onWheel={(e) => {
        if (wheel === 'ctrl' && !e.ctrlKey && !e.metaKey) return;
        setZoom(s.current.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      }}>
      <div ref={content} className="kv-content">{children}</div>
    </div>
  );
}
