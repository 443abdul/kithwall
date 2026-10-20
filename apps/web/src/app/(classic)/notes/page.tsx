'use client';
// Notes (reference vNotes): Friends' Notes · My Notes.
import Link from 'next/link';
import { useState } from 'react';
import { AppPage, Title } from '@/components/Shell';
import { TipsBox } from '@/components/feed/RightColumn';
import { NoteList } from '@/components/social/NoteList';
import { useAuthors } from '@/components/social/useAuthors';
import { fetchByKind } from '@/lib/feed/feed';
import { useSession } from '@/lib/keys/session';
import '@/styles/social.css';

function Notes() {
  const { userId } = useSession();
  const authors = useAuthors();
  const [mine, setMine] = useState(false);
  const tab = (m: boolean, label: string) => (
    <a role="tab" tabIndex={0} aria-selected={mine === m} className={mine === m ? 'on' : ''} onClick={() => setMine(m)}
      onKeyDown={(e) => { if (e.key === 'Enter') setMine(m); }}>{label}</a>
  );
  return (
    <>
      <Title icon="note" right={<Link className="btn" href="/notes/new">+ Write a Note</Link>}>Notes</Title>
      <div className="tabs2" role="tablist">{tab(false, 'Friends’ Notes')}{tab(true, 'My Notes')}</div>
      {mine ? <NoteList key="mine" queryKey={['kind', 'note', 'user', userId]} load={(b) => fetchByKind('note', [userId!], b)} empty="You haven't written any notes yet." />
        : authors ? <NoteList key="all" queryKey={['kind', 'note', 'friends']} load={(b) => fetchByKind('note', authors, b)} empty="None of your friends have written notes yet." />
          : <div className="gray">Loading…</div>}
    </>
  );
}

export default function Page() {
  return <AppPage active="notes" right={<TipsBox />}><Notes /></AppPage>;
}
