import type { Metadata } from 'next';
import { PostScreen } from '@/components/posts/PostScreen';

export const metadata: Metadata = { title: 'Post' };

export default async function Page({ params }: PageProps<'/post/[id]'>) {
  const { id } = await params;
  return <PostScreen key={id} id={id.slice(0, 64)} />;
}
