'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from '@/lib/keys/session';
import { useAppLock } from '@/lib/safety/applock';
import { LoadingScreen } from '@/components/ui/Spinner';
import { UnlockScreen } from '@/components/UnlockScreen';
import { PinLockScreen } from '@/components/safety/PinLockScreen';
import { DecoyApp } from '@/components/safety/DecoyApp';
import { SafetyRuntime } from '@/components/safety/SafetyRuntime';
import { AppShell } from './AppShell';

export function AppGate({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const { decoy, pin } = useAppLock();
  // "Use a passkey or passphrase instead" on the PIN screen.
  const [otherUnlock, setOtherUnlock] = useState(false);
  const router = useRouter();
  const path = usePathname() ?? '/home';
  useEffect(() => {
    if (decoy) return; // the duress decoy stays up even after its background wipe signs this device out
    if (status === 'signed_out') router.replace(`/signin?next=${encodeURIComponent(path)}`);
    else if (status === 'setup') router.replace('/setup'); // the 6-digit code is still needed
  }, [status, path, router, decoy]);
  let screen: ReactNode;
  // Safety centre: a duress PIN shows the decoy instead of the real screens (which never mount).
  if (decoy) screen = <DecoyApp info={decoy} />;
  else if (status === 'ready') screen = <AppShell>{children}</AppShell>;
  else if (status === 'locked' && pin === 'set' && !otherUnlock) screen = <PinLockScreen onUseOther={() => setOtherUnlock(true)} />;
  else if (status === 'locked' && pin !== 'unknown') screen = <UnlockScreen />;
  else screen = <LoadingScreen />;
  return <>{screen}<SafetyRuntime /></>;
}
