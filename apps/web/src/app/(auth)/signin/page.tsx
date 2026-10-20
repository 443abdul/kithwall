import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignIn } from '@/components/onboarding/SignIn';

export const metadata: Metadata = { title: 'Sign in' };

export default function Page() {
  // useSearchParams (?next=) needs a Suspense boundary.
  return <Suspense><SignIn /></Suspense>;
}
