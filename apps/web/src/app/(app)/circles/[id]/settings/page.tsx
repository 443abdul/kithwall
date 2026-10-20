import type { Metadata } from 'next';
import { CircleSettingsScreen } from '@/components/circles/CircleSettingsScreen';

export const metadata: Metadata = { title: 'Circle settings' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CircleSettingsScreen key={id} id={id} />;
}
