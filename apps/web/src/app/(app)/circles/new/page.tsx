import type { Metadata } from 'next';
import { NewCircleScreen } from '@/components/circles/NewCircleScreen';

export const metadata: Metadata = { title: 'New circle' };

export default function Page() {
  return <NewCircleScreen />;
}
