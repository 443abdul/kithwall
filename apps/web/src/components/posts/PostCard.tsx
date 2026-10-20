'use client';
// One post in a feed: author, relative time, audience, text (safe links), photos + lightbox, encrypted
// video, link preview / click-to-play embed, a heart (counts only for the author — calm, no public
// like counts), one-level comments, and edit / delete / report.
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { editPost, postContentKey, readPost, setLike } from '@/lib/content';
import { clean, fetchPostLikes, likesKey, notifySafe } from '@/lib/feed/feed';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { usePeopleVersion, usePerson } from '@/lib/people';
import { useFileUrl } from '@/lib/media';
import type { LikeRow, PostPayload, PostRow } from '@/lib/types';
import { AudienceTag, NoteText, RelativeTime, RichText } from './bits';
import { Comments, useComments } from './Comments';
import { audienceOf, deletePostFully } from './data';
import { Lightbox, LinkCard, PhotoGrid, VideoPlayer } from './Media';
import { Menu } from './Menu';
import { ReportDialog } from './ReportDialog';

export function PostCardSkeleton() {
  return (
    <Card className="k-post" aria-hidden>
      <div className="k-post-head">
        <Skeleton circle width={44} height={44} />
        <div className="k-post-who"><Skeleton text width="40%" /><Skeleton text width="25%" /></div>
      </div>
      <Skeleton text width="95%" /><Skeleton text width="80%" /><Skeleton text width="60%" />
    </Card>
  );
}

/** `expanded`: the post permalink (/post/[id]) shows the comments open. */
export function PostCard({ row, onRemoved, expanded = false }: { row: PostRow; onRemoved?: (id: string) => void; expanded?: boolean }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { userId } = useSession();
  useKeyringVersion();
  usePeopleVersion();
  const author = usePerson(row.author_id);
  const avatar = useFileUrl(author?.info?.avatar?.thumb);
  const d = readPost(row);
  const payload = d.ok ? d.value : null;
  const mine = row.author_id === userId;
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [focusComment, setFocusComment] = useState(0);
  const [showComments, setShowComments] = useState(expanded);

  const likes = useQuery({ queryKey: likesKey('post', row.id), queryFn: () => fetchPostLikes('post', row.id) });
  const comments = useComments(row.id);
  const liked = !!likes.data?.some((l) => l.user_id === userId);
  const likeCount = likes.data?.length ?? 0;
  const commentCount = comments.data?.length ?? 0;

  async function toggleLike() {
    if (!userId) return;
    const key = likesKey('post', row.id);
    const prev = qc.getQueryData<LikeRow[]>(key) ?? [];
    const next = liked ? prev.filter((l) => l.user_id !== userId)
      : [...prev, { target_kind: 'post' as const, target_id: row.id, user_id: userId, created_at: new Date().toISOString() }];
    qc.setQueryData(key, next);
    try {
      await setLike('post', row.id, !liked);
      if (!liked) await notifySafe(row.author_id, 'like', 'post', row.id);
    } catch {
      qc.setQueryData(key, prev);
      toast({ message: t('feed.failed'), tone: 'danger' });
    }
  }

  const name = author?.name ?? '…';
  const profileHref = author ? `/u/${author.username}` : undefined;
  const menu = [
    ...(mine && payload ? [{ label: t('feed.edit'), icon: 'edit' as const, onSelect: () => setEditing(true) }] : []),
    ...(mine || row.wall_owner_id === userId ? [{ label: t('feed.delete'), icon: 'trash' as const, danger: true, onSelect: () => setDeleting(true) }] : []),
    ...(!mine ? [{ label: t('feed.report'), icon: 'flag' as const, onSelect: () => setReporting(true) }] : []),
  ];
  const contentKey = () => postContentKey(row);

  return (
    <Card as="article" className="k-post" aria-label={name}>
      <header className="k-post-head">
        {profileHref ? <Link href={profileHref} className="k-post-av" tabIndex={-1} aria-hidden><Avatar name={name} src={avatar} size={44} /></Link>
          : <Avatar name={name} src={avatar} size={44} />}
        <div className="k-post-who">
          {profileHref ? <Link href={profileHref} className="k-post-name">{name}</Link> : <span className="k-post-name">{name}</span>}
          <span className="k-post-meta">
            <RelativeTime iso={row.created_at} />
            {row.edited_at ? <span className="k-muted">· {t('feed.edited')}</span> : null}
            <span aria-hidden>·</span>
            <AudienceTag audience={audienceOf(row)} />
          </span>
        </div>
        <Menu label={t('feed.postMenu')} items={menu} />
      </header>

      {!d.ok ? (
        d.reason === 'waiting'
          ? <p className="k-post-waiting k-muted k-small"><Icon name="key" /> {t('feed.waitingKey', { name })}</p>
          : <p className="k-post-waiting k-muted k-small"><Icon name="alert" /> {t('feed.unverified')}</p>
      ) : (
        <PostBody payload={d.value} onOpenPhoto={setLightbox} />
      )}

      {d.ok ? (
        <>
          <div className="k-post-actions">
            <button type="button" className="k-action" aria-pressed={liked} data-on={liked ? '' : undefined} onClick={() => void toggleLike()}>
              <Icon name="heart" /><span>{liked ? t('feed.liked') : t('feed.like')}</span>
            </button>
            <button type="button" className="k-action" aria-expanded={showComments || commentCount > 0}
              onClick={() => { setShowComments(true); setFocusComment((n) => n + 1); }}>
              <Icon name="comment" /><span>{commentCount ? t('feed.commentCount', { count: commentCount }) : t('feed.comment')}</span>
            </button>
            {mine && likeCount > 0 ? (
              <span className="k-post-likes k-small k-muted" title={t('feed.likeCountPrivate')}>
                <Icon name="lock" /> {t('feed.likeCount', { count: likeCount })}
              </span>
            ) : null}
          </div>
          {showComments || commentCount > 0 ? <Comments post={row} contentKey={postContentKey(row)} focusSignal={focusComment} /> : null}
        </>
      ) : null}

      {lightbox !== null && payload?.photos?.length ? (
        <Lightbox photos={payload.photos} index={lightbox} onClose={() => setLightbox(null)} />
      ) : null}
      {editing && payload ? <EditDialog row={row} payload={payload} onClose={() => setEditing(false)} /> : null}
      <Dialog open={deleting} onClose={() => setDeleting(false)} title={t('feed.deleteTitle')}
        footer={<>
          <Button variant="ghost" onClick={() => setDeleting(false)}>{t('feed.cancel')}</Button>
          <Button variant="danger" onClick={() => {
            void deletePostFully(row, payload).then(() => {
              setDeleting(false);
              toast({ message: t('feed.deleted') });
              onRemoved?.(row.id);
              void qc.invalidateQueries({ queryKey: ['v2feed'] });
            }).catch(() => toast({ message: t('feed.failed'), tone: 'danger' }));
          }}>{t('feed.delete')}</Button>
        </>}>
        <p>{t('feed.deleteBody')}</p>
      </Dialog>
      <ReportDialog open={reporting} onClose={() => setReporting(false)} kind="post" id={row.id}
        disclosure={() => (payload ? { plaintext: payload, contentKey: contentKey(), keyKind: 'content' } : undefined)} />
    </Card>
  );
}

