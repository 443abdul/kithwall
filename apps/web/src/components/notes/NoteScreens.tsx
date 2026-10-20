'use client';
// Note reader and the distraction-free editor (Markdown subset with a toolbar and live preview).
// Rendering goes through components/auth/Markdown.tsx: React elements only, links limited to http(s).
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { me } from '@/lib/keys/session';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { renderMarkdown } from '@/components/auth/Markdown';
import { Button, ButtonLink, IconButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Segmented } from '@/components/ui/Segmented';
import { useToast } from '@/components/ui/Toast';
import { useCircleOptions } from '@/components/circles/data';
import { AudiencePicker, E2eeLine, Loading, NotFound, PersonAvatar, SealedNote, usePersonName, type ShareAudience } from '@/components/circles/shared';
import { createNote, MAX_BODY, readNote, removeNote, saveNote, useNote } from './data';
import { applyFormat, readingMinutes, safeLink, type FormatKind } from './format';
import { useNoteAudienceLabel } from './NotesScreen';

export function NoteBody({ md }: { md: string }) {
  return <div dir="auto" className="kn-prose">{renderMarkdown(md, safeLink)}</div>;
}

const TOOLS: { kind: FormatKind; icon: IconName; label: MessageKey; key?: string }[] = [
  { kind: 'heading', icon: 'heading', label: 'notes.fmt.heading' },
  { kind: 'bold', icon: 'bold', label: 'notes.fmt.bold', key: 'b' },
  { kind: 'italic', icon: 'italic', label: 'notes.fmt.italic', key: 'i' },
  { kind: 'list', icon: 'listBullet', label: 'notes.fmt.list' },
  { kind: 'numbered', icon: 'menu', label: 'notes.fmt.numbered' },
  { kind: 'quote', icon: 'quote', label: 'notes.fmt.quote' },
  { kind: 'link', icon: 'link', label: 'notes.fmt.link', key: 'k' },
];

export function NoteEditorScreen({ id, circleId, journal }: { id?: string; circleId?: string; journal?: boolean }) {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const existing = useNote(id ?? '');
  const circles = useCircleOptions();
  const row = id ? existing.data ?? null : null;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState(!id);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [aud, setAud] = useState<ShareAudience>(circleId ? { kind: 'circle', circleId } : journal ? { kind: 'only_me' } : { kind: 'connections' });
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useDocumentTitle(id ? t('notes.edit') : aud.kind === 'only_me' ? t('notes.writeJournal') : t('notes.write'));

  useEffect(() => {
    if (!row || loaded) return;
    const d = readNote(row);
    if (d.ok) { setTitle(d.value.title); setBody(d.value.body); setLoaded(true); }
  }, [row, loaded]);

  const format = (kind: FormatKind) => {
    const el = area.current;
    if (!el) return;
    const r = applyFormat(body, el.selectionStart, el.selectionEnd, kind, t('notes.fmt.placeholder'));
    setBody(r.text);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(r.start, r.end); });
  };

  const save = async () => {
    if (!title.trim() && !body.trim()) return;
    setBusy(true);
    try {
      let nid = id;
      if (row) await saveNote(row, { title, body });
      else {
        const circleAud = aud.kind === 'circle' ? circles.options.find((o) => o.id === aud.circleId)?.audienceId : undefined;
        nid = (await createNote({ title, body }, aud, circleAud)).id;
      }
      void qc.invalidateQueries({ queryKey: ['notes'] });
      toast({ message: t('notes.saved') });
      router.replace(`/notes/${nid}`);
    } catch {
      toast({ message: t('circles.ui.error'), tone: 'danger' });
      setBusy(false);
    }
  };

  const back = { href: id ? `/notes/${id}` : circleId ? `/circles/${circleId}?tab=notes` : '/notes', label: t('common.back') };
  if (id && existing.isLoading) return <Page title={t('notes.edit')} back={back}><Loading /></Page>;
  if (id && (!row || row.author_id !== me())) return <Page title={t('notes.edit')} back={back}><NotFound icon="lock" title={t('notes.authorOnly')} /></Page>;
  const near = body.length > MAX_BODY * 0.9;

  return (
    <Page title={id ? t('notes.edit') : aud.kind === 'only_me' ? t('notes.writeJournal') : t('notes.write')} back={back}
      actions={<Button variant="primary" size="sm" icon="check" busy={busy} disabled={!title.trim() && !body.trim()} onClick={() => void save()}>{t('notes.save')}</Button>}>
      <div className="kn-editor">
        <input dir="auto" className="kn-title-input" value={title} maxLength={200} placeholder={t('notes.titlePh')} aria-label={t('notes.titleLabel')}
          onChange={(e) => setTitle(e.target.value)} />
        <div className="kn-toolbar" role="toolbar" aria-label={t('notes.fmt.toolbar')}>
          <Segmented label={t('notes.mode')} value={mode} onChange={setMode} options={[
            { value: 'write', label: t('notes.modeWrite') }, { value: 'preview', label: t('notes.modePreview') },
          ]} />
          {mode === 'write' ? (
            <span className="kn-tools">
              {TOOLS.map((tool) => (
                <IconButton key={tool.kind} icon={tool.icon} size="sm" label={tool.key ? `${t(tool.label)} (Ctrl+${tool.key.toUpperCase()})` : t(tool.label)}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => format(tool.kind)} />
              ))}
            </span>
          ) : null}
        </div>
        {mode === 'write' ? (
          <textarea ref={area} dir="auto" className="kn-body-input" value={body} maxLength={MAX_BODY} placeholder={t('notes.bodyPh')} aria-label={t('notes.bodyLabel')}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (!(e.ctrlKey || e.metaKey)) return;
              const tool = TOOLS.find((x) => x.key === e.key.toLowerCase());
              if (tool) { e.preventDefault(); format(tool.kind); }
              if (e.key === 'Enter') { e.preventDefault(); void save(); }
            }} />
        ) : (
          <div className="kn-preview">{body.trim() ? <NoteBody md={body} /> : <p className="k-muted">{t('notes.previewEmpty')}</p>}</div>
        )}
        {near ? <p className="k-small k-muted" aria-live="polite">{t('notes.limit', { count: MAX_BODY - body.length })}</p> : null}
      </div>
      {!id ? (
        <Card><AudiencePicker value={aud} onChange={setAud} label={t('notes.whoCanRead')} /></Card>
      ) : null}
      <p className="k-xs k-muted">{t('notes.formatHelp')}</p>
      <E2eeLine>{aud.kind === 'only_me' ? t('notes.journalBody') : t('notes.e2ee')}</E2eeLine>
    </Page>
  );
}

