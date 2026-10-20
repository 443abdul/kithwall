'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSession } from '@/lib/keys/session';
import { LoadingScreen } from '@/components/ui/Spinner';
import { UnlockScreen } from '@/components/UnlockScreen';
import { AppShell } from './AppShell';

export function AppGate({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const router = useRouter();
  const path = usePathname() ?? '/home';
  useEffect(() => {
    if (status === 'signed_out') router.replace(`/signin?next=${encodeURIComponent(path)}`);
    else if (status === 'setup') router.replace('/setup'); // keys not created yet, or the 6-digit code is still needed
  }, [status, path, router]);
  if (status === 'ready') return <AppShell>{children}</AppShell>;
  if (status === 'locked') return <UnlockScreen />;
  return <LoadingScreen />;
}