export function PostBody({ payload, onOpenPhoto }: { payload: PostPayload; onOpenPhoto: (i: number) => void }) {
  const text = [payload.text, payload.sharedText, payload.question?.text, payload.checkin?.place, payload.lifeEvent?.title]
    .filter(Boolean).join('\n\n');
  return (
    <div className="k-post-body">
      {payload.note ? (
        <div className="k-post-note">
          <h3 dir="auto">{payload.note.title}</h3>
          <NoteText md={payload.note.body} />
        </div>
      ) : null}
      {text ? <RichText text={text} className="k-post-text" /> : null}
      {payload.photos?.length ? <PhotoGrid photos={payload.photos} onOpen={onOpenPhoto} /> : null}
      {payload.video ? <VideoPlayer video={payload.video} /> : null}
      {payload.link ? <LinkCard link={payload.link} /> : null}
    </div>
  );
}

function EditDialog({ row, payload, onClose }: { row: PostRow; payload: PostPayload; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState(payload.text ?? '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const next: PostPayload = { ...payload };
      const v = text.trim().slice(0, 8000);
      if (v) next.text = v; else delete next.text;
      await editPost(row, clean(next));
      await qc.invalidateQueries({ queryKey: ['v2feed'] });
      toast({ message: t('feed.saved') });
      onClose();
    } catch {
      toast({ message: t('feed.failed'), tone: 'danger' });
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={t('feed.editTitle')} sheet dismissible={!busy}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t('feed.cancel')}</Button>
        <Button variant="primary" onClick={() => void save()} busy={busy}>{t('feed.save')}</Button>
      </>}>
      <Textarea label={t('feed.editTitle')} hideLabel value={text} rows={6} maxLength={8000} dir="auto" onChange={(e) => setText(e.target.value)} />
    </Dialog>
  );
}
