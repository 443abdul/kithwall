import type { Metadata } from 'next';
import { CircleScreen } from '@/components/circles/CircleScreen';

export const metadata: Metadata = { title: 'Circle' };

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  return <CircleScreen key={id} id={id} initialTab={typeof tab === 'string' ? tab : undefined} />;
}
