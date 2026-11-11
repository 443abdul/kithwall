import type { Metadata } from 'next';
import { ReelsScreen } from '@/components/reels/ReelsScreen';

// Reels: short vertical videos, ordered on the device (docs/v2/12-reels.md). `?start=<id>` plays that reel first.
export const metadata: Metadata = { title: 'Reels' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ searchParams }: PageProps<'/reels'>) {
  const { start } = await searchParams;
  return <ReelsScreen startId={typeof start === 'string' && UUID.test(start) ? start : undefined} />;
}
