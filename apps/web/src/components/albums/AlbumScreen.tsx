'use client';
// An album: grid of photos and videos, uploads with progress (encrypted on this device first), and
// the full-screen viewer.
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { me } from '@/lib/keys/session';
import { useFileUrl } from '@/lib/media';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { TextField, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { E2eeLine, FileButton, Loading, NotFound, SealedNote, usePersonName } from '@/components/circles/shared';
import {
  addPhoto, addVideo, checkUpload, deleteAlbum, readAlbum, readMedia, updateAlbum, uploadKind, useAlbum, useAlbumMedia,
  type AlbumRow, type PhotoRow,
} from './data';
import { formatDuration, queueProgress } from './gestures';
import { useAudienceLabel } from './AlbumsScreen';
import { MediaViewer } from './MediaViewer';

interface QueueItem { key: string; file: File; kind: 'photo' | 'video'; progress: number; state: 'queued' | 'uploading' | 'done' | 'error'; error?: string }

function MediaTile({ row, onOpen }: { row: PhotoRow; onOpen: () => void }) {
  const t = useT();
  const d = readMedia(row);
  const url = useFileUrl(d.ok ? d.value.files.thumb : null);
  const video = d.ok ? d.value.video : undefined;
  return (
    <li>
      <button type="button" className="ka-cell" onClick={onOpen}
        aria-label={d.ok ? (d.value.caption || (video ? t('albums.video') : t('albums.photo'))) : t('albums.sealed')}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" loading="lazy" />
        ) : <span className="ka-cell-ph"><Icon name={d.ok ? 'image' : 'lock'} /></span>}
        {video ? <span className="ka-cell-video"><span className="ka-play" aria-hidden />{formatDuration(video.duration)}</span> : null}
      </button>
    </li>
  );
}

function UploadQueue({ items, onClear }: { items: QueueItem[]; onClear: () => void }) {
  const t = useT();
  if (!items.length) return null;
  const done = items.filter((i) => i.state === 'done').length;
  const failed = items.filter((i) => i.state === 'error');
  const running = items.some((i) => i.state === 'queued' || i.state === 'uploading');
  const pct = Math.round(queueProgress(items) * 100);
  return (
    <Card className="ka-queue" aria-live="polite">
      <div className="k-row">
        <span className="ka-queue-title">{running ? t('albums.uploading', { done, total: items.length }) : t('albums.uploaded', { count: done })}</span>
        <span className="k-spacer" />
        {!running ? <Button size="sm" variant="ghost" onClick={onClear}>{t('common.dismiss')}</Button> : <span className="k-small k-muted">{pct}%</span>}
      </div>
      <progress className="ka-progress" max={100} value={pct} aria-label={t('albums.progress')} />
      {items.filter((i) => i.state === 'uploading').map((i) => (
        <p key={i.key} className="k-small k-muted ka-queue-line">
          {i.kind === 'video' ? t('albums.encryptingVideo', { name: i.file.name }) : t('albums.encryptingPhoto', { name: i.file.name })}
          {' '}{Math.round(i.progress * 100)}%
        </p>
      ))}
      {failed.map((i) => <p key={i.key} className="k-small kc-error-line"><Icon name="alert" /> {i.file.name}: {i.error}</p>)}
    </Card>
  );
}

