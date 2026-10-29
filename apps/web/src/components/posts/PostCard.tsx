'use client';
// One post in a feed: author, relative time, audience, text (safe links), photos and encrypted video (a tap
// opens the pop-out gallery, components/gallery), link preview / click-to-play embed, a heart (counts only for the author — calm, no public
// like counts), one-level comments, and edit / delete / report. Phase 3: a disappearing post shows how long
// it has left and leaves the screen the moment it expires; the author's scheduled post says when it goes out.
// Batch 1 (docs/v2/roadmap-2026-11.md): emoji reactions (encrypted; the author sees the breakdown), polls,
// reposts, save, mute the author, and pin to my profile.
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea, TextField } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { editPost, postContentKey, readPost } from '@/lib/content';
import { clean } from '@/lib/feed/feed';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { usePeopleVersion, usePerson } from '@/lib/people';
import { useFileUrl } from '@/lib/media';
import type { PostPayload, PostRow } from '@/lib/types';
import { AudienceTag, NoteText, RelativeTime, RichText } from './bits';
import { Comments, useComments } from './Comments';
import { audienceOf, deletePostFully } from './data';
import { LinkCard, PhotoGrid, VideoPlayer } from './Media';
import { Menu } from './Menu';
import { ReportDialog } from './ReportDialog';
import { useClock } from '@/lib/chat/clock';
import { isExpired, isScheduled, timeLeft } from '@/lib/chat/ephemeral';
import { useWhen } from './PostOptions';
import { usePostLike } from './useLike';
import { PollView } from './Poll';
import { SharedPost, ShareDialog } from './Share';
import { REACTIONS, reactionOf, setReaction, type Reaction } from '@/lib/social/engage';
import { isSaved, loadSocialPrefs, setMuted, setSaved, useSocialPrefs } from '@/lib/social/prefs';
import { myInfo, saveProfileInfo } from '@/lib/friends';
import { likesKey, notifySafe } from '@/lib/feed/feed';
import { postItems, postVideoIndex } from '@/components/gallery/items';

