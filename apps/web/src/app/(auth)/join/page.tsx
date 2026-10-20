import type { Metadata } from 'next';
import { Suspense } from 'react';
import { JoinFlow } from '@/components/onboarding/JoinFlow';

export const metadata: Metadata = { title: 'Join' };

export default function Page() {
  // useSearchParams (invite code) needs a Suspense boundary.
  return <Suspense><JoinFlow /></Suspense>;
}
