'use client';
// Comments under a post, threaded one level (a reply to a reply joins the same thread). Comments are
// encrypted with a subkey of the post's content key (lib/content addComment/readComment); the comment it
// replies to travels inside the ciphertext. Phase 3: authors edit their own comments (re-sealed, "edited",
// no history kept); edits reach other readers live (components/posts/live.ts).
// Follow and public posts (docs/v2/10-follow-public.md §6): on Followers and Public posts the people who
// comment may be strangers to me, so their handles, public names and signing keys come with the thread
// (lib/feed/feed fetchCommentAuthors) instead of my people directory; the post's "who can comment" setting
// decides whether the box is shown (the database enforces it); the post's author can remove any comment and
// restrict its writer; and comments containing one of my hidden words are folded away on this device.
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { addComment, editComment, readComment } from '@/lib/content';
import { commentGateKey, commentsKey, fetchCommentAuthors, fetchCommentGate, fetchComments, notifySafe, snippet, type CommentAuthor } from '@/lib/feed/feed';
import { sb, must } from '@/lib/supabase';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion, usePerson } from '@/lib/people';
import { useFileUrl } from '@/lib/media';
import type { CommentRow, PostRow } from '@/lib/types';
import { RelativeTime, RichText } from './bits';
import { Translatable } from '@/components/translate/Translatable';
import { threadComments } from './logic';
import { Menu } from './Menu';
import { ReportDialog } from './ReportDialog';
import { deriveSubkey } from '@kithwall/crypto';
import { notifyMentions, resolveMentions } from '@/lib/social/engage';
import { isWide } from './data';
import { matchesHidden } from '@/lib/social/hiddenWords';
import { useHiddenStore } from '@/lib/social/hiddenStore';
import { restrict, restrictedKey, unrestrict, useRestricted } from '@/lib/follow/follow';

interface Item { row: CommentRow; text: string | null; replyTo?: string; created_at: string; id: string }

/** Per-post likes and comments: seeded in batches by the feed and kept current by Realtime (see PostCard). */
export const ENGAGEMENT_STALE = 2 * 60_000;

/** `strangers`: a Followers or Public post, whose commenters are not looked up in my people directory. */
export function useComments(postId: string, strangers = false) {
  return useQuery({
    queryKey: commentsKey(postId), staleTime: ENGAGEMENT_STALE,
    queryFn: async () => { const rows = await fetchComments(postId); if (!strangers) await people.ensure(rows.map((r) => r.author_id)); return rows; },
  });
}

/** May I comment on this post? (its own setting, else its author's; true while unknown so the box doesn't flicker) */
export function useCanComment(post: PostRow): boolean {
  const { userId, status } = useSession();
  const mine = post.author_id === userId;
  const q = useQuery({
    queryKey: commentGateKey(post.id), enabled: status === 'ready' && !mine && !!post.wall_owner_id, staleTime: ENGAGEMENT_STALE,
    queryFn: () => fetchCommentGate(post.id),
  });
  return mine || q.data !== false;
}

