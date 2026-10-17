'use client';
// The 2010 "UFI" under a story: "You, Bob and 3 others like this", comments (encrypted with a
// key derived from the post's content key), comment likes, "View all N comments", comment box.
import Link from 'next/link';
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deriveSubkey } from '@kithwall/crypto';
import { Icon } from '@/components/Icon';
import { Avatar, AvatarLink } from '@/components/Avatar';
import { ReportDialog } from '@/components/ReportDialog';
import { Linkify, Unverified, Waiting } from '@/components/social/bits';
import { ConfirmDialog } from '@/components/social/Dialog';
import { addComment, readComment, setLike } from '@/lib/content';
import { commentsKey, fetchCommentLikes, fetchComments, fetchPostLikes, likesKey, notifySafe, snippet } from '@/lib/feed/feed';
import { people, usePeopleVersion } from '@/lib/people';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { sb, must } from '@/lib/supabase';
import { when, plural } from '@/lib/format';
import type { CommentRow, LikeRow, PostRow } from '@/lib/types';

export interface UfiHandle { focusComment(): void; toggleLike(): void; liked: boolean }

export function useLikes(kind: 'post' | 'comment', id: string) {
  return useQuery({
    queryKey: likesKey(kind, id),
    queryFn: async () => { const r = await fetchPostLikes(kind, id); await people.ensure(r.map((x) => x.user_id)); return r; },
  });
}

export function useComments(postId: string) {
  return useQuery({
    queryKey: commentsKey(postId),
    queryFn: async () => { const r = await fetchComments(postId); await people.ensure(r.map((x) => x.author_id)); return r; },
  });
}

/** "You, Bob and 3 others like this." */
export function LikeSentence({ likes, self }: { likes: LikeRow[]; self: string | null }) {
  usePeopleVersion();
  const ids = likes.map((l) => l.user_id);
  const me = !!self && ids.includes(self);
  const others = ids.filter((x) => x !== self);
  const named = others.slice(0, me ? 1 : 2);
  const rest = ids.length - named.length - (me ? 1 : 0);
  const parts: ReactNode[] = [];
  if (me) parts.push('You');
  named.forEach((id) => {
    const p = people.person(id);
    parts.push(p ? <Link key={id} href={`/${p.username}`}>{p.name}</Link> : 'Someone');
  });
  if (rest > 0) parts.push(<span key="rest">{rest} other{rest > 1 ? 's' : ''}</span>);
  const single = parts.length === 1 && !me;
  return (
    <>
      {parts.map((p, i) => <span key={i}>{i > 0 ? (i === parts.length - 1 ? ' and ' : ', ') : ''}{p}</span>)}
      {single ? ' likes this.' : ' like this.'}
    </>
  );
}

interface UfiProps {
  row: PostRow;
  contentKey: Uint8Array | null;
  canModerate: boolean;          // post author / wall owner may remove any comment
  expanded?: boolean;            // permalink: show all comments, box open
}

