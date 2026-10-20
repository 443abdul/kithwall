import type { Metadata } from 'next';
import { NoteScreen } from '@/components/notes/NoteScreens';

export const metadata: Metadata = { title: 'Note' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NoteScreen key={id} id={id} />;
}
