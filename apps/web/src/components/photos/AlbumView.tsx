'use client';
// /photos/album/[id] — album grid; the owner can add photos, edit details, organize (drag or
// arrows), set the cover, delete photos or delete the whole album.
import '@/styles/photos.css';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { NameLink } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { useSession } from '@/lib/keys/session';
import { usePerson } from '@/lib/people';
import { sb, must } from '@/lib/supabase';
import { plural, when } from '@/lib/format';
import {
  addPhotos, albumPhotos, audienceLabel, deleteAlbum, deletePhoto, getAlbum, isMyAvatar, myLists, readPhoto,
  reorderPhotos, saveAvatar, updateAlbum, type AlbumPayload, type AlbumRow, type PhotoRow,
} from '@/lib/photos';
import { PhotoThumbGrid } from './Albums';
import { PhotoPicker, usePicked } from './PhotoPicker';
import { Confirm, LazyImg, Undecryptable, errText, useAlbumPayload, useKeysReady } from './common';

/** Like/comment counts for a set of photos (chunked to keep URLs short). */
export async function photoCounts(ids: string[]) {
  const m = new Map<string, { likes: number; comments: number }>();
  ids.forEach((id) => m.set(id, { likes: 0, comments: 0 }));
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const [likes, comments] = await Promise.all([
      sb().from('likes').select('target_id').eq('target_kind', 'photo').in('target_id', chunk),
      sb().from('comments').select('photo_id').in('photo_id', chunk),
    ]);
    (must(likes) as { target_id: string }[]).forEach((r) => { m.get(r.target_id)!.likes++; });
    (must(comments) as { photo_id: string }[]).forEach((r) => { m.get(r.photo_id)!.comments++; });
  }
  return m;
}

export function AlbumView({ id }: { id: string }) {
  const ready = useKeysReady();
  const { userId } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const album = useQuery({ queryKey: ['photos', 'album', id], enabled: ready, queryFn: () => getAlbum(id) });
  const photos = useQuery({ queryKey: ['photos', 'albumPhotos', id], enabled: ready && !!album.data, queryFn: () => albumPhotos(id) });
  const ids = useMemo(() => (photos.data ?? []).map((r) => r.id), [photos.data]);
  const counts = useQuery({ queryKey: ['likes', 'photos', 'counts', id, ids.join(',')], enabled: ids.length > 0, queryFn: () => photoCounts(ids) });
  const d = useAlbumPayload(album.data);
  const owner = usePerson(album.data?.owner_id);
  const lists = useQuery({ queryKey: ['photos', 'lists'], enabled: ready && album.data?.owner_id === userId, queryFn: () => myLists() });
  const [mode, setMode] = useState<'view' | 'add' | 'edit' | 'organize'>('view');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const name = d?.ok ? d.value.name : 'Album';
  useEffect(() => { document.title = `${d?.ok ? d.value.name : 'Album'} | Kithwall`; }, [d]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['photos'] });

  if (!ready || album.isLoading) return <AppPage active="photos"><div className="gray">Loading…</div></AppPage>;
  if (album.error) return <AppPage active="photos"><div className="err">{errText(album.error)}</div></AppPage>;
  const a = album.data;
  if (!a) return <AppPage active="photos"><div className="note">This album could not be found, or you don&rsquo;t have permission to see it.</div></AppPage>;
  const mine = a.owner_id === userId;
  const rows = photos.data ?? [];
  const back = owner ? <Link href={`/${owner.username}/photos`}>Back to {mine ? 'My' : `${owner.name.split(' ')[0]}’s`} Photos</Link> : null;

  return (
    <AppPage active="photos">
      <Title icon="photo" right={<>
        {mine && d?.ok ? <>
          <a role="button" tabIndex={0} onClick={() => setMode('add')} onKeyDown={(e) => { if (e.key === 'Enter') setMode('add'); }}>Add More Photos</a> &middot;{' '}
          <a role="button" tabIndex={0} onClick={() => setMode('edit')} onKeyDown={(e) => { if (e.key === 'Enter') setMode('edit'); }}>Edit Album</a> &middot;{' '}
          {rows.length > 0 ? <><a role="button" tabIndex={0} onClick={() => setMode('organize')} onKeyDown={(e) => { if (e.key === 'Enter') setMode('organize'); }}>Organize</a> &middot;{' '}</> : null}
          <a role="button" tabIndex={0} onClick={() => setConfirmDelete(true)} onKeyDown={(e) => { if (e.key === 'Enter') setConfirmDelete(true); }}>Delete Album</a> &middot;{' '}
        </> : null}
        {back}
      </>}>{name}</Title>

      {d && !d.ok ? <Undecryptable reason={d.reason} ownerId={a.owner_id} /> : null}
      {d?.ok ? (
        <div className="kp-meta">
          {d.value.description ? <div style={{ whiteSpace: 'pre-wrap', color: '#333', marginBottom: 4 }}>{d.value.description}</div> : null}
          {d.value.location ? <>{d.value.location} &middot; </> : null}
          {plural(rows.length, 'photo')} &middot; By <NameLink id={a.owner_id} /> &middot; Updated {when(a.updated_at)} &middot;{' '}
          {a.is_public ? <><Icon name="globe" />Public — not encrypted</> : <><Icon name="lock" />{audienceLabel(a, lists.data)}</>}
        </div>
      ) : null}

      {mine && d?.ok && mode === 'add' ? <AddPhotos album={a} onDone={() => { setMode('view'); void refresh(); }} /> : null}
      {mine && d?.ok && mode === 'edit' ? <EditAlbum album={a} payload={d.value} onDone={() => { setMode('view'); void refresh(); }} /> : null}
      {mine && d?.ok && mode === 'organize'
        ? <Organize album={a} payload={d.value} rows={rows} onDone={() => { setMode('view'); void refresh(); }} />
        : photos.isLoading ? <div className="gray">Loading photos…</div>
          : <PhotoThumbGrid rows={rows} counts={counts.data} empty="This album is empty." />}

      {confirmDelete && (
        <Confirm title="Delete Album" action="Delete Album" onClose={() => setConfirmDelete(false)}
          body={<>Are you sure you want to delete <b>{name}</b> and all {plural(rows.length, 'photo')} in it? This can&rsquo;t be undone.</>}
          onConfirm={async () => {
            const avatarHere = rows.some((r) => { const p = readPhoto(r); return p.ok && isMyAvatar(p.value.files); });
            await deleteAlbum(a);
            if (avatarHere) await saveAvatar(undefined);
            await refresh();
            router.push('/photos');
          }} />
      )}
    </AppPage>
  );
}

