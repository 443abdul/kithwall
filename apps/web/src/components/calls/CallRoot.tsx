'use client';
// Mounted once in the root layout. The call engine (WebRTC, signalling, call screens and the chat code
// they use) is only needed while the app is unlocked, so it is loaded then instead of with every page:
// ./CallRuntime listens for incoming calls and shows the call screens above whatever page is open.
// Once loaded it stays mounted, so it can also hang up and stop the engine when the app locks.
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { useSession } from '@/lib/keys/session';
import { useAppLock } from '@/lib/safety/applock';

const CallRuntime = dynamic(() => import('./CallRuntime').then((m) => m.CallRuntime), { ssr: false });

export function CallRoot() {
  const { status, userId } = useSession();
  const { decoy } = useAppLock();
  const ready = status === 'ready' && !!userId && !decoy;
  const [wanted, setWanted] = useState(false);
  if (ready && !wanted) setWanted(true);
  return wanted ? <CallRuntime /> : null;
}
