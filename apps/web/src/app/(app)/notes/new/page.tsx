import type { Metadata } from 'next';
import { NoteEditorScreen } from '@/components/notes/NoteScreens';

export const metadata: Metadata = { title: 'New note' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { circle, journal } = await searchParams;
  return <NoteEditorScreen circleId={typeof circle === 'string' ? circle : undefined} journal={journal === '1'} />;
}
