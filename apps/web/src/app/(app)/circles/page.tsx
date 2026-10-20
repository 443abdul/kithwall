import type { Metadata } from 'next';
import { CirclesScreen } from '@/components/circles/CirclesScreen';

export const metadata: Metadata = { title: 'Circles' };

export default function Page() {
  return <CirclesScreen />;
}