export function NoteScreen({ id }: { id: string }) {
  const t = useT();
  const f = useFormat();
  const q = useNote(id);
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [del, setDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const row = q.data ?? null;
  const d = row ? readNote(row) : null;
  useDocumentTitle(d?.ok ? d.value.title || t('notes.untitled') : t('notes.title'));
  const author = usePersonName(row?.author_id);
  const back = { href: row?.group_id ? `/circles/${row.group_id}?tab=notes` : '/notes', label: t('common.back') };
  if (q.isLoading) return <Page title={t('notes.title')} back={back}><Loading /></Page>;
  if (!row) return <Page title={t('notes.title')} back={back}><NotFound icon="edit" title={t('notes.notFound')} actions={<ButtonLink href="/notes" variant="soft">{t('notes.title')}</ButtonLink>} /></Page>;
  const mine = row.author_id === me();
  const remove = async () => {
    setBusy(true);
    try { await removeNote(row); void qc.invalidateQueries({ queryKey: ['notes'] }); router.replace(back.href); }
    catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); setBusy(false); }
  };
  return (
    <Page title={d?.ok ? d.value.title || t('notes.untitled') : t('notes.sealed')} back={back}
      actions={mine && d?.ok ? <ButtonLink href={`/notes/${id}/edit`} variant="secondary" size="sm" icon="edit">{t('notes.edit')}</ButtonLink> : undefined}>
      <article className="kn-article">
        <NoteMeta row={row} author={author} date={f.date(new Date(row.created_at), { dateStyle: 'long' })} minutes={d?.ok ? readingMinutes(d.value.body) : 0} />
        {d?.ok ? <NoteBody md={d.value.body} /> : d ? <SealedNote reason={d.reason} /> : null}
        {row.edited_at ? <p className="k-xs k-muted">{t('notes.edited', { date: f.date(new Date(row.edited_at), { dateStyle: 'medium' }) })}</p> : null}
      </article>
      {mine ? <div><Button variant="ghost" icon="trash" onClick={() => setDel(true)}>{t('notes.delete')}</Button></div> : null}
      <E2eeLine>{t('notes.e2ee')}</E2eeLine>
      <Dialog open={del} onClose={() => { if (!busy) setDel(false); }} title={t('notes.deleteTitle')}
        footer={<>
          <Button variant="secondary" disabled={busy} onClick={() => setDel(false)}>{t('circles.ui.cancel')}</Button>
          <Button variant="danger" busy={busy} onClick={() => void remove()}>{t('notes.delete')}</Button>
        </>}>
        <p>{t('notes.deleteBody')}</p>
      </Dialog>
    </Page>
  );
}

function NoteMeta({ row, author, date, minutes }: { row: Parameters<typeof useNoteAudienceLabel>[0]; author: string; date: string; minutes: number }) {
  const t = useT();
  const aud = useNoteAudienceLabel(row);
  return (
    <div className="kn-meta">
      <PersonAvatar id={row.author_id} size={36} />
      <div className="kn-meta-text">
        <span className="kn-meta-name">{author}</span>
        <span className="k-small k-muted">
          {date}{minutes ? ` · ${t('notes.minutes', { count: minutes })}` : ''} · <Icon name={aud.icon} /> {aud.label}
        </span>
      </div>
    </div>
  );
}
