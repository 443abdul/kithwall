'use client';
import { useParams } from 'next/navigation';
import { AlbumView } from '@/components/photos/AlbumView';

export default function AlbumPage() {
  const { id } = useParams<{ id: string }>();
  return <AlbumView key={id} id={id} />;
}
