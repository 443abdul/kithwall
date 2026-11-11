import type { Metadata } from 'next';
import { ReelsSettings } from '@/components/reels/ReelsSettings';

export const metadata: Metadata = { title: 'Reels' };

export default function Page() {
  return <ReelsSettings />;
}
