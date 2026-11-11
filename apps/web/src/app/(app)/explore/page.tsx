import type { Metadata } from 'next';
import { ExploreScreen } from '@/components/explore/ExploreScreen';

// Explore: public posts from everyone, search for accounts that let people follow them, and suggested
// accounts (docs/v2/10-follow-public.md §5).
export const metadata: Metadata = { title: 'Explore' };

export default async function Page({ searchParams }: PageProps<'/explore'>) {
  const { tab } = await searchParams;
  return <ExploreScreen initialTab={typeof tab === 'string' ? tab.slice(0, 24) : undefined} />;
}
