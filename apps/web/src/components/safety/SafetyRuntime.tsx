'use client';
// Always mounted by AppGate. Renders only the optional quick-exit button.
//  - Knows whether this device has an app PIN for the signed-in account (lib/safety/applock).
//  - Any lock (from here, Settings or elsewhere) reloads the page, so nothing decrypted stays in memory.
//  - Idle lock and "lock when hidden" (device preferences).
//  - Quick exit: shield button, triple tap on the logo, or Esc three times.
import { useEffect } from 'react';
import { useT } from '@/i18n';
import { onLock, useSession } from '@/lib/keys/session';
import { lockNow, refreshPinState, useAppLock, useExitPrefs, useLockPrefs } from '@/lib/safety/applock';
import { quickExit } from '@/lib/safety/quickexit';
import { Icon } from '@/components/ui/Icon';

const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function SafetyRuntime() {
  const t = useT();
  const { status, userId } = useSession();
  const { decoy } = useAppLock();
  const lockPrefs = useLockPrefs();
  const exit = useExitPrefs();

  useEffect(() => { if (status !== 'loading') void refreshPinState(userId); }, [status, userId]);

  // A lock anywhere drops every in-memory cache with a reload.
  useEffect(() => onLock((reason) => { if (reason === 'lock') setTimeout(() => location.reload(), 0); }), []);

  // Idle lock.
  useEffect(() => {
    if (status !== 'ready' || !lockPrefs.idleMinutes) return;
    const ms = lockPrefs.idleMinutes * 60_000;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    ACTIVITY.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const id = setInterval(() => { if (Date.now() - last >= ms) void lockNow(); }, 15_000);
    return () => { clearInterval(id); ACTIVITY.forEach((e) => window.removeEventListener(e, bump)); };
  }, [status, lockPrefs.idleMinutes]);

  // Lock when the app goes to the background.
  useEffect(() => {
    if (status !== 'ready' || !lockPrefs.onHide) return;
    const onHide = () => { if (document.visibilityState === 'hidden') void lockNow(); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [status, lockPrefs.onHide]);

  // Quick exit gestures.
  useEffect(() => {
    if (!exit.enabled || !exit.tripleTap) return;
    let taps: number[] = [];
    let escs: number[] = [];
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest('.k-logo, .k-topbar-brand, .k-rail-brand, .k-pub-head') : null;
      if (!el) return;
      const now = Date.now();
      taps = [...taps.filter((x) => now - x < 900), now];
      if (taps.length >= 2) e.preventDefault();
      if (taps.length >= 3) { taps = []; quickExit(); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const now = Date.now();
      escs = [...escs.filter((x) => now - x < 1200), now];
      if (escs.length >= 3) { escs = []; quickExit(); }
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKey, true); };
  }, [exit.enabled, exit.tripleTap]);

  if (!exit.enabled || !exit.button || decoy || status === 'signed_out') return null;
  return (
    <button type="button" className="kw-qx" onClick={quickExit} aria-label={t('safety.exit.button')} title={t('safety.exit.button')}>
      <Icon name="shield" />
    </button>
  );
}
