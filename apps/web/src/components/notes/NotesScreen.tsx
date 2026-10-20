'use client';
// Notes: my notes, my private journal (only me), my connections' notes, and a circle's notes.
import Link from 'next/link';
import { useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Segmented } from '@/components/ui/Segmented';
import { MoreLinks } from '@/components/circles/CirclesScreen';
import { useCircleOptions, type CircleRow } from '@/components/circles/data';
import { E2eeLine, Loading, PersonAvatar, usePersonName } from '@/components/circles/shared';
import type { PostRow } from '@/lib/types';
import { noteAudience, readNote, useCircleNotes, useConnectionsNotes, useMyNotes } from './data';
import { excerpt } from './format';

export function useNoteAudienceLabel(row: PostRow): { icon: IconName; label: string } {
  const t = useT();
  const { options } = useCircleOptions();
  const a = noteAudience(row);
  if (a.kind === 'only_me') return { icon: 'book', label: t('notes.journal') };
  if (a.kind === 'connections') return { icon: 'users', label: t('circles.aud.connections') };
  if (a.kind === 'circle') {
    const c = options.find((o) => o.id === a.circleId);
    return { icon: 'circles', label: c?.info?.name ?? t('circles.ui.sealedCircle') };
  }
  return { icon: 'lock', label: t('notes.shared') };
}

function NoteCard({ row, showAuthor }: { row: PostRow; showAuthor?: boolean }) {
  const t = useT();
  const f = useFormat();
  const d = readNote(row);
  const aud = useNoteAudienceLabel(row);
  const author = usePersonName(row.author_id);
  return (
    <li>
      <Link href={`/notes/${row.id}`} className="kn-card">
        <span dir="auto" className="kn-card-title">{d.ok ? d.value.title || t('notes.untitled') : t('notes.sealed')}</span>
        {d.ok && d.value.body ? <span dir="auto" className="kn-card-excerpt">{excerpt(d.value.body)}</span> : null}
        <span className="kn-card-meta">
          {showAuthor ? <><PersonAvatar id={row.author_id} size={20} /><span>{author}</span><span aria-hidden>·</span></> : null}
          <span>{f.date(new Date(row.created_at))}</span>
          <span aria-hidden>·</span>
          <span className="kn-aud"><Icon name={aud.icon} /> {aud.label}</span>
        </span>
      </Link>
    </li>
  );
}

function NoteList({ rows, showAuthor }: { rows: PostRow[]; showAuthor?: boolean }) {
  return <ul className="k-stack-sm k-plain-list" role="list">{rows.map((r) => <NoteCard key={r.id} row={r} showAuthor={showAuthor} />)}</ul>;
}

export function NotesScreen({ initialView }: { initialView?: string }) {
  const t = useT();
  useDocumentTitle(t('notes.title'));
  const [view, setView] = useState<'mine' | 'journal' | 'connections'>(initialView === 'journal' || initialView === 'connections' ? initialView : 'mine');
  const mine = useMyNotes();
  const others = useConnectionsNotes();
  const rows = view === 'connections' ? others.data ?? []
    : (mine.data ?? []).filter((r) => (view === 'journal' ? noteAudience(r).kind === 'only_me' : noteAudience(r).kind !== 'only_me'));
  const loading = view === 'connections' ? others.isLoading : mine.isLoading;
  const writeHref = view === 'journal' ? '/notes/new?journal=1' : '/notes/new';
  return (
    <Page title={t('notes.title')} description={t('notes.description')}
      actions={<ButtonLink href={writeHref} variant="primary" icon="edit" size="sm">{view === 'journal' ? t('notes.writeJournal') : t('notes.write')}</ButtonLink>}
      context={<MoreLinks />}>
      <Segmented label={t('notes.title')} value={view} onChange={setView} block options={[
        { value: 'mine', label: t('notes.mine') }, { value: 'journal', label: t('notes.journal'), icon: 'book' }, { value: 'connections', label: t('notes.connections') },
      ]} />
      {view === 'journal' ? <p className="k-small k-muted kn-journal-note"><Icon name="lock" /> {t('notes.journalBody')}</p> : null}
      {loading ? <Loading /> : rows.length ? <NoteList rows={rows} showAuthor={view === 'connections'} /> : (
        <Card><EmptyState icon={view === 'journal' ? 'book' : 'edit'}
          title={view === 'journal' ? t('notes.emptyJournal') : view === 'connections' ? t('notes.emptyConnections') : t('notes.emptyMine')}
          body={view === 'connections' ? undefined : t('notes.emptyBody')}
          actions={view === 'connections' ? undefined : <ButtonLink href={writeHref} variant="primary" icon="edit">{view === 'journal' ? t('notes.writeJournal') : t('notes.write')}</ButtonLink>} /></Card>
      )}
      <E2eeLine>{t('notes.e2ee')}</E2eeLine>
    </Page>
  );
}

/** The Notes tab of a circle. */
export function CircleNotes({ circle }: { circle: CircleRow }) {
  const t = useT();
  const q = useCircleNotes(circle.id);
  if (q.isLoading) return <Loading />;
  return (
    <div className="k-stack">
      <div className="k-row-wrap"><ButtonLink href={`/notes/new?circle=${circle.id}`} variant="soft" icon="edit">{t('notes.writeInCircle')}</ButtonLink></div>
      {q.data?.length ? <NoteList rows={q.data} showAuthor /> : <Card><EmptyState icon="edit" title={t('notes.emptyCircle')} body={t('notes.emptyCircleBody')} /></Card>}
    </div>
  );
}
