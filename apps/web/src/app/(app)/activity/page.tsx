import type { Metadata } from 'next';
import { ActivityScreen } from '@/components/activity/ActivityScreen';

export const metadata: Metadata = { title: 'Activity' };

export default async function Page({ searchParams }: PageProps<'/activity'>) {
  const { tab } = await searchParams;
  return <ActivityScreen initialTab={typeof tab === 'string' ? tab : undefined} />;
}
