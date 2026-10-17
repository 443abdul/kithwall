'use client';
import { use } from 'react';
import { ProfileFrame } from '@/components/profile/ProfileFrame';
import { NotesTab } from '@/components/profile/Tabs';

export default function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params);
  const u = decodeURIComponent(username);
  return <ProfileFrame key={u} username={u} tab="notes">{(ctx) => <NotesTab ctx={ctx} />}</ProfileFrame>;
}
