'use client';
// Mounted once in the root layout: listens for incoming calls while the app is unlocked (never in the
// duress decoy), answers "is it still ringing?" for pushes (?call=<id> on a chat link), and shows the call
// screens above whatever page is open, so a call survives navigating around the app.
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useLocale } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { useAppLock } from '@/lib/safety/applock';
import { calls, useCall } from '@/lib/calls/engine';
import { CallScreens } from './CallScreens';

const CHAT = /^\/messages\/([0-9a-f-]{36})$/;

function probeFrom(url: string, replace: boolean) {
  let u: URL;
  try { u = new URL(url, window.location.origin); } catch { return; }
  const call = u.searchParams.get('call');
  const m = CHAT.exec(u.pathname);
  if (!call || !m) return;
  void calls.probe(m[1]!, call);
  if (replace) {
    u.searchParams.delete('call');
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
  }
}

export function CallRoot() {
  useLocale();
  const { status, userId } = useSession();
  const { decoy } = useAppLock();
  const path = usePathname();
  const s = useCall();
  const ready = status === 'ready' && !!userId && !decoy;

  useEffect(() => {
    if (ready) calls.start(userId!);
    else if (calls.running) { calls.hangup(); calls.stop(); }
  }, [ready, userId]);

  // Opened from a call push: the URL carries ?call=<id>.
  useEffect(() => { if (ready) probeFrom(window.location.href, true); }, [ready, path]);

  // A push tapped while the app is already open (the service worker posts kw:navigate).
  useEffect(() => {
    if (!ready || !('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type === 'kw:navigate' && typeof d.url === 'string') probeFrom(d.url, false);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [ready]);

  // The same from the native app's notification plugin (components/push/PushManager re-broadcasts it).
  useEffect(() => {
    if (!ready) return;
    const onNav = (e: Event) => {
      const url = (e as CustomEvent<{ url?: unknown }>).detail?.url;
      if (typeof url === 'string') probeFrom(url, false);
    };
    window.addEventListener('kw:navigate', onNav);
    return () => window.removeEventListener('kw:navigate', onNav);
  }, [ready]);

  if (!ready || s.m.phase === 'idle') return null;
  return <div className="kw k-call-root"><CallScreens s={s} /></div>;
}
