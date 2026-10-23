'use client';
// Full-screen photo/video viewer: swipe between items, pinch / double-tap / ctrl+wheel to zoom,
// swipe down to close, arrow keys and Esc. Side panel (bottom sheet on phones) with caption, tags,
// comments, download and delete. Everything shown here was decrypted on this device.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale, useT } from '@/i18n';
import { me } from '@/lib/keys/session';
import { useFileUrl } from '@/lib/media';
import { useFriendIds } from '@/lib/hooks';
import { usePerson } from '@/lib/people';
import { Button, IconButton } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Textarea } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';
import { PersonAvatar, PersonName, SealedNote } from '@/components/circles/shared';
import {
  commentOnPhoto, deleteComment, downloadOriginal, readMedia, readPhotoComment, removeMedia, removeTag, tagFriend, updatePhoto,
  usePhotoComments, type AlbumRow, type MediaPayload, type PhotoRow,
} from './data';
import { Stage } from '@/components/gallery/Stage';
import { useVideoUrl } from '@/components/gallery/useVideoUrl';

// ---------------------------------------------------------------------------------------
// Video (the gesture stage and the video loader are shared with the post / chat gallery, components/gallery)

function VideoView({ p }: { p: MediaPayload }) {
  const t = useT();
  const poster = useFileUrl(p.files.med);
  const v = useVideoUrl(p.video?.file);
  if (v.url) return <video className="kv-video" src={v.url} poster={poster ?? undefined} controls playsInline autoPlay />;
  return (
    <div className="kv-video-wait">
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster} alt="" className="kv-img" />
      ) : null}
      <div className="kv-video-status" role="status">
        {v.error ? <><Icon name="alert" /> {t('albums.videoFailed')}</> : <><Spinner /> {t('albums.decryptingVideo', { pct: Math.round(v.progress * 100) })}</>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Details panel

function TagChip({ id, canRemove, onRemove }: { id: string; canRemove: boolean; onRemove: () => void }) {
  const t = useT();
  const p = usePerson(id);
  return (
    <li className="kv-chip">
      <PersonAvatar id={id} size={20} /><span>{p?.name ?? '…'}</span>
      {canRemove ? <button type="button" className="kv-chip-x" aria-label={t('albums.removeTag', { name: p?.name ?? '' })} onClick={onRemove}><Icon name="close" /></button> : null}
    </li>
  );
}

function Comments({ row }: { row: PhotoRow }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const q = usePhotoComments(row.id);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try { await commentOnPhoto(row, text); setText(''); void qc.invalidateQueries({ queryKey: ['comments', row.id] }); }
    catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); }
    setBusy(false);
  };
  return (
    <section className="k-stack-sm" aria-label={t('albums.comments')}>
      <h3 className="k-section-title">{t('albums.comments')}</h3>
      {q.data?.length ? (
        <ul className="kv-comments" role="list">
          {q.data.map((c) => {
            const r = readPhotoComment(c, row);
            return (
              <li key={c.id} className="kv-comment">
                <PersonAvatar id={c.author_id} size={28} />
                <div className="kv-comment-body">
                  <span className="kv-comment-name"><PersonName id={c.author_id} /></span>
                  {r.ok ? <p dir="auto" className="kv-comment-text">{r.value.text}</p> : <SealedNote reason={r.reason} />}
                </div>
                {c.author_id === me() || row.owner_id === me() ? (
                  <IconButton icon="close" size="sm" label={t('albums.deleteComment')}
                    onClick={() => void deleteComment(c).then(() => qc.invalidateQueries({ queryKey: ['comments', row.id] }))} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="k-small k-muted">{t('albums.noComments')}</p>}
      <form className="kv-comment-form" onSubmit={(e) => void send(e)}>
        <Textarea label={t('albums.addComment')} hideLabel rows={2} value={text} maxLength={8000} placeholder={t('albums.addComment')} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!text.trim()}>{t('albums.send')}</Button>
      </form>
    </section>
  );
}

function Caption({ row, p }: { row: PhotoRow; p: MediaPayload }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const owner = row.owner_id === me();
  const [text, setText] = useState(p.caption ?? '');
  const [busy, setBusy] = useState(false);
  if (!owner) return p.caption ? <p dir="auto" className="kv-caption">{p.caption}</p> : null;
  const dirty = text.trim() !== (p.caption ?? '');
  const save = async () => {
    setBusy(true);
    try {
      const next: MediaPayload = { ...p };
      if (text.trim()) next.caption = text.trim().slice(0, 2000); else delete next.caption;
      await updatePhoto(row, next);
      void qc.invalidateQueries({ queryKey: ['albums', 'media', row.album_id] });
    } catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); }
    setBusy(false);
  };
  return (
    <div className="k-stack-sm">
      <Textarea label={t('albums.caption')} rows={2} value={text} maxLength={2000} placeholder={t('albums.captionPh')} onChange={(e) => setText(e.target.value)} />
      {dirty ? <div><Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>{t('circles.ui.save')}</Button></div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------

export function MediaViewer({ album, rows, currentId, onChange, onClose }: {
  album: AlbumRow; rows: PhotoRow[]; currentId: string; onChange: (id: string) => void; onClose: () => void;
}) {
  const t = useT();
  const { dir } = useLocale();
  const rtl = dir === 'rtl';
  const qc = useQueryClient();
  const toast = useToast();
  const friends = useFriendIds();
  const rootRef = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, rows.findIndex((r) => r.id === currentId));
  const row = rows[idx]!;
  const d = readMedia(row);
  const p = d.ok ? d.value : null;
  const big = useFileUrl(p && !p.video ? p.files.big : null);
  const med = useFileUrl(p && !p.video ? p.files.med : null);
  const owner = row.owner_id === me();
  const [panel, setPanel] = useState(false);
  const [tagMode, setTagMode] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [pendingTag, setPendingTag] = useState<{ x: number; y: number } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const go = (delta: number) => {
    const n = idx + delta;
    if (n >= 0 && n < rows.length) { setTagMode(false); onChange(rows[n]!.id); }
  };
  const goRef = useRef(go);
  const closeCb = useRef(onClose);
  useEffect(() => { goRef.current = go; closeCb.current = onClose; });

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    const root = document.documentElement;
    const prevOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeCb.current(); }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (e.key === 'ArrowRight') goRef.current(rtl ? -1 : 1);
      if (e.key === 'ArrowLeft') goRef.current(rtl ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); root.style.overflow = prevOverflow; prevFocus?.focus?.(); };
  }, [rtl]);

  const onTap = (cx: number, cy: number) => {
    const r = imgRef.current?.getBoundingClientRect();
    if (!r || cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return;
    setPendingTag({ x: (cx - r.left) / r.width, y: (cy - r.top) / r.height });
  };
  const addTag = async (id: string) => {
    if (!p || !pendingTag) return;
    setBusy('tag');
    try {
      await tagFriend(row, p, id, pendingTag.x, pendingTag.y);
      void qc.invalidateQueries({ queryKey: ['albums', 'media', album.id] });
      setShowTags(true);
    } catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); }
    setPendingTag(null); setTagMode(false); setBusy(null);
  };
  const untag = async (id: string) => {
    if (!p) return;
    try { await removeTag(row, p, id); void qc.invalidateQueries({ queryKey: ['albums', 'media', album.id] }); }
    catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); }
  };
  const download = async () => {
    if (!p) return;
    setBusy('download');
    try { await downloadOriginal(p, p.caption || (p.video ? 'video' : 'photo')); }
    catch { toast({ message: t('albums.downloadFailed'), tone: 'danger' }); }
    setBusy(null);
  };
  const remove = async () => {
    setBusy('delete');
    try {
      await removeMedia(row, p ?? undefined);
      const next = rows[idx + 1] ?? rows[idx - 1];
      void qc.invalidateQueries({ queryKey: ['albums'] });
      setConfirmDel(false);
      if (next) onChange(next.id); else onClose();
    } catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); }
    setBusy(null);
  };

  const tags = p?.tags ?? [];
  const candidates = [...new Set([me(), ...(friends.data ?? [])])].filter((id) => !tags.some((x) => x.id === id));

  return (
    <div ref={rootRef} tabIndex={-1} className="kv" role="dialog" aria-modal="true" aria-label={t('albums.viewer', { n: idx + 1, total: rows.length })}>
      <div className="kv-bar">
        <IconButton icon="close" label={t('common.close')} onClick={onClose} />
        <span className="kv-count">{t('albums.position', { n: idx + 1, total: rows.length })}</span>
        <span className="k-spacer" />
        {tags.length && !p?.video ? <IconButton icon="users" label={showTags ? t('albums.hideTags') : t('albums.showTags')} aria-pressed={showTags} onClick={() => setShowTags((x) => !x)} /> : null}
        <IconButton icon="download" label={t('albums.download')} onClick={() => void download()} disabled={!p || busy === 'download'} />
        {owner ? <IconButton icon="trash" className="kv-del" label={t('albums.deleteItem')} onClick={() => setConfirmDel(true)} /> : null}
        <IconButton icon="info" label={t('albums.details')} aria-pressed={panel} onClick={() => setPanel((x) => !x)} className="kv-info-btn" />
      </div>

      <div className={cx('kv-body', panel && 'kv-body-panel')}>
        <div className="kv-main">
          {!p ? <div className="kv-sealed"><SealedNote reason={d.ok ? 'unverified' : d.reason} /></div>
            : p.video ? <VideoView key={row.id} p={p} /> : (
              <Stage resetKey={row.id} rtl={rtl} tagMode={tagMode} onTap={onTap}
                onSwipe={(a) => (a === 'close' ? onClose() : go(a === 'next' ? 1 : -1))}>
                <div className="kv-frame">
                  {big || med ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img ref={imgRef} src={big ?? med ?? undefined} alt={p.caption ?? ''} className="kv-img" draggable={false} />
                  ) : <Spinner />}
                  {(showTags || tagMode) && tags.map((tg) => (
                    <span key={tg.id} className="kv-tag" style={{ left: `${tg.x * 100}%`, top: `${tg.y * 100}%` }}><PersonName id={tg.id} /></span>
                  ))}
                  {pendingTag ? <span className="kv-tag kv-tag-pending" style={{ left: `${pendingTag.x * 100}%`, top: `${pendingTag.y * 100}%` }} aria-hidden>+</span> : null}
                </div>
              </Stage>
            )}
          {idx > 0 ? <button type="button" className="kv-nav kv-prev" aria-label={t('albums.previous')} onClick={() => go(-1)}><Icon name="back" /></button> : null}
          {idx < rows.length - 1 ? <button type="button" className="kv-nav kv-next" aria-label={t('albums.next')} onClick={() => go(1)}><Icon name="forward" /></button> : null}
          {tagMode ? <p className="kv-hint" role="status">{t('albums.tapToTag')}</p> : null}
        </div>

        <aside className="kv-panel" aria-label={t('albums.details')}>
          {p ? (
            <div className="k-stack">
              <div className="k-row">
                <PersonAvatar id={row.owner_id} size={32} />
                <span className="k-small"><PersonName id={row.owner_id} /></span>
              </div>
              <Caption key={`cap-${row.id}`} row={row} p={p} />
              {!p.video ? (
                <section className="k-stack-sm" aria-label={t('albums.tags')}>
                  <h3 className="k-section-title">{t('albums.tags')}</h3>
                  {tags.length ? (
                    <ul className="kv-chips" role="list">
                      {tags.map((tg) => <TagChip key={tg.id} id={tg.id} canRemove={owner || tg.id === me()} onRemove={() => void untag(tg.id)} />)}
                    </ul>
                  ) : <p className="k-small k-muted">{t('albums.noTags')}</p>}
                  {owner ? <div><Button size="sm" variant={tagMode ? 'primary' : 'secondary'} icon="users" onClick={() => setTagMode((x) => !x)}>{tagMode ? t('albums.doneTagging') : t('albums.tagPeople')}</Button></div> : null}
                </section>
              ) : null}
              <Comments key={`com-${row.id}`} row={row} />
            </div>
          ) : null}
        </aside>
      </div>

      <Dialog open={!!pendingTag} onClose={() => setPendingTag(null)} title={t('albums.whoIsThis')} sheet>
        <ul className="k-list" role="list">
          {candidates.map((id) => <TagCandidate key={id} id={id} disabled={busy === 'tag'} onPick={() => void addTag(id)} />)}
        </ul>
      </Dialog>
      <Dialog open={confirmDel} onClose={() => { if (!busy) setConfirmDel(false); }} title={t('albums.deleteItemTitle')}
        footer={<>
          <Button variant="secondary" disabled={!!busy} onClick={() => setConfirmDel(false)}>{t('circles.ui.cancel')}</Button>
          <Button variant="danger" busy={busy === 'delete'} onClick={() => void remove()}>{t('albums.deleteItem')}</Button>
        </>}>
        <p>{t('albums.deleteItemBody')}</p>
      </Dialog>
    </div>
  );
}

function TagCandidate({ id, onPick, disabled }: { id: string; onPick: () => void; disabled: boolean }) {
  const t = useT();
  const p = usePerson(id);
  return (
    <li>
      <button type="button" className="k-item" onClick={onPick} disabled={disabled}>
        <span className="k-item-lead"><PersonAvatar id={id} size={36} /></span>
        <span className="k-item-body"><span className="k-item-title">{id === me() ? t('circles.members.you') : p?.name ?? '…'}</span></span>
      </button>
    </li>
  );
}
