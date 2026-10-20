import type { Metadata } from 'next';
import { ActivityScreen } from '@/components/shell/screens';

export const metadata: Metadata = { title: 'Activity' };

export default function Page() {
  return <ActivityScreen />;
}