export function Comments({ post, contentKey, focusSignal }: { post: PostRow; contentKey: Uint8Array | null; focusSignal: number }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { userId } = useSession();
  usePeopleVersion();
  const wide = isWide(post);
  const q = useComments(post.id, wide);
  const count = q.data?.length ?? 0;
  // Followers and Public posts: who wrote the comments, for readers who can't list those profiles.
  const authors = useQuery({
    queryKey: ['comment-authors', post.id, count], enabled: wide && count > 0, staleTime: ENGAGEMENT_STALE,
    queryFn: () => fetchCommentAuthors(post.id),
  });
  const cardOf = (id: string): CommentAuthor | undefined => (wide ? authors.data?.get(id) : undefined);
  const canComment = useCanComment(post);
  const hiddenWords = useHiddenStore().words;
  const restricted = useRestricted();
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const postMine = post.author_id === userId;

  useEffect(() => { if (focusSignal) input.current?.focus(); }, [focusSignal]);

  const items: Item[] = (q.data ?? []).map((row) => {
    const d = readComment(row, contentKey, cardOf(row.author_id)?.sign_pub);
    return { row, id: row.id, created_at: row.created_at, text: d.ok ? d.value.text : null, replyTo: d.ok ? d.value.replyTo : undefined };
  });
  const threads = threadComments(items);
  const LIMIT = 2;
  const shown = expanded ? threads : threads.slice(-LIMIT);
  const hidden = threads.length - shown.length;
  const nameOf = (id: string) => people.person(id)?.name ?? cardOf(id)?.name ?? (cardOf(id) ? `@${cardOf(id)!.username}` : '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = text.trim().slice(0, 4000);
    if (!body || busy) return;
    setBusy(true);
    try {
      await addComment({ postId: post.id, contentKey }, body, replyTo?.id);
      setText(''); setReplyTo(null);
      await qc.invalidateQueries({ queryKey: commentsKey(post.id) });
      const parentAuthor = replyTo ? items.find((x) => x.id === replyTo.id)?.row.author_id : null;
      await notifySafe(post.author_id, 'comment', 'post', post.id, snippet(body, 60));
      if (parentAuthor && parentAuthor !== post.author_id) await notifySafe(parentAuthor, 'comment', 'post', post.id, snippet(body, 60));
      // @mentions: people who can read the post (connections; on Followers and Public posts also accounts that
      // let people follow them, subject to their "Who can mention me" setting).
      const mentioned = (await resolveMentions(body, wide).catch(() => [] as string[])).filter((id) => id !== post.author_id && id !== parentAuthor);
      await notifyMentions(mentioned, 'post', post.id);
    } catch {
      // The author may have limited comments since the box was drawn: ask again.
      void qc.invalidateQueries({ queryKey: commentGateKey(post.id) });
      toast({ message: t('feed.failed'), tone: 'danger' });
    } finally { setBusy(false); }
  }

  async function remove(c: CommentRow) {
    try {
      must(await sb().from('comments').delete().eq('id', c.id));
      await qc.invalidateQueries({ queryKey: commentsKey(post.id) });
      toast({ message: t('feed.commentDeleted') });
    } catch { toast({ message: t('feed.failed'), tone: 'danger' }); }
  }

  async function setRestricted(id: string, on: boolean) {
    try {
      if (on) await restrict(id); else await unrestrict(id);
      await qc.invalidateQueries({ queryKey: restrictedKey });
      toast({ message: t(on ? 'restrict.done' : 'restrict.undone', { name: nameOf(id) }) });
    } catch { toast({ message: t('feed.failed'), tone: 'danger' }); }
  }

  const reply = (c: Item) => {
    setReplyTo({ id: c.id, name: nameOf(c.row.author_id) });
    input.current?.focus();
  };

  const canDelete = (c: CommentRow) => c.author_id === userId || post.author_id === userId || post.wall_owner_id === userId;
  const view = (c: Item, root: Item) => {
    const isRestricted = postMine && !!restricted.data?.has(c.row.author_id);
    return (
      <CommentView item={c} canDelete={canDelete(c.row)} onReply={canComment ? () => reply(root) : undefined} onDelete={() => void remove(c.row)}
        contentKey={contentKey} postId={post.id} card={cardOf(c.row.author_id)}
        filtered={c.row.author_id !== userId && matchesHidden(c.text, hiddenWords)}
        restricted={isRestricted}
        onRestrict={postMine && c.row.author_id !== userId ? () => void setRestricted(c.row.author_id, !isRestricted) : undefined} />
    );
  };

  return (
    <div className="k-comments">
      {hidden > 0 ? (
        <button type="button" className="k-linkbtn k-comments-more" onClick={() => setExpanded(true)}>
          {t('feed.commentCount', { count: items.length })}
        </button>
      ) : null}
      {shown.length ? (
        <ul className="k-comment-list" role="list">
          {shown.map((th) => (
            <li key={th.root.id}>
              {view(th.root, th.root)}
              {th.replies.length ? (
                <ul className="k-comment-replies" role="list">
                  {th.replies.map((r) => <li key={r.id}>{view(r, th.root)}</li>)}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canComment ? (
        <form className="k-comment-form" onSubmit={(e) => void submit(e)}>
          {replyTo ? (
            <p className="k-comment-replying k-small">
              <span>{t('feed.replyingTo', { name: replyTo.name })}</span>
              <IconButton icon="close" size="sm" label={t('feed.cancel')} onClick={() => setReplyTo(null)} />
            </p>
          ) : null}
          <div className="k-comment-input">
            <label className="k-sr-only" htmlFor={`c-${post.id}`}>{replyTo ? t('feed.writeReply', { name: replyTo.name }) : t('feed.writeComment')}</label>
            <textarea id={`c-${post.id}`} ref={input} rows={1} value={text} maxLength={4000} dir="auto"
              placeholder={replyTo ? t('feed.writeReply', { name: replyTo.name }) : t('feed.writeComment')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(e); } }} />
            <IconButton type="submit" icon="send" size="sm" variant={text.trim() ? 'primary' : 'ghost'} label={t('feed.send')} disabled={!text.trim() || busy} />
          </div>
          {post.is_public ? <p className="k-muted k-xs k-comment-public"><Icon name="globe" /> {t('comments.publicNote')}</p> : null}
        </form>
      ) : <p className="k-muted k-small k-comment-limited"><Icon name="comment" /> {t('comments.limited')}</p>}
    </div>
  );
}

function CommentView({ item, canDelete, onReply, onDelete, contentKey, postId, card, filtered, restricted, onRestrict }: {
  item: Item; canDelete: boolean; onReply?: () => void; onDelete: () => void; contentKey: Uint8Array | null; postId: string;
  /** The author as told with the thread (Followers and Public posts); my own directory wins when it knows them. */
  card?: CommentAuthor;
  /** Contains one of my hidden words: folded until I ask to see it. */
  filtered: boolean;
  /** I restricted this person: only they and I can see what they write on my posts. */
  restricted: boolean;
  onRestrict?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { userId } = useSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState(false);
  const mine = item.row.author_id === userId;
  async function save() {
    const v = draft.trim().slice(0, 4000);
    if (!v || saving) return;
    if (v === item.text) { setEditing(false); return; }
    setSaving(true);
    try {
      await editComment(item.row, contentKey, v, item.replyTo);
      await qc.invalidateQueries({ queryKey: commentsKey(postId) });
      setEditing(false);
      toast({ message: t('edit.commentSaved') });
    } catch { toast({ message: t('edit.failed'), tone: 'danger' }); }
    finally { setSaving(false); }
  }
  // A commenter I can't list (a stranger on a Followers or Public post) is never asked for from the people
  // directory; whoever it already knows is shown from there, with their picture.
  const known = people.person(item.row.author_id);
  const author = usePerson(card && !known ? null : item.row.author_id) ?? known;
  const avatar = useFileUrl(author?.info?.avatar?.thumb);
  const [reporting, setReporting] = useState(false);
  const name = author?.name ?? card?.name ?? (card ? `@${card.username}` : '…');
  const handle = author?.username ?? card?.username;
  const menu = [
    ...(mine && item.text !== null ? [{ label: t('edit.comment'), icon: 'edit' as const, onSelect: () => { setDraft(item.text ?? ''); setEditing(true); } }] : []),
    ...(canDelete ? [{ label: t('feed.commentDelete'), icon: 'trash' as const, danger: true, onSelect: onDelete }] : []),
    ...(onRestrict ? [{ label: restricted ? t('restrict.undo', { name }) : t('restrict.action', { name }), icon: 'eyeOff' as const, onSelect: onRestrict }] : []),
    ...(item.row.author_id !== userId ? [{ label: t('feed.commentReport'), icon: 'flag' as const, onSelect: () => setReporting(true) }] : []),
  ];
  if (filtered && !reveal) {
    return (
      <div className="k-comment k-comment-filtered">
        <p className="k-muted k-small"><Icon name="eyeOff" /> {t('hidden.comment')} <button type="button" className="k-linkbtn" onClick={() => setReveal(true)}>{t('hidden.show')}</button></p>
      </div>
    );
  }
  return (
    <div className="k-comment">
      <Avatar name={name} src={avatar} size={32} />
      <div className="k-comment-main">
        <div className="k-comment-bubble">
          {handle ? <Link className="k-comment-name" href={`/u/${handle}`}>{name}</Link> : <span className="k-comment-name">{name}</span>}
          {editing ? (
            <form className="k-eph-cedit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
              <Textarea label={t('edit.comment')} hideLabel value={draft} rows={2} maxLength={4000} dir="auto" autoFocus disabled={saving}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
                  else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
                }} />
              <div className="k-eph-cedit-actions">
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>{t('feed.cancel')}</Button>
                <Button size="sm" variant="primary" type="submit" busy={saving} disabled={!draft.trim()}>{t('edit.save')}</Button>
              </div>
            </form>
          ) : item.text !== null ? <Translatable text={item.text} variant="comment" textClassName="k-rich" mine={mine}><RichText text={item.text} clamp={400} /></Translatable> : <p className="k-muted k-small">{t('feed.commentHidden')}</p>}
        </div>
        <div className="k-comment-meta k-small">
          <RelativeTime iso={item.created_at} />
          {item.row.edited_at ? <span className="k-muted">{t('edit.edited')}</span> : null}
          {restricted ? <span className="k-muted"><Icon name="eyeOff" /> {t('restrict.note')}</span> : null}
          {onReply ? <button type="button" className="k-linkbtn" onClick={onReply}>{t('feed.reply')}</button> : null}
          <Menu label={t('feed.postMenu')} items={menu} />
        </div>
      </div>
      <ReportDialog open={reporting} onClose={() => setReporting(false)} kind="comment" id={item.id}
        disclosure={() => ({ plaintext: item.replyTo ? { text: item.text, replyTo: item.replyTo } : { text: item.text }, contentKey: contentKey ? deriveSubkey(contentKey, 'comment', item.id) : null, keyKind: 'comment' })} />
    </div>
  );
}