export function AlbumScreen({ id, initialPhoto, autoUpload }: { id: string; initialPhoto?: string; autoUpload?: boolean }) {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useAlbum(id);
  const album = q.data ?? null;
  const media = useAlbumMedia(id, !!album);
  const d = album ? readAlbum(album) : null;
  const name = d?.ok ? d.value.name : t('albums.sealed');
  useDocumentTitle(name);
  const owner = album?.owner_id === me();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const running = useRef(false);
  const queueRef = useRef<QueueItem[]>([]);
  const [viewer, setViewer] = useState<string | null>(initialPhoto ?? null);
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  const update = (key: string, patch: Partial<QueueItem>) => {
    queueRef.current = queueRef.current.map((i) => (i.key === key ? { ...i, ...patch } : i));
    setQueue(queueRef.current);
  };

  const run = useCallback(async (a: AlbumRow) => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const next = queueRef.current.find((i) => i.state === 'queued');
        if (!next) break;
        update(next.key, { state: 'uploading', progress: 0.02 });
        try {
          if (next.kind === 'video') await addVideo(a, next.file, undefined, (p) => update(next.key, { progress: p }));
          else { await addPhoto(a, next.file); }
          update(next.key, { state: 'done', progress: 1 });
          void qc.invalidateQueries({ queryKey: ['albums'] });
        } catch (e) {
          const msg = e instanceof Error && e.message === 'videoSize' ? t('albums.tooBigVideo') : t('albums.uploadFailed');
          update(next.key, { state: 'error', error: msg });
        }
      }
    } finally { running.current = false; }
  }, [qc, t]);

  const addFiles = (files: File[]) => {
    if (!album || !owner) return;
    const items: QueueItem[] = [];
    for (const f of files) {
      const bad = checkUpload(f);
      if (bad) { toast({ message: `${f.name}: ${bad === 'type' ? t('albums.badType') : bad === 'videoSize' ? t('albums.tooBigVideo') : t('albums.tooBigPhoto')}`, tone: 'danger' }); continue; }
      items.push({ key: crypto.randomUUID(), file: f, kind: uploadKind(f)!, progress: 0, state: 'queued' });
    }
    if (!items.length) return;
    queueRef.current = [...queueRef.current.filter((i) => i.state !== 'done' || running.current), ...items];
    setQueue(queueRef.current);
    void run(album);
  };

  // Leaving the page mid-upload loses the rest of the queue: warn.
  useEffect(() => {
    const busyNow = queue.some((i) => i.state === 'queued' || i.state === 'uploading');
    if (!busyNow) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [queue]);

  const openViewer = (photoId: string | null) => {
    setViewer(photoId);
    router.replace(photoId ? `/albums/${id}?photo=${photoId}` : `/albums/${id}`, { scroll: false });
  };

  if (q.isLoading) return <Page title={t('albums.title')} back={{ href: '/albums', label: t('common.back') }}><Loading /></Page>;
  if (!album) return <Page title={t('albums.title')} back={{ href: '/albums', label: t('common.back') }}><NotFound icon="image" title={t('albums.notFound')} body={t('albums.notFoundBody')} /></Page>;
  const rows = media.data ?? [];

  return (
    <Page title={name} back={{ href: '/albums', label: t('common.back') }}
      actions={owner ? <FileButton label={t('albums.upload')} accept="image/*,video/*" multiple onFiles={addFiles} icon="plus" size="sm" /> : undefined}>
      <AlbumHeader album={album} count={rows.length} owner={owner} onEdit={() => setEdit(true)} onDelete={() => setDel(true)} />
      <UploadQueue items={queue} onClear={() => { queueRef.current = []; setQueue([]); }} />
      <div className="ka-drop" data-drag={drag || undefined}
        onDragOver={owner ? (e) => { e.preventDefault(); setDrag(true); } : undefined}
        onDragLeave={owner ? () => setDrag(false) : undefined}
        onDrop={owner ? (e) => { e.preventDefault(); setDrag(false); addFiles(Array.from(e.dataTransfer.files)); } : undefined}>
        {media.isLoading ? <Loading /> : rows.length ? (
          <ul className="ka-cells" role="list">{rows.map((r) => <MediaTile key={r.id} row={r} onOpen={() => openViewer(r.id)} />)}</ul>
        ) : (
          <Card><EmptyState icon="image" title={t('albums.emptyAlbum')} body={owner ? t('albums.emptyAlbumOwner') : undefined}
            actions={owner || autoUpload ? <FileButton label={t('albums.upload')} accept="image/*,video/*" multiple onFiles={addFiles} icon="plus" /> : undefined} /></Card>
        )}
      </div>
      <E2eeLine>{t('albums.e2ee')}</E2eeLine>

      {viewer && rows.length ? (
        <MediaViewer album={album} rows={rows} currentId={viewer} onChange={(pid) => openViewer(pid)} onClose={() => openViewer(null)} />
      ) : null}

      {edit && d?.ok ? <EditAlbum album={album} initial={d.value} onClose={() => setEdit(false)} /> : null}
      <Dialog open={del} onClose={() => { if (!busy) setDel(false); }} title={t('albums.deleteTitle')} dismissible={!busy}
        footer={<>
          <Button variant="secondary" disabled={busy} onClick={() => setDel(false)}>{t('circles.ui.cancel')}</Button>
          <Button variant="danger" busy={busy} onClick={() => {
            setBusy(true);
            void deleteAlbum(album).then(async () => { void qc.invalidateQueries({ queryKey: ['albums'] }); router.replace('/albums'); })
              .catch(() => { toast({ message: t('circles.ui.error'), tone: 'danger' }); setBusy(false); });
          }}>{t('albums.delete')}</Button>
        </>}>
        <p>{t('albums.deleteBody', { count: rows.length })}</p>
      </Dialog>
    </Page>
  );
}

function AlbumHeader({ album, count, owner, onEdit, onDelete }: { album: AlbumRow; count: number; owner: boolean; onEdit: () => void; onDelete: () => void }) {
  const t = useT();
  const d = readAlbum(album);
  const aud = useAudienceLabel(album);
  const ownerName = usePersonName(album.owner_id);
  return (
    <Card className="ka-head">
      {d.ok ? (
        <div className="k-stack-sm">
          {d.value.description ? <p>{d.value.description}</p> : null}
          <p className="k-small k-muted ka-meta">
            <span><Icon name={aud.icon} /> {owner ? aud.label : t('albums.by', { name: ownerName })}</span>
            <span>{t('albums.count', { count })}</span>
          </p>
        </div>
      ) : <SealedNote reason={d.reason} />}
      {owner ? (
        <div className="k-row-wrap">
          <Button size="sm" variant="secondary" icon="edit" onClick={onEdit} disabled={!d.ok}>{t('albums.edit')}</Button>
          <Button size="sm" variant="ghost" icon="trash" onClick={onDelete}>{t('albums.delete')}</Button>
        </div>
      ) : null}
    </Card>
  );
}

function EditAlbum({ album, initial, onClose }: { album: AlbumRow; initial: { name: string; description?: string; kind?: 'normal' | 'wall' | 'profile' | 'mobile'; coverId?: string; location?: string }; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const next = { ...initial, name: name.trim().slice(0, 120) };
      if (description.trim()) next.description = description.trim().slice(0, 2000); else delete next.description;
      await updateAlbum(album, next);
      void qc.invalidateQueries({ queryKey: ['albums'] });
      onClose();
    } catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={t('albums.edit')} dismissible={!busy}
      footer={<>
        <Button variant="secondary" disabled={busy} onClick={onClose}>{t('circles.ui.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()}>{t('circles.ui.save')}</Button>
      </>}>
      <div className="k-stack">
        <TextField label={t('albums.name')} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        <Textarea label={t('albums.descriptionLabel')} value={description} maxLength={2000} rows={3} onChange={(e) => setDescription(e.target.value)} />
      </div>
    </Dialog>
  );
}
