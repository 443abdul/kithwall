'use client';
// /photos/[id] — the 2010 photo page: large image, prev/next (←/→, swipe), caption, tags
// ("In this photo"), likes & comments, and owner/tagged actions.
import '@/styles/photos.css';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { Avatar, AvatarLink, NameLink } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { ReportDialog } from '@/components/ReportDialog';
import { useSession } from '@/lib/keys/session';
import { useFriendIds } from '@/lib/hooks';
import { people, usePeopleVersion, usePerson } from '@/lib/people';
import { sb, must } from '@/lib/supabase';
import { when, plural } from '@/lib/format';
import { addComment, readComment, setLike } from '@/lib/content';
import type { CommentRow } from '@/lib/types';
import {
  albumPhotos, approveTag, deletePhoto, downloadPhoto, getAlbum, getPhoto, isMyAvatar, notifyPhotoOwner,
  photoContentKey, profilePictureFromPhoto, removeTag, saveAvatar, tagFriend, tagNotices, updateAlbum, updatePhoto,
  visibleTags, type PhotoPayload, type PhotoRow, type TagNotice,
} from '@/lib/photos';
import { Confirm, Undecryptable, errText, useAlbumPayload, useKeysReady, useLazyFileUrl, usePhotoPayload } from './common';

export function PhotoViewer({ id }: { id: string }) {
  const ready = useKeysReady();
  const router = useRouter();
  const qc = useQueryClient();
  const photo = useQuery({ queryKey: ['photos', 'photo', id], enabled: ready, queryFn: () => getPhoto(id) });
  const row = photo.data ?? null;
  const album = useQuery({ queryKey: ['photos', 'album', row?.album_id], enabled: ready && !!row, queryFn: () => getAlbum(row!.album_id) });
  const siblings = useQuery({ queryKey: ['photos', 'albumPhotos', row?.album_id], enabled: ready && !!row, queryFn: () => albumPhotos(row!.album_id) });
  const d = usePhotoPayload(row);
  const a = useAlbumPayload(album.data);

  const list = siblings.data ?? [];
  const idx = list.findIndex((r) => r.id === id);
  const n = list.length;
  const prevId = n > 1 && idx >= 0 ? list[(idx - 1 + n) % n]!.id : null;
  const nextId = n > 1 && idx >= 0 ? list[(idx + 1) % n]!.id : null;
  const go = useCallback((pid: string | null) => { if (pid) router.push(`/photos/${pid}`); }, [router]);

  // Prefetch neighbours' medium images so prev/next feels instant.
  useEffect(() => {
    if (idx < 0) return;
    for (const pid of [prevId, nextId]) {
      const r = list.find((x) => x.id === pid);
      if (r) void qc.prefetchQuery({ queryKey: ['photos', 'photo', r.id], queryFn: async () => r });
    }
  }, [idx, prevId, nextId, list, qc]);

  useEffect(() => {
    document.title = `${a?.ok ? a.value.name : 'Photo'} | Kithwall`;
  }, [a]);

  if (!ready || photo.isLoading) return <AppPage active="photos"><div className="gray">Loading…</div></AppPage>;
  if (photo.error) return <AppPage active="photos"><div className="err">{errText(photo.error)}</div></AppPage>;
  if (!row) return <AppPage active="photos"><div className="note">This photo could not be found, or you don&rsquo;t have permission to see it.</div></AppPage>;

  const albumName = a?.ok ? a.value.name : 'Album';
  return (
    <AppPage active="photos">
      <Title icon="photo" right={n > 0 && idx >= 0 ? <>
        Photo <b>{idx + 1}</b> of <b>{n}</b>{nextId ? <> &nbsp;<Link href={`/photos/${prevId}`} rel="prev">Previous</Link> &middot; <Link href={`/photos/${nextId}`} rel="next">Next</Link></> : null}
      </> : null}><Link href={`/photos/album/${row.album_id}`}>{albumName}</Link></Title>
      {d && !d.ok ? <Undecryptable reason={d.reason} ownerId={row.owner_id} />
        : d?.ok ? <PhotoBody key={row.id} row={row} payload={d.value} albumName={albumName} albumPayload={a?.ok ? a.value : null}
          prevId={prevId} nextId={nextId} go={go} /> : null}
    </AppPage>
  );
}