// The gallery is its own chunk, loaded the first time someone opens a photo or video.
const Gallery = dynamic(() => import('@/components/gallery/Gallery'), { ssr: false });

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
export function PostCard({ row, onRemoved, expanded = false, pinned = false }: { row: PostRow; onRemoved?: (id: string) => void; expanded?: boolean; pinned?: boolean }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { userId, status } = useSession();
  useKeyringVersion();
  usePeopleVersion();
  const author = usePerson(row.author_id);
  const avatar = useFileUrl(author?.info?.avatar?.thumb);
  const d = readPost(row);
  const payload = d.ok ? d.value : null;
  const mine = row.author_id === userId;
  const [gallery, setGallery] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [focusComment, setFocusComment] = useState(0);
  const [showComments, setShowComments] = useState(expanded);
  const now = useClock([row]);
  const when = useWhen();
  const [sharing, setSharing] = useState(false);
  const [picker, setPicker] = useState(false);
  const prefs = useSocialPrefs();
  useEffect(() => { if (status === 'ready') void loadSocialPrefs().catch(() => undefined); }, [status]);
  const saved = isSaved(prefs, row.id);
  const isPinned = mine && myInfo()?.pinnedPost === row.id;
  const canPin = mine && row.wall_owner_id === userId && !row.group_id && !row.event_id;

  // Feeds seed the per-post likes / comments caches in two batched queries per page (prefetchEngagement)
  // and Realtime keeps them current, so remounting a feed doesn't refetch every card one by one.
  const like = usePostLike(row);
  const comments = useComments(row.id);
  const liked = like.liked;
  const likeCount = like.count;
  const commentCount = comments.data?.length ?? 0;
  const toggleLike = like.toggle;
  const myLike = like.rows.find((l) => l.user_id === userId) ?? null;
  const myReaction: Reaction | null = myLike ? reactionOf(row, myLike) : null;
  // The author sees how many of each reaction (still nobody else sees counts).
  const breakdown = useMemo(() => {
    if (!mine) return [] as [Reaction, number][];
    const m = new Map<Reaction, number>();
    for (const l of like.rows) { const e = reactionOf(row, l); m.set(e, (m.get(e) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [mine, like.rows, row]);
  async function react(e: Reaction | null) {
    setPicker(false);
    try {
      await setReaction(row, e);
      await qc.invalidateQueries({ queryKey: likesKey('post', row.id) });
      if (e && !liked) await notifySafe(row.author_id, 'like', 'post', row.id);
    } catch { toast({ message: t('feed.failed'), tone: 'danger' }); }
  }
  const items = useMemo(() => (payload ? postItems(payload) : []), [payload]);
  const galleryPost = useMemo(() => (payload ? { row, payload } : null), [row, payload]);

  const name = author?.name ?? '…';
  const profileHref = author ? `/u/${author.username}` : undefined;
  async function run(fn: () => Promise<unknown>, done: MessageKey) {
    try { await fn(); toast({ message: t(done) }); } catch { toast({ message: t('feed.failed'), tone: 'danger' }); }
  }
  const pin = (on: boolean) => run(async () => {
    const info = myInfo();
    if (!info) throw new Error('profile not loaded');
    const next = { ...info };
    if (on) next.pinnedPost = row.id; else delete next.pinnedPost;
    await saveProfileInfo(next);
    await qc.invalidateQueries({ queryKey: ['pinned-post'] });
  }, on ? 'post.pinned' : 'post.unpinned');
  const menu = [
    ...(payload ? [{ label: saved ? t('post.unsave') : t('post.save'), icon: 'book' as const, onSelect: () => void run(() => setSaved(row.id, !saved), saved ? 'post.unsaved' : 'post.saved') }] : []),
    ...(canPin && payload ? [{ label: isPinned ? t('post.unpin') : t('post.pin'), icon: 'mapPin' as const, onSelect: () => void pin(!isPinned) }] : []),
    ...(!mine ? [{ label: t('post.mute', { name }), icon: 'eyeOff' as const, onSelect: () => void run(() => setMuted(row.author_id, 30), 'post.muted') }] : []),
    ...(mine && payload ? [{ label: t('feed.edit'), icon: 'edit' as const, onSelect: () => setEditing(true) }] : []),
    ...(mine || row.wall_owner_id === userId ? [{ label: t('feed.delete'), icon: 'trash' as const, danger: true, onSelect: () => setDeleting(true) }] : []),
    ...(!mine ? [{ label: t('feed.report'), icon: 'flag' as const, onSelect: () => setReporting(true) }] : []),
  ];
  const contentKey = () => postContentKey(row);

  // Gone the moment its timer runs out (the server hides it then too, and deletes it within a minute).
  if (isExpired(row, now)) return null;
  const left = row.expires_at ? timeLeft(row.expires_at, now) : null;
  const scheduled = isScheduled(row, now);

  return (
    <Card as="article" className="k-post" aria-label={name}>
      <header className="k-post-head">
        {profileHref ? <Link href={profileHref} className="k-post-av" tabIndex={-1} aria-hidden><Avatar name={name} src={avatar} size={44} /></Link>
          : <Avatar name={name} src={avatar} size={44} />}
        <div className="k-post-who">
          {profileHref ? <Link href={profileHref} className="k-post-name">{name}</Link> : <span className="k-post-name">{name}</span>}
          <span className="k-post-meta">
            {pinned ? <span className="k-pin-tag"><Icon name="mapPin" /> {t('post.pinnedTag')} ·</span> : null}
            <RelativeTime iso={row.created_at} />
            {row.edited_at ? <span className="k-muted">· {t('feed.edited')}</span> : null}
            {left ? (
              <span className="k-eph-left" title={t('ephemeral.post.label')}>
                <span aria-hidden>·</span> <Icon name="clock" /> {t(`ephemeral.left.${left.unit}` as MessageKey, { count: left.count })}
              </span>
            ) : null}
            <span aria-hidden>·</span>
            <AudienceTag audience={audienceOf(row)} />
          </span>
        </div>
        <Menu label={t('feed.postMenu')} items={menu} />
      </header>

      {scheduled && row.publish_at ? (
        <p className="k-eph-banner k-small"><Icon name="calendar" /> {t('schedule.banner', { when: when(row.publish_at) })}</p>
      ) : null}
      {!d.ok ? (
        d.reason === 'waiting'
          ? <p className="k-post-waiting k-muted k-small"><Icon name="key" /> {t('feed.waitingKey', { name })}</p>
          : <p className="k-post-waiting k-muted k-small"><Icon name="alert" /> {t('feed.unverified')}</p>
      ) : (
        <PostBody payload={d.value} row={row} onOpenMedia={setGallery} />
      )}

      {d.ok ? (
        <>
          <div className="k-post-actions">
            <button type="button" className="k-action" aria-pressed={liked} data-on={liked ? '' : undefined} onClick={() => void toggleLike()}>
              {myReaction && myReaction !== '❤️' ? <span className="k-react-emoji" aria-hidden>{myReaction}</span> : <Icon name="heart" />}
              <span>{liked ? t('feed.liked') : t('feed.like')}</span>
            </button>
            <button type="button" className="k-action k-action-sm" aria-expanded={picker} aria-label={t('react.pick')} onClick={() => setPicker((v) => !v)}>
              <Icon name="plus" />
            </button>
            <button type="button" className="k-action" aria-expanded={showComments || commentCount > 0}
              onClick={() => { setShowComments(true); setFocusComment((n) => n + 1); }}>
              <Icon name="comment" /><span>{commentCount ? t('feed.commentCount', { count: commentCount }) : t('feed.comment')}</span>
            </button>
            <button type="button" className="k-action" onClick={() => setSharing(true)}>
              <Icon name="share" /><span>{t('share.action')}</span>
            </button>
            {mine && likeCount > 0 ? (
              <span className="k-post-likes k-small k-muted" title={t('feed.likeCountPrivate')}>
                <Icon name="lock" /> <span aria-hidden>{breakdown.map(([e, n]) => `${e} ${n}`).join('  ')}</span>
                <span className="k-sr-only">{t('feed.likeCount', { count: likeCount })}</span>
              </span>
            ) : null}
          </div>
          {picker ? (
            <div className="k-react-row" role="group" aria-label={t('react.pick')}>
              {REACTIONS.map((e) => (
                <button key={e} type="button" className="k-react-btn" aria-pressed={myReaction === e} onClick={() => void react(myReaction === e ? null : e)}>{e}</button>
              ))}
            </div>
          ) : null}
          {showComments || commentCount > 0 ? <Comments post={row} contentKey={postContentKey(row)} focusSignal={focusComment} /> : null}
        </>
      ) : null}

      {gallery !== null && items.length && galleryPost ? (
        <Gallery items={items} start={gallery} post={galleryPost} onClose={() => setGallery(null)} />
      ) : null}
      {editing && payload ? <EditDialog row={row} payload={payload} onClose={() => setEditing(false)} /> : null}
      {sharing ? <ShareDialog row={row} onClose={() => setSharing(false)} /> : null}
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

/** `onOpenMedia(i)`: open the gallery at item i (photos first, then the video); without it the video plays inline. */
export function PostBody({ payload, row, nested = false, onOpenMedia }: { payload: PostPayload; row?: PostRow; nested?: boolean; onOpenMedia?: (i: number) => void }) {
  const text = [payload.text, payload.sharedText].filter(Boolean).join('\n\n');
  return (
    <div className="k-post-body">
      {payload.note ? (
        <div className="k-post-note">
          <h3 dir="auto">{payload.note.title}</h3>
          <NoteText md={payload.note.body} />
        </div>
      ) : null}
      {text ? <RichText text={text} className="k-post-text" /> : null}
      {payload.photos?.length ? <PhotoGrid photos={payload.photos} onOpen={(i) => onOpenMedia?.(i)} /> : null}
      {payload.video ? <VideoPlayer video={payload.video} onOpen={onOpenMedia ? () => onOpenMedia(postVideoIndex(payload)) : undefined} /> : null}
      {payload.link ? <LinkCard link={payload.link} /> : null}
      {payload.poll && row ? <PollView row={row} poll={payload.poll} /> : null}
      {row?.kind === 'share' && row.shared_post_id && !nested ? <SharedPost id={row.shared_post_id} /> : null}
    </div>
  );
}

export function EditDialog({ row, payload, onClose }: { row: PostRow; payload: PostPayload; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  // Every post kind keeps its media, link, video and other fields; notes edit their title and body.
  const isNote = !!payload.note;
  const [text, setText] = useState(isNote ? payload.note!.body : payload.text ?? '');
  const [title, setTitle] = useState(payload.note?.title ?? '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const next: PostPayload = { ...payload };
      if (isNote) {
        next.note = { ...payload.note!, title: title.trim().slice(0, 200) || payload.note!.title, body: text.slice(0, 60000) };
      } else {
        const v = text.trim().slice(0, 8000);
        if (v) next.text = v; else delete next.text;
      }
      await editPost(row, clean(next));
      await qc.invalidateQueries({ queryKey: ['v2feed'] });
      void qc.invalidateQueries({ queryKey: ['scheduled'] });
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
      <div className="k-stack">
        {isNote ? <TextField label={t('edit.noteTitle')} value={title} maxLength={200} dir="auto" onChange={(e) => setTitle(e.target.value)} /> : null}
        <Textarea label={isNote ? t('edit.noteBody') : t('feed.editTitle')} hideLabel={!isNote} value={text} rows={isNote ? 10 : 6}
          maxLength={isNote ? 60000 : 8000} dir="auto" onChange={(e) => setText(e.target.value)} />
        {!scheduledRow(row) ? <p className="k-small k-muted">{t('edit.postNote')}</p> : null}
      </div>
    </Dialog>
  );
}

const scheduledRow = (row: PostRow) => isScheduled(row);
