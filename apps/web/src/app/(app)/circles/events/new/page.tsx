import type { Metadata } from 'next';
import { NewEventScreen } from '@/components/events/EventFormScreen';

export const metadata: Metadata = { title: 'New event' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { circle } = await searchParams;
  return <NewEventScreen circleId={typeof circle === 'string' ? circle : undefined} />;
}
