import type { Metadata } from 'next';
import { EventScreen } from '@/components/events/EventScreen';

export const metadata: Metadata = { title: 'Event' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventScreen key={id} id={id} />;
}
