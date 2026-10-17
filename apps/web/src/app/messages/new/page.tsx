import type { Metadata } from 'next';
import { NewMessage } from '@/components/messages/NewMessage';

export const metadata: Metadata = { title: 'New Message' };

export default async function NewMessagePage({ searchParams }: { searchParams: Promise<{ to?: string | string[] }> }) {
  const { to } = await searchParams;
  return <NewMessage to={typeof to === 'string' ? to.slice(0, 64) : undefined} />;
}
