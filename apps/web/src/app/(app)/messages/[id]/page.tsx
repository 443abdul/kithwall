import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ChatThread } from '@/components/messages/ChatThread';

export const metadata: Metadata = { title: 'Messages' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: PageProps<'/messages/[id]'>) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <ChatThread key={id} id={id.toLowerCase()} />;
}
