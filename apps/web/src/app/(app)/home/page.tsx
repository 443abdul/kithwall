import type { Metadata } from 'next';
import { HomeScreen } from '@/components/shell/screens';

export const metadata: Metadata = { title: 'Home' };

export default function Page() {
  return <HomeScreen />;
}
