import type { Metadata } from 'next';
import { Home } from '@/components/onboarding/Home';

// The landing page is the only page search engines may index; the root layout keeps everything else
// noindex/nofollow (signed-in screens, profiles, invites and recovery never belong in search results).
export const metadata: Metadata = {
  robots: { index: true, follow: false },
  alternates: { canonical: '/' },
};

export default function Page() {
  return <Home />;
}
