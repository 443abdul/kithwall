import type { Metadata } from 'next';
import { AlbumsScreen } from '@/components/albums/AlbumsScreen';

export const metadata: Metadata = { title: 'Albums' };

export default function Page() {
  return <AlbumsScreen />;
}
