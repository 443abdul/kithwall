import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CircleChat } from '@/components/messages/CircleChat';

export const metadata: Metadata = { title: 'Circle chat' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: PageProps<'/messages/circle/[circleId]'>) {
  const { circleId } = await params;
  if (!UUID.test(circleId)) notFound();
  return <CircleChat key={circleId} circleId={circleId.toLowerCase()} />;
}
