'use client';
import { useParams } from 'next/navigation';
import { UserPhotos } from '@/components/photos/UserPhotos';

export default function UserPhotosPage() {
  const { username } = useParams<{ username: string }>();
  return <UserPhotos key={username} username={decodeURIComponent(username)} />;
}
