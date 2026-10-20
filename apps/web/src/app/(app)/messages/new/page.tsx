import type { Metadata } from 'next';
import { NewChat } from '@/components/messages/NewChat';

export const metadata: Metadata = { title: 'New chat' };

export default async function Page({ searchParams }: PageProps<'/messages/new'>) {
  const { to } = await searchParams;
  return <NewChat to={typeof to === 'string' ? to.slice(0, 64) : undefined} />;
}
