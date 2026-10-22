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
    else if (status === 'setup') router.replace('/setup');
  }, [status, router]);
  // While the session is checked (server HTML and first paint) the landing page shows right away, unless
  // public/theme.js found a stored session: then CSS shows the spinner instead (styles/v2/onboarding.css),
  // since this visitor is on the way to /home. The tree keeps its shape, so the landing never remounts.
  if (status === 'signed_out' || status === 'loading') {
    const booting = status === 'loading';
    return (
      <>
        <div className="k-boot-landing" data-booting={booting ? '' : undefined}><Landing /></div>
        {booting ? <div className="k-boot-wait"><LoadingScreen /></div> : null}
      </>
    );
  }
  return <LoadingScreen />;
}
