import type { Metadata } from 'next';
import { TransparencyScreen } from '@/components/transparency/TransparencyScreen';

// Public transparency report (docs/v2/03-transparency.md §3). Facts: lib/transparency/facts.ts.
export const metadata: Metadata = { title: 'Transparency report' };

export default function Page() {
  return <TransparencyScreen />;
}
