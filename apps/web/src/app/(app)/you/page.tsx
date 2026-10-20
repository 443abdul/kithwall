import type { Metadata } from 'next';
import { YouScreen } from '@/components/people/YouScreen';

export const metadata: Metadata = { title: 'You' };

export default function Page() {
  return <YouScreen />;
}
