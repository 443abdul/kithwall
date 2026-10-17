'use client';
import { useParams } from 'next/navigation';
import { PhotoViewer } from '@/components/photos/PhotoViewer';

export default function PhotoPage() {
  const { id } = useParams<{ id: string }>();
  return <PhotoViewer id={id} />;
}
