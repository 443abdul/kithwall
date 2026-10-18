'use client';
// Pull-to-refresh for the phone UI. The browser's own pull-to-reload is disabled in CSS
// (overscroll-behavior), because a full reload would lock the encryption keys unless
// "Keep me logged in" is on. Instead we refetch data in place.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

const TRIGGER = 72;   // px of (damped) pull needed to refresh
const MAX = 110;

export function PullToRefresh() {
  const qc = useQueryClient();
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<{ y: number; x: number } | null>(null);
  const active = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    const phone = window.matchMedia('(max-width: 767px)');
    const blocked = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      // Not while a dialog/sheet/menu is open, or inside things that scroll on their own.
      return !!document.querySelector('.ov, .kw-menu, [role="dialog"]')
        || !!el?.closest('textarea, input, select, .kp-stage, .kwm-thread, [data-no-ptr]');
    };
    const onStart = (e: TouchEvent) => {
      if (!phone.matches || busyRef.current || e.touches.length !== 1 || window.scrollY > 0 || blocked(e.target)) { start.current = null; return; }
      start.current = { y: e.touches[0]!.clientY, x: e.touches[0]!.clientX };
      active.current = false;
    };
    const onMove = (e: TouchEvent) => {
      const s = start.current;
      if (!s) return;
      const dy = e.touches[0]!.clientY - s.y;
      const dx = e.touches[0]!.clientX - s.x;
      if (!active.current) {
        if (dy < 6 || Math.abs(dx) > Math.abs(dy) || window.scrollY > 0) { if (dy < 0 || Math.abs(dx) > 10) start.current = null; return; }
        active.current = true;
      }
      e.preventDefault(); // we own this gesture now (stops the page from scrolling)
      setPull(Math.min(MAX, dy * 0.5));
    };
    const onEnd = () => {
      if (!start.current || !active.current) { start.current = null; return; }
      start.current = null; active.current = false;
      setPull((p) => {
        if (p >= TRIGGER) void refresh();
        return p >= TRIGGER ? TRIGGER : 0;
      });
    };
    const refresh = async () => {
      busyRef.current = true; setBusy(true);
      const minDelay = new Promise((r) => setTimeout(r, 600));
      try {
        window.dispatchEvent(new Event('kw:refresh'));
        await Promise.all([qc.invalidateQueries({ refetchType: 'active' }), minDelay]);
      } finally {
        busyRef.current = false; setBusy(false); setPull(0);
        if (navigator.vibrate) navigator.vibrate(8);
      }
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [qc]);

  const shown = busy || pull > 0;
  const progress = Math.min(1, pull / TRIGGER);
  return (
    <div className={`m-ptr${shown ? ' on' : ''}${busy ? ' busy' : ''}`} aria-hidden={!busy} role="status" aria-live="polite"
      style={{ transform: `translate(-50%, ${busy ? TRIGGER - 24 : pull - 24}px)`, opacity: busy ? 1 : progress }}>
      <svg viewBox="0 0 24 24" style={{ transform: busy ? undefined : `rotate(${progress * 270}deg)` }}>
        <path d="M20 12a8 8 0 1 1-2.34-5.66" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M20 4v4.5h-4.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {busy ? <span className="sr-only">Refreshing</span> : null}
    </div>
  );
}
