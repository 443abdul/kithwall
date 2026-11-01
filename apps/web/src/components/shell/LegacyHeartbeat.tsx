'use client';
// Opening the signed-in app keeps a legacy contact on hold (lib/legacy/legacy.ts legacyHeartbeat): at most once
// a UTC day per device, also when the app comes back to the foreground after a long time in the background.
// Renders nothing. Not mounted in the decoy app (components/safety/DecoyApp), which never loads real data.
import { useEffect } from 'react';
import { useSession } from '@/lib/keys/session';
import { legacyHeartbeat } from '@/lib/legacy/legacy';

export function LegacyHeartbeat() {
  const { status, userId } = useSession();
  useEffect(() => {
    if (status !== 'ready' || !userId) return;
    void legacyHeartbeat();
    const onVisible = () => { if (document.visibilityState === 'visible') void legacyHeartbeat(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [status, userId]);
  return null;
}
