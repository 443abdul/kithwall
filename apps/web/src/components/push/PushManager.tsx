'use client';
// Mounted once from Providers. Renders nothing.
//  - Signed in: registers the push-only service worker and re-syncs this device's subscription if
//    the person turned push on here before (never prompts).
//  - Signed out: unsubscribes this browser so a shared device stops getting the last person's pushes.
//  - Handles "kw:navigate" from the service worker (notification clicks) with in-app navigation,
//    so the tab keeps its unlocked keys.
//  - Clears the installed app's icon badge while Kithwall is on screen.
//  - In the Kithwall app: notification taps arrive from the native push plugin instead; they get the
//    same in-app navigation and are re-broadcast as a 'kw:navigate' window event (components/calls/CallRuntime listens).
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/keys/session';
import { clearAppBadge, dropDeviceSubscription, registerServiceWorker, syncPush } from '@/lib/push';
import { isNative } from '@/lib/native';
import { safePath } from '@/lib/auth/next';

export function PushManager() {
  const router = useRouter();
  const { status, userId } = useSession();

  useEffect(() => {
    if (status === 'ready' && userId) {
      void registerServiceWorker()?.catch(() => undefined);
      void syncPush(userId).catch((e) => console.warn('push sync failed', (e as Error).message));
    } else if (status === 'signed_out') {
      // Also on a fresh load with no session: no one is signed in here, so nobody's pushes belong here.
      void dropDeviceSubscription();
    }
  }, [status, userId]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; url?: unknown } | null;
      if (!d || d.type !== 'kw:navigate') return;
      const url = safePath(d.url); // same-origin paths only (security review W1)
      if (url) router.push(url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [router]);

  useEffect(() => {
    if (!isNative()) return;
    let off: (() => void) | null = null;
    let live = true;
    void import('@/lib/native/push').then((m) => m.onNativeOpen((raw) => {
      const url = safePath(raw);
      if (!url) return;
      router.push(url);
      window.dispatchEvent(new CustomEvent('kw:navigate', { detail: { url } }));
    })).then((o) => { if (live) off = o; else o(); }).catch(() => undefined);
    return () => { live = false; off?.(); };
  }, [router]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') clearAppBadge(); };
    onVisible();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return null;
}