export const Ufi = forwardRef<UfiHandle, UfiProps>(function Ufi({ row, contentKey, canModerate, expanded = false }, ref) {
  useKeyringVersion();
  usePeopleVersion();
  const { userId } = useSession();
  const qc = useQueryClient();
  const likes = useLikes('post', row.id);
  const comments = useComments(row.id);
  const [showAll, setShowAll] = useState(expanded);
  const [boxOpen, setBoxOpen] = useState(expanded);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<{ row: CommentRow; text: string } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const cs = comments.data ?? [];
  const commentIds = cs.map((c) => c.id).join(',');
  const cLikes = useQuery({
    queryKey: ['likes', 'comments', row.id, commentIds], enabled: cs.length > 0,
    queryFn: () => fetchCommentLikes(cs.map((c) => c.id)),
  });
  const liked = !!userId && (likes.data ?? []).some((l) => l.user_id === userId);

  const toggleLike = async () => {
    if (!userId) return;
    const on = !liked;
    qc.setQueryData<LikeRow[]>(likesKey('post', row.id), (old = []) => on
      ? [...old, { target_kind: 'post', target_id: row.id, user_id: userId, created_at: new Date().toISOString() }]
      : old.filter((l) => l.user_id !== userId));
    try {
      await setLike('post', row.id, on);
      if (on) await notifySafe(row.author_id, 'like', 'post', row.id);
    } catch (e) { setErr((e as Error).message); }
    await qc.invalidateQueries({ queryKey: likesKey('post', row.id) });
  };

  useImperativeHandle(ref, () => ({
    focusComment: () => { setBoxOpen(true); setTimeout(() => box.current?.focus(), 0); },
    toggleLike: () => { void toggleLike(); },
    liked,
  }));

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setErr(null);
    try {
      await addComment({ postId: row.id, contentKey }, t.slice(0, 4000));
      setText('');
      const preview = snippet(t, 60);
      await notifySafe(row.author_id, 'comment', 'post', row.id, preview);
      if (row.wall_owner_id && row.wall_owner_id !== row.author_id) await notifySafe(row.wall_owner_id, 'comment', 'post', row.id, preview);
      await qc.invalidateQueries({ queryKey: commentsKey(row.id) });
    } catch (e) { setErr((e as Error).message || 'Couldn’t post your comment.'); } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
  };

  const [delC, setDelC] = useState<CommentRow | null>(null);
  const removeComment = async (c: CommentRow) => {
    must(await sb().from('comments').delete().eq('id', c.id));
    await qc.invalidateQueries({ queryKey: commentsKey(row.id) });
  };
  const likeComment = async (c: CommentRow, on: boolean) => {
    try {
      await setLike('comment', c.id, on);
      if (on) await notifySafe(c.author_id, 'like', 'post', row.id);
      await qc.invalidateQueries({ queryKey: ['likes', 'comments', row.id] });
    } catch (e) { setErr((e as Error).message); }
  };

  const shown = showAll || cs.length <= 3 ? cs : cs.slice(-2);
  const open = boxOpen || cs.length > 0;
  const nLikes = likes.data?.length ?? 0;
  const byComment = useMemo(() => {
    const m = new Map<string, LikeRow[]>();
    for (const l of cLikes.data ?? []) m.set(l.target_id, [...(m.get(l.target_id) ?? []), l]);
    return m;
  }, [cLikes.data]);

  if (!nLikes && !cs.length && !open && !err) return null;
  return (
    <div className="ufi">
      {err && <div className="ur err" role="alert">{err}</div>}
      {nLikes > 0 && <div className="ur"><Icon name="like" /><div><LikeSentence likes={likes.data ?? []} self={userId} /></div></div>}
      {cs.length > shown.length && (
        <div className="ur"><Icon name="comment" /><a role="button" tabIndex={0} onClick={() => setShowAll(true)}
          onKeyDown={(e) => { if (e.key === 'Enter') setShowAll(true); }}>View all {cs.length} comments</a></div>
      )}
      {shown.map((c) => {
        const r = readComment(c, contentKey);
        const cl = byComment.get(c.id) ?? [];
        const iLike = !!userId && cl.some((l) => l.user_id === userId);
        const author = people.person(c.author_id);
        const canDel = c.author_id === userId || canModerate;
        return (
          <div className="ur" key={c.id}>
            <AvatarLink id={c.author_id} size={32} />
            <div className="cmb">
              {author ? <b><Link href={`/${author.username}`}>{author.name}</Link></b> : <b className="gray">…</b>}{' '}
              {r.ok ? <Linkify text={r.value.text} /> : r.reason === 'waiting' ? <Waiting authorId={row.author_id} /> : <Unverified />}
              <div className="ct">
                {when(c.created_at)}
                {r.ok && <> &middot; <a role="button" tabIndex={0} onClick={() => void likeComment(c, !iLike)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void likeComment(c, !iLike); }}>{iLike ? 'Unlike' : 'Like'}</a></>}
                {cl.length > 0 && <> &middot; <Icon name="like" /> {plural(cl.length, 'person', 'people')}</>}
                {canDel && <> &middot; <a role="button" tabIndex={0} onClick={() => setDelC(c)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setDelC(c); }}>Remove</a></>}
                {r.ok && c.author_id !== userId && <> &middot; <a role="button" tabIndex={0} onClick={() => setReport({ row: c, text: r.value.text })}
                  onKeyDown={(e) => { if (e.key === 'Enter') setReport({ row: c, text: r.value.text }); }}>Report</a></>}
              </div>
            </div>
          </div>
        );
      })}
      {open && (
        <div className="ur">
          {userId && <Avatar id={userId} size={32} />}
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <textarea ref={box} placeholder="Write a comment..." aria-label="Write a comment" value={text} maxLength={4000}
              disabled={busy} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
          </form>
        </div>
      )}
      {delC && (
        <ConfirmDialog title="Remove Comment" confirmLabel="Remove" onClose={() => setDelC(null)} onConfirm={() => removeComment(delC)}>
          Are you sure you want to remove this comment?
        </ConfirmDialog>
      )}
      {report && (
        <ReportDialog kind="comment" id={report.row.id} onClose={() => setReport(null)} disclosure={{
          plaintext: { text: report.text, postId: row.id },
          contentKey: contentKey ? deriveSubkey(contentKey, 'comment', report.row.id) : null,
          keyKind: 'comment',
        }} />
      )}
    </div>
  );
});