function PhotoBody({ row, payload, albumName, albumPayload, prevId, nextId, go }: {
  row: PhotoRow; payload: PhotoPayload; albumName: string; albumPayload: import('@/lib/photos').AlbumPayload | null;
  prevId: string | null; nextId: string | null; go: (id: string | null) => void;
}) {
  const { userId } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  usePeopleVersion();
  const mine = row.owner_id === userId;
  const notices = useQuery({ queryKey: ['photos', 'tags', row.id], queryFn: () => tagNotices(row.id) });
  const tags = visibleTags(payload, notices.data ?? []);
  const myNotice = (notices.data ?? []).find((t) => t.tagged_id === userId);
  const iAmTagged = tags.some((t) => t.id === userId);
  const [tagMode, setTagMode] = useState(false);
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  const [hl, setHl] = useState<string | null>(null);
  const [editCap, setEditCap] = useState(false);
  const [cap, setCap] = useState(payload.caption ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [report, setReport] = useState(false);
  const { url } = useLazyFileUrl(payload.files.med, true);
  const ph = payload.files.med;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['photos', 'photo', row.id] });
    await qc.invalidateQueries({ queryKey: ['photos', 'tags', row.id] });
    await qc.invalidateQueries({ queryKey: ['photos', 'tagged'] });
    await qc.invalidateQueries({ queryKey: ['photos', 'pendingTags'] });
  };
  const act = async (label: string | null, fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null); setMsg(null);
    try { await fn(); if (label) setMsg(label); await refresh(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  // The owner quietly drops tags the tagged person removed, so the signed payload matches.
  const pruned = useRef(false);
  useEffect(() => {
    if (!mine || pruned.current || !notices.data) return;
    if (tags.length < payload.tags.length) {
      pruned.current = true;
      void updatePhoto(row, { ...payload, tags }).then(() => qc.invalidateQueries({ queryKey: ['photos', 'photo', row.id] })).catch(() => undefined);
    }
  }, [mine, notices.data, tags, payload, row, qc]);

  // ←/→ navigation (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input,textarea,select,[contenteditable="true"]') || t.closest('[role="dialog"]'))) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(prevId); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(nextId); }
      else if (e.key === 'Escape' && (tagMode || pending)) { setPending(null); setTagMode(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, prevId, nextId, tagMode, pending]);

  // Touch swipe left/right.
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const swiped = useRef(false);
  const stage = useRef<HTMLDivElement>(null);

  const onStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (swiped.current) { swiped.current = false; return; }
    if ((e.target as HTMLElement).closest('.kp-tagbox')) return;
    if (tagMode) {
      const r = stage.current!.getBoundingClientRect();
      setPending({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
      return;
    }
    go(nextId);
  };

  const canProfile = mine || iAmTagged;
  const isCover = albumPayload?.coverId === row.id;
  const contentKey = useMemo(() => photoContentKey(row), [row]);

  return (
    <>
      <div className="kp-stagewrap">
        {prevId ? <button className="kp-navbtn p" aria-label="Previous photo" onClick={() => go(prevId)}>&lsaquo;</button> : null}
        <div ref={stage} className={`kp-stage${tagMode ? ' tagging' : nextId ? ' nav' : ''}`}
          onClick={onStageClick}
          onTouchStart={(e) => { const t = e.touches[0]!; touch.current = { x: t.clientX, y: t.clientY, t: Date.now() }; }}
          onTouchEnd={(e) => {
            const s = touch.current; touch.current = null;
            if (!s || tagMode) return;
            const t = e.changedTouches[0]!;
            const dx = t.clientX - s.x, dy = t.clientY - s.y;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - s.t < 800) {
              swiped.current = true;
              go(dx < 0 ? nextId : prevId);
            }
          }}>
          {url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={url} alt={payload.caption || `Photo from ${albumName}`} draggable={false} />
            : <div className="ph0 kp-img ld" role="img" aria-label="Loading photo" style={{ width: Math.min(ph.w ?? 480, 720), maxWidth: '100%', aspectRatio: `${ph.w ?? 4} / ${ph.h ?? 3}` }} />}
          {tags.map((t) => (
            <div key={t.id} className={`kp-tag${hl === t.id ? ' hl' : ''}`} style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%` }} aria-hidden>
              <span>{people.person(t.id)?.name ?? '…'}</span>
            </div>
          ))}
          {pending ? (
            <>
              <div className="kp-tag new" style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%` }} aria-hidden />
              <TagBox at={pending} exclude={tags.map((t) => t.id)} disabled={busy}
                onCancel={() => setPending(null)}
                onPick={(fid) => act(null, async () => { await tagFriend(row, payload, fid, pending.x, pending.y); setPending(null); })} />
            </>
          ) : null}
        </div>
        {nextId ? <button className="kp-navbtn n" aria-label="Next photo" onClick={() => go(nextId)}>&rsaquo;</button> : null}
      </div>
      {tagMode ? <div className="kp-hint" role="status">Click on the photo to tag a friend. <a role="button" tabIndex={0} onClick={() => { setTagMode(false); setPending(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { setTagMode(false); setPending(null); } }}>Done Tagging</a></div> : null}

      <div className="kp-view">
        <div className="main">
          {editCap ? (
            <form className="kp-cap" onSubmit={(e) => { e.preventDefault(); void act('Caption saved.', async () => { const c = cap.trim().slice(0, 2000); const next = { ...payload }; if (c) next.caption = c; else delete next.caption; await updatePhoto(row, next); setEditCap(false); }); }}>
              <textarea aria-label="Caption" value={cap} maxLength={2000} onChange={(e) => setCap(e.target.value)} autoFocus />
              <div style={{ marginTop: 4 }}><button className="btn b" disabled={busy}>Save</button> <button type="button" className="btn" onClick={() => { setEditCap(false); setCap(payload.caption ?? ''); }}>Cancel</button></div>
            </form>
          ) : payload.caption ? <div className="kp-cap">{payload.caption}</div> : null}
          {mine && !editCap ? <div style={{ marginBottom: 6 }}><a role="button" tabIndex={0} onClick={() => setEditCap(true)} onKeyDown={(e) => { if (e.key === 'Enter') setEditCap(true); }}>{payload.caption ? 'Edit Caption' : 'Add a Caption'}</a></div> : null}

          <div className="kp-inph">
            {tags.length ? <>In this photo:{' '}
              {tags.map((t, i) => (
                <span key={t.id} onMouseEnter={() => setHl(t.id)} onMouseLeave={() => setHl(null)} onFocus={() => setHl(t.id)} onBlur={() => setHl(null)}>
                  <NameLink id={t.id} bold={false} />
                  {(mine || t.id === userId) ? <> <a className="gray small" role="button" tabIndex={0}
                    onClick={() => act('Tag removed.', () => removeTag(row, payload, t.id))}
                    onKeyDown={(e) => { if (e.key === 'Enter') void act('Tag removed.', () => removeTag(row, payload, t.id)); }}>(remove tag)</a></> : null}
                  {i < tags.length - 1 ? ', ' : ''}
                </span>
              ))}
            </> : <span className="gray">No one is tagged in this photo.</span>}
          </div>
          {myNotice?.status === 'pending' && iAmTagged && !mine ? (
            <div className="kp-pending">
              <NameLink id={myNotice.tagger_id} /> tagged you in this photo.{' '}
              <button className="btn b" disabled={busy} onClick={() => act('Tag approved.', () => approveTag(row.id))}>Approve</button>{' '}
              <button className="btn" disabled={busy} onClick={() => act('Tag removed.', () => removeTag(row, payload, userId!))}>Remove Tag</button>
            </div>
          ) : null}
          {msg ? <div className="gray" role="status">{msg}</div> : null}
          {err ? <div className="kp-errs" role="alert">{err}</div> : null}

          <PhotoUFI row={row} contentKey={contentKey} />
        </div>

        <div className="side">
          <div><span className="gray">From the album:</span><br /><Link href={`/photos/album/${row.album_id}`}>{albumName}</Link><br />by <NameLink id={row.owner_id} bold={false} /></div>
          <div className="gray small" style={{ marginTop: 4 }}>{row.is_public ? <><Icon name="globe" /> Public — not encrypted</> : <><Icon name="lock" /> Encrypted</>}</div>
          {mine ? <button className="btn act" disabled={busy} onClick={() => { setTagMode((v) => !v); setPending(null); }}>{tagMode ? 'Done Tagging' : 'Tag This Photo'}</button> : null}
          {canProfile ? <a className="act" role="button" tabIndex={0} aria-disabled={busy}
            onClick={() => { if (!busy) void act('This is now your profile picture.', async () => saveAvatar(await profilePictureFromPhoto(row, payload))); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void act('This is now your profile picture.', async () => saveAvatar(await profilePictureFromPhoto(row, payload))); }}>Make Profile Picture</a> : null}
          {mine && albumPayload && !isCover ? <a className="act" role="button" tabIndex={0}
            onClick={() => void act('Album cover updated.', async () => { const al = await getAlbum(row.album_id); if (al) await updateAlbum(al, { ...albumPayload, coverId: row.id }); await qc.invalidateQueries({ queryKey: ['photos'] }); })}
            onKeyDown={(e) => { if (e.key === 'Enter') void act('Album cover updated.', async () => { const al = await getAlbum(row.album_id); if (al) await updateAlbum(al, { ...albumPayload, coverId: row.id }); }); }}>Make Album Cover</a> : null}
          <a className="act" role="button" tabIndex={0}
            onClick={() => void downloadPhoto(payload.files, payload.caption || albumName).catch((e) => setErr(errText(e)))}
            onKeyDown={(e) => { if (e.key === 'Enter') void downloadPhoto(payload.files, payload.caption || albumName).catch((er) => setErr(errText(er))); }}>Download</a>
          {!mine ? <a className="act" role="button" tabIndex={0} onClick={() => setReport(true)} onKeyDown={(e) => { if (e.key === 'Enter') setReport(true); }}>Report This Photo</a> : null}
          {mine ? <a className="act" role="button" tabIndex={0} onClick={() => setConfirmDel(true)} onKeyDown={(e) => { if (e.key === 'Enter') setConfirmDel(true); }}>Delete This Photo</a> : null}
        </div>
      </div>

      {confirmDel && (
        <Confirm title="Delete Photo" action="Delete" onClose={() => setConfirmDel(false)}
          body={<>Are you sure you want to delete this photo? This can&rsquo;t be undone.{isMyAvatar(payload.files) ? <><br /><br />It&rsquo;s your current profile picture, so your picture will be removed too.</> : null}</>}
          onConfirm={async () => {
            const wasAvatar = isMyAvatar(payload.files);
            await deletePhoto(row, payload);
            if (wasAvatar) await saveAvatar(undefined);
            await qc.invalidateQueries({ queryKey: ['photos'] });
            router.push(nextId && nextId !== row.id ? `/photos/${nextId}` : `/photos/album/${row.album_id}`);
          }} />
      )}
      {report && (
        <ReportDialog kind="photo" id={row.id} onClose={() => setReport(false)}
          disclosure={{ plaintext: { caption: payload.caption ?? null, tags: payload.tags, files: payload.files, album: albumName }, contentKey, keyKind: 'content' }} />
      )}
    </>
  );
}

/** Friend picker shown where the photo was clicked. */
function TagBox({ at, exclude, onPick, onCancel, disabled }: { at: { x: number; y: number }; exclude: string[]; onPick: (id: string) => void; onCancel: () => void; disabled: boolean }) {
  const { userId } = useSession();
  const friends = useFriendIds();
  usePeopleVersion();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const all = [...(userId ? [userId] : []), ...(friends.data ?? [])].filter((fid) => !exclude.includes(fid));
  const term = q.trim().toLowerCase();
  const matches = all
    .map((fid) => ({ id: fid, p: people.person(fid) }))
    .filter((x) => !term || (x.p?.name ?? '').toLowerCase().includes(term) || (x.p?.username ?? '').includes(term))
    .sort((x, y) => (x.p?.name ?? '').localeCompare(y.p?.name ?? ''))
    .slice(0, 8);
  const listId = 'kp-tag-list';
  return (
    <div className="kp-tagbox" style={{ left: `${Math.min(85, Math.max(15, at.x * 100))}%`, top: `calc(${at.y * 100}% + 44px)` }} onClick={(e) => e.stopPropagation()}>
      <input type="text" autoFocus placeholder="Type any name" value={q} disabled={disabled}
        role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list" aria-label="Who is this?"
        aria-activedescendant={matches[sel] ? `kp-tag-${matches[sel]!.id}` : undefined}
        onChange={(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(matches.length - 1, s + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); if (matches[sel]) onPick(matches[sel]!.id); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }} />
      <ul id={listId} role="listbox" aria-label="Friends">
        {matches.map((m, i) => (
          <li key={m.id} id={`kp-tag-${m.id}`} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''}
            onMouseEnter={() => setSel(i)} onClick={() => { if (!disabled) onPick(m.id); }}>
            <Avatar id={m.id} size={20} />{m.id === userId ? `${m.p?.name ?? 'Me'} (me)` : m.p?.name ?? '…'}
          </li>
        ))}
        {!matches.length ? <li className="gray" aria-disabled>No matching friends.</li> : null}
      </ul>
      <div className="b"><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Likes & comments (UFI).
function PhotoUFI({ row, contentKey }: { row: PhotoRow; contentKey: Uint8Array | null }) {
  const { userId } = useSession();
  const qc = useQueryClient();
  usePeopleVersion();
  const comments = useQuery({
    queryKey: ['comments', row.id],
    queryFn: async () => {
      const rows = must(await sb().from('comments').select('*').eq('photo_id', row.id).order('created_at')) as CommentRow[];
      await people.ensure(rows.map((c) => c.author_id));
      return rows;
    },
  });
  const cids = (comments.data ?? []).map((c) => c.id);
  const likes = useQuery({
    queryKey: ['likes', 'photo', row.id, cids.join(',')],
    queryFn: async () => {
      const ph = must(await sb().from('likes').select('user_id').eq('target_kind', 'photo').eq('target_id', row.id)) as { user_id: string }[];
      const cl = cids.length ? must(await sb().from('likes').select('target_id,user_id').eq('target_kind', 'comment').in('target_id', cids)) as { target_id: string; user_id: string }[] : [];
      await people.ensure(ph.map((l) => l.user_id));
      return { photo: ph.map((l) => l.user_id), comments: cl };
    },
  });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const likers = likes.data?.photo ?? [];
  const iLike = !!userId && likers.includes(userId);
  const canWrite = row.is_public || !!contentKey;

  const toggleLike = async () => {
    setErr(null);
    try {
      await setLike('photo', row.id, !iLike);
      if (!iLike) await notifyPhotoOwner(row, 'like');
    } catch (e) { setErr(errText(e)); }
    await qc.invalidateQueries({ queryKey: ['likes', 'photo', row.id] });
  };
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setErr(null);
    try {
      await addComment({ photoId: row.id, contentKey }, t.slice(0, 4000));
      await notifyPhotoOwner(row, 'comment', t);
      setText('');
      await qc.invalidateQueries({ queryKey: ['comments', row.id] });
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  const cs = comments.data ?? [];
  const show = all || cs.length <= 4 ? cs : cs.slice(-2);
  return (
    <>
      <div className="sf" style={{ marginBottom: 4 }}>
        <a role="button" tabIndex={0} onClick={() => void toggleLike()} onKeyDown={(e) => { if (e.key === 'Enter') void toggleLike(); }}>{iLike ? 'Unlike' : 'Like'}</a> &middot;{' '}
        <a role="button" tabIndex={0} onClick={() => { setOpen(true); setTimeout(() => box.current?.focus(), 0); }} onKeyDown={(e) => { if (e.key === 'Enter') { setOpen(true); setTimeout(() => box.current?.focus(), 0); } }}>Comment</a> &middot;{' '}
        <span className="gray">Added {when(row.created_at)}</span>
      </div>
      <div className="ufi">
        {likers.length ? <div className="ur"><Icon name="like" /><div><LikeText ids={likers} /></div></div> : null}
        {cs.length > show.length ? <div className="ur"><Icon name="comment" /><a role="button" tabIndex={0} onClick={() => setAll(true)} onKeyDown={(e) => { if (e.key === 'Enter') setAll(true); }}>View all {cs.length} comments</a></div> : null}
        {show.map((c) => (
          <CommentItem key={c.id} c={c} contentKey={contentKey} canDelete={c.author_id === userId || row.owner_id === userId}
            likes={(likes.data?.comments ?? []).filter((l) => l.target_id === c.id).map((l) => l.user_id)}
            onChanged={() => { void qc.invalidateQueries({ queryKey: ['comments', row.id] }); void qc.invalidateQueries({ queryKey: ['likes', 'photo', row.id] }); }} />
        ))}
        {canWrite && (open || cs.length > 0) ? (
          <div className="ur">
            <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
              {userId ? <Avatar id={userId} size={32} /> : null}
              <textarea ref={box} placeholder="Write a comment..." aria-label="Write a comment" value={text} maxLength={4000} disabled={busy}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            </form>
          </div>
        ) : null}
        {!canWrite ? <div className="ur gray">Waiting for the owner&rsquo;s device to share this photo&rsquo;s key with you.</div> : null}
      </div>
      {err ? <div className="kp-errs" role="alert">{err}</div> : null}
    </>
  );
}

function CommentItem({ c, contentKey, canDelete, likes, onChanged }: { c: CommentRow; contentKey: Uint8Array | null; canDelete: boolean; likes: string[]; onChanged: () => void }) {
  const { userId } = useSession();
  usePeopleVersion();
  const d = readComment(c, contentKey);
  const author = usePerson(c.author_id);
  const iLike = !!userId && likes.includes(userId);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="ur">
      <AvatarLink id={c.author_id} size={32} />
      <div className="cmb">
        <NameLink id={c.author_id} />{' '}
        {d.ok ? <span style={{ whiteSpace: 'pre-wrap' }}>{d.value.text}</span>
          : d.reason === 'unverified' ? <span className="gray">This item couldn&rsquo;t be verified.</span>
            : <span className="gray">Waiting for {author?.name ?? 'the author'}&rsquo;s device to share this with you.</span>}
        <div className="ct">
          {when(c.created_at)} &middot;{' '}
          <a role="button" tabIndex={0} onClick={() => void setLike('comment', c.id, !iLike).then(onChanged)} onKeyDown={(e) => { if (e.key === 'Enter') void setLike('comment', c.id, !iLike).then(onChanged); }}>{iLike ? 'Unlike' : 'Like'}</a>
          {likes.length ? <> &middot; <Icon name="like" />{plural(likes.length, 'person', 'people')}</> : null}
          {canDelete ? <> &middot; <a role="button" tabIndex={0} onClick={() => setConfirm(true)} onKeyDown={(e) => { if (e.key === 'Enter') setConfirm(true); }}>Remove</a></> : null}
        </div>
      </div>
      {confirm && <Confirm title="Remove Comment" body="Are you sure you want to remove this comment?" action="Remove" onClose={() => setConfirm(false)}
        onConfirm={async () => { must(await sb().from('comments').delete().eq('id', c.id)); onChanged(); }} />}
    </div>
  );
}

function LikeText({ ids }: { ids: string[] }) {
  const { userId } = useSession();
  usePeopleVersion();
  const me = !!userId && ids.includes(userId);
  const others = ids.filter((x) => x !== userId);
  const named = others.slice(0, me ? 1 : 2);
  const rest = others.length - named.length;
  const parts: React.ReactNode[] = [];
  if (me) parts.push('You');
  named.forEach((x) => parts.push(<NameLink key={x} id={x} bold={false} />));
  if (rest > 0) parts.push(`${rest} other${rest > 1 ? 's' : ''}`);
  const joined = parts.flatMap((p, i) => (i === 0 ? [p] : [i === parts.length - 1 ? ' and ' : ', ', p]));
  const single = parts.length === 1 && !me;
  return <>{joined.map((p, i) => <span key={i}>{p}</span>)} {single ? 'likes' : 'like'} this.</>;
}

export type { TagNotice };
