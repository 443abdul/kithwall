'use client';
// Messenger runtime bits (Kithwall 2):
//  - typing indicators run over the signed, content-free Realtime inbox (lib/chat/signals.ts), and
//    only while the person has turned them on (default off). Nothing is broadcast otherwise.
//  - the on-screen keyboard: keeps the chat exactly as tall as the visible viewport;
//  - swipe from the starting edge to go back to the list (phones).
import { useEffect, useRef, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/keys/session';
import { useFriendIds } from '@/lib/hooks';
import { signals } from '@/lib/chat/signals';
import { useConversationList } from './ChatList';

export function useChatRuntime(typing: boolean) {
  const { status, userId } = useSession();
  const friends = useFriendIds();
  const convs = useConversationList();
  const on = typing && status === 'ready' && !!userId;
  useEffect(() => {
    if (!on) { if (signals.running) signals.stop(); return; }
    signals.start(userId!);
  }, [on, userId]);
  useEffect(() => { if (on && friends.data) signals.setFriends(friends.data); }, [on, friends.data]);
  useEffect(() => { if (on && convs.data) signals.setConversations(convs.data); }, [on, convs.data]);
}

/** Sets --k-vvh on the element to the visible viewport height (shrinks when the keyboard opens). */
export function useVisualViewportHeight(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const el = ref.current;
    if (!vv || !el) return;
    let raf = 0;
    const apply = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.setProperty('--k-vvh', `${Math.round(vv.height)}px`);
        el.style.setProperty('--k-vvtop', `${Math.round(vv.offsetTop)}px`);
      });
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => { cancelAnimationFrame(raf); vv.removeEventListener('resize', apply); vv.removeEventListener('scroll', apply); };
  }, [ref]);
}

/** Swipe from the inline-start edge (left in LTR, right in RTL) to `href`. Phones only. */
export function useSwipeBack(ref: RefObject<HTMLElement | null>, href: string) {
  const router = useRouter();
  const start = useRef<{ x: number; y: number; t: number; rtl: boolean } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const EDGE = 28;
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1 || window.innerWidth >= 768) { start.current = null; return; }
      const tch = e.touches[0]!;
      const rtl = getComputedStyle(el).direction === 'rtl';
      const fromEdge = rtl ? window.innerWidth - tch.clientX : tch.clientX;
      start.current = fromEdge <= EDGE ? { x: tch.clientX, y: tch.clientY, t: Date.now(), rtl } : null;
    };
    const up = (e: TouchEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const tch = e.changedTouches[0];
      if (!tch) return;
      const dx = (tch.clientX - s.x) * (s.rtl ? -1 : 1);
      const dy = Math.abs(tch.clientY - s.y);
      if (dx > 80 && dy < 60 && Date.now() - s.t < 800) router.push(href);
    };
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchend', up, { passive: true });
    return () => { el.removeEventListener('touchstart', down); el.removeEventListener('touchend', up); };
  }, [ref, href, router]);
}
