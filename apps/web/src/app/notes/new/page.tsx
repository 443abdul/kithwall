'use client';
import { AppPage, Title } from '@/components/Shell';
import { NoteEditor } from '@/components/social/NoteEditor';
import '@/styles/social.css';

export default function Page() {
  return <AppPage active="notes"><Title icon="note">Write a Note</Title><NoteEditor /></AppPage>;
}
