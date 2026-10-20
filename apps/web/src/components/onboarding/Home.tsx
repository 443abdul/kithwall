'use client';
// "/": the landing page for visitors; signed-in people go straight to /home.
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/lib/keys/session';
import { LoadingScreen } from '@/components/ui/Spinner';
import { Landing } from './Landing';

export function Home() {
  const { status } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === 'ready' || status === 'locked') router.replace('/home');
    else if (status === 'setup') router.replace('/welcome');
  }, [status, router]);
  if (status === 'signed_out') return <Landing />;
  return <LoadingScreen />;
}
