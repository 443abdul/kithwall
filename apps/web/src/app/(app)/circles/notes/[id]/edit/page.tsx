import type { Metadata } from 'next';
import { NoteEditorScreen } from '@/components/notes/NoteScreens';

export const metadata: Metadata = { title: 'Edit note' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NoteEditorScreen key={id} id={id} />;
}