function AddPhotos({ album, onDone }: { album: AlbumRow; onDone: () => void }) {
  const [items, setItems] = usePicked();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const upload = async () => {
    setErr(null);
    setProgress({ done: 0, total: items.length });
    try {
      await addPhotos(album, items.map((p) => p.file), items.map((p) => p.caption), (done) => setProgress({ done, total: items.length }));
      onDone();
    } catch (e) { setErr(errText(e)); setProgress(null); }
  };
  return (
    <div className="note">
      <div className="sub"><span>Add Photos</span></div>
      <PhotoPicker items={items} onItems={setItems} disabled={!!progress} progress={progress} />
      {err ? <div className="kp-errs" role="alert">{err}</div> : null}
      <div style={{ marginTop: 8 }}>
        <button className="btn b" disabled={!items.length || !!progress} onClick={() => void upload()}>Upload {items.length ? plural(items.length, 'Photo') : 'Photos'}</button>{' '}
        <button className="btn" disabled={!!progress} onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function EditAlbum({ album, payload, onDone }: { album: AlbumRow; payload: AlbumPayload; onDone: () => void }) {
  const system = payload.kind && payload.kind !== 'normal';
  const [name, setName] = useState(payload.name);
  const [location, setLocation] = useState(payload.location ?? '');
  const [description, setDescription] = useState(payload.description ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Please give your album a name.'); return; }
    setBusy(true); setErr(null);
    try {
      const next: AlbumPayload = { ...payload, name: name.trim().slice(0, 200) };
      if (location.trim()) next.location = location.trim().slice(0, 200); else delete next.location;
      if (description.trim()) next.description = description.trim().slice(0, 5000); else delete next.description;
      await updateAlbum(album, next);
      onDone();
    } catch (e2) { setErr(errText(e2)); setBusy(false); }
  };
  return (
    <form className="note" onSubmit={save}>
      <div className="sub"><span>Edit Album</span></div>
      {err ? <div className="kp-errs" role="alert">{err}</div> : null}
      <table className="form" role="presentation"><tbody>
        <tr><td className="l"><label htmlFor="kp-en">Album Name:</label></td>
          <td><input id="kp-en" type="text" value={name} maxLength={200} disabled={busy || !!system} onChange={(e) => setName(e.target.value)} />
            {system ? <div className="gray small">This album&rsquo;s name can&rsquo;t be changed.</div> : null}</td></tr>
        <tr><td className="l"><label htmlFor="kp-el">Location:</label></td>
          <td><input id="kp-el" type="text" value={location} maxLength={200} disabled={busy} onChange={(e) => setLocation(e.target.value)} /></td></tr>
        <tr><td className="l"><label htmlFor="kp-ed">Description:</label></td>
          <td><textarea id="kp-ed" value={description} maxLength={5000} disabled={busy} onChange={(e) => setDescription(e.target.value)} /></td></tr>
        <tr><td></td><td><button className="btn b" disabled={busy}>Save Changes</button> <button type="button" className="btn" disabled={busy} onClick={onDone}>Cancel</button></td></tr>
      </tbody></table>
    </form>
  );
}

function Organize({ album, payload, rows, onDone }: { album: AlbumRow; payload: AlbumPayload; rows: PhotoRow[]; onDone: () => void }) {
  const [order, setOrder] = useState(() => rows.map((r) => r.id));
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [cover, setCover] = useState<string | undefined>(payload.coverId);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const shown = order.filter((id) => !removed.has(id));
  const effectiveCover = cover && shown.includes(cover) ? cover : shown[0];

  const move = (id: string, to: number) => {
    setOrder((o) => {
      const vis = o.filter((x) => !removed.has(x));
      const from = vis.indexOf(id);
      if (from < 0 || to < 0 || to >= vis.length) return o;
      vis.splice(from, 1);
      vis.splice(to, 0, id);
      return [...vis, ...o.filter((x) => removed.has(x))];
    });
  };

  const save = async () => {
    setErr(null);
    try {
      const del = [...removed];
      let avatarGone = false;
      for (let i = 0; i < del.length; i++) {
        setBusy(`Deleting photo ${i + 1} of ${del.length}…`);
        const r = byId.get(del[i]!)!;
        const p = readPhoto(r);
        if (p.ok && isMyAvatar(p.value.files)) avatarGone = true;
        await deletePhoto(r, p.ok ? p.value : undefined);
      }
      if (avatarGone) await saveAvatar(undefined);
      setBusy('Saving order…');
      await reorderPhotos(rows.filter((r) => !removed.has(r.id)), shown);
      const next = { ...payload };
      if (cover && shown.includes(cover)) next.coverId = cover; else delete next.coverId;
      if (next.coverId !== payload.coverId) await updateAlbum(album, next);
      onDone();
    } catch (e) { setErr(errText(e)); setBusy(null); }
  };

  return (
    <div>
      <div className="note">
        Drag photos to reorder them (or use the arrows). Changes are saved when you click <b>Save Changes</b>.
        <div style={{ marginTop: 6 }}>
          <button className="btn b" disabled={!!busy} onClick={() => void save()}>Save Changes</button>{' '}
          <button className="btn" disabled={!!busy} onClick={onDone}>Cancel</button>
          {removed.size ? <span className="gray"> &nbsp;{plural(removed.size, 'photo')} will be deleted.</span> : null}
          {busy ? <span className="gray" role="status"> &nbsp;{busy}</span> : null}
        </div>
        {err ? <div className="kp-errs" role="alert">{err}</div> : null}
      </div>
      <div className="ph" role="list" aria-label="Photos in this album">
        {shown.map((id, i) => {
          const r = byId.get(id)!;
          const p = readPhoto(r);
          const cap = p.ok ? p.value.caption ?? '' : '';
          return (
            <div key={id} role="listitem" className={`kp-tile${dragId === id ? ' drag' : ''}${overId === id && dragId !== id ? ' over' : ''}`}
              draggable={!busy}
              onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              onDragOver={(e) => { e.preventDefault(); setOverId(id); }}
              onDrop={(e) => { e.preventDefault(); const src = dragId ?? e.dataTransfer.getData('text/plain'); if (src && src !== id) move(src, shown.indexOf(id)); setDragId(null); setOverId(null); }}>
              <span className="thumb"><LazyImg file={p.ok ? p.value.files.thumb : null} alt={cap} /></span>
              {effectiveCover === id ? <span className="cov">Cover</span> : null}
              <div className="tools">
                <button className="btn" aria-label={`Move photo ${i + 1} earlier`} disabled={!!busy || i === 0} onClick={() => move(id, i - 1)}>&larr;</button>
                <button className="btn" aria-label={`Move photo ${i + 1} later`} disabled={!!busy || i === shown.length - 1} onClick={() => move(id, i + 1)}>&rarr;</button>
                <button className="btn" disabled={!!busy || effectiveCover === id} onClick={() => setCover(id)}>Cover</button>
                <button className="btn" aria-label={`Delete photo ${i + 1}`} disabled={!!busy} onClick={() => setRemoved((s) => new Set(s).add(id))}>Delete</button>
              </div>
            </div>
          );
        })}
      </div>
      {removed.size ? (
        <div className="gray" style={{ marginTop: 8 }}>
          <a role="button" tabIndex={0} onClick={() => setRemoved(new Set())} onKeyDown={(e) => { if (e.key === 'Enter') setRemoved(new Set()); }}>Undo deletes</a>
        </div>
      ) : null}
    </div>
  );
}
