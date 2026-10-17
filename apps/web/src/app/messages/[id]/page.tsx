import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Thread } from '@/components/messages/Thread';

export const metadata: Metadata = { title: 'Messages' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <Thread key={id} id={id.toLowerCase()} />;
}
