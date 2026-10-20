import type { Metadata } from 'next';
import { PrivacyReport } from '@/components/transparency/PrivacyReport';

// "What Kithwall knows about you": live from the server's rows (docs/v2/03-transparency.md §1).
export const metadata: Metadata = { title: 'What Kithwall knows about you' };

export default function Page() {
  return <PrivacyReport />;
}
