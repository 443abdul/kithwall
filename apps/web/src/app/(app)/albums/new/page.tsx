import type { Metadata } from 'next';
import { NewAlbumScreen } from '@/components/albums/AlbumsScreen';

export const metadata: Metadata = { title: 'New album' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { circle } = await searchParams;
  return <NewAlbumScreen circleId={typeof circle === 'string' ? circle : undefined} />;
}
