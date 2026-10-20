import type { Metadata } from 'next';
import { AlbumScreen } from '@/components/albums/AlbumScreen';

export const metadata: Metadata = { title: 'Album' };

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { photo, upload } = await searchParams;
  return <AlbumScreen key={id} id={id} initialPhoto={typeof photo === 'string' ? photo : undefined} autoUpload={upload === '1'} />;
}
