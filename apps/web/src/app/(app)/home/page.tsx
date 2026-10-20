import type { Metadata } from 'next';
import { HomeScreen } from '@/components/posts/HomeScreen';

export const metadata: Metadata = { title: 'Home' };

export default function Page() {
  return <HomeScreen />;
}
