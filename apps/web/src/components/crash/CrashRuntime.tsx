'use client';
// Crash reports (opt-in, off by default): while "Send crash reports" is on, loads the reporter and lets it
// listen for uncaught errors and unhandled rejections (lib/crash/client.ts). While it is off, nothing but the
// tiny preference check is loaded and nothing is listened to.
import { useEffect } from 'react';
import { useCrashReports } from '@/lib/crash/prefs';

export function CrashRuntime() {
  const on = useCrashReports();
  useEffect(() => {
    if (!on) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void import('@/lib/crash/client').then((m) => { if (!gone) stop = m.startCrashReporting(); }).catch(() => undefined);
    return () => { gone = true; stop?.(); };
  }, [on]);
  return null;
}
