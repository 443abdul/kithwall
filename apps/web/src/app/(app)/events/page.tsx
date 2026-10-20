import type { Metadata } from 'next';
import { EventsScreen } from '@/components/events/EventsScreen';

export const metadata: Metadata = { title: 'Events' };

export default function Page() {
  return <EventsScreen />;
}
