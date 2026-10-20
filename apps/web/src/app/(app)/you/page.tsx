import type { Metadata } from 'next';
import { YouScreen } from '@/components/shell/screens';

export const metadata: Metadata = { title: 'You' };

export default function Page() {
  return <YouScreen />;
}
