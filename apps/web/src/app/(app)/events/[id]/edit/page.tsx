import type { Metadata } from 'next';
import { EditEventScreen } from '@/components/events/EventFormScreen';

export const metadata: Metadata = { title: 'Edit event' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditEventScreen key={id} id={id} />;
}
