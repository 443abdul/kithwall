'use client';
import { use } from 'react';
import { EventView } from '@/components/events/EventView';

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <EventView id={id} />;
}
