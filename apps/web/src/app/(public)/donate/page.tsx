import type { Metadata } from 'next';
import { DonateScreen } from '@/components/public/DonateScreen';

// Donate and other ways to help (public). Methods are build-time config: lib/donate.ts, docs/deploy.md.
export const metadata: Metadata = { title: 'Donate' };

export default function Page() {
  return <DonateScreen />;
}
