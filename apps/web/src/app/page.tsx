'use client';
import { useSession } from '@/lib/keys/session';
import { Loading } from '@/components/Shell';
import { Splash } from '@/components/auth/Splash';
import { HomeFeed } from '@/components/feed/HomeFeed';

export default function Home() {
  const { status } = useSession();
  if (status === 'loading') return <Loading />;
  if (status === 'signed_out') return <Splash />;
  return <HomeFeed />;
}
