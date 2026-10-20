import type { Metadata } from 'next';
import { ScheduledScreen } from '@/components/posts/Scheduled';

export const metadata: Metadata = { title: 'Scheduled posts' };

export default function Page() {
  return <ScheduledScreen />;
}
