import type { Metadata } from 'next';
import { SearchScreen } from '@/components/search/SearchScreen';

export const metadata: Metadata = { title: 'Search' };

export default function Page() {
  return <SearchScreen />;
}
