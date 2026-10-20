import type { Metadata } from 'next';
import { NotesScreen } from '@/components/notes/NotesScreen';

export const metadata: Metadata = { title: 'Notes' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { view } = await searchParams;
  return <NotesScreen initialView={typeof view === 'string' ? view : undefined} />;
}
