'use client';
// Wall for groups, events and pages: a container publisher + stream. Group and event walls use
// the shared feed <Stream>/<Story> (components/feed) so stories, likes and comments look the same
// everywhere; Pages use the small story below because their posts are shown as the Page itself.
// Everything is encrypted/verified on this device through lib/content.ts.
import Link from 'next/link';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { AvatarLink, NameLink } from '@/components/Avatar';
import { AudienceMark, Linkify, Unverified, Waiting } from '@/components/social/bits';
import { ConfirmDialog } from '@/components/social/Dialog';
import { Stream, pageOf } from '@/components/feed/Stream';
import { addComment, postContentKey, readComment, readPost, setLike } from '@/lib/content';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { notify } from '@/lib/friends';
import { sb, must } from '@/lib/supabase';
import { when, plural } from '@/lib/format';
import type { CommentRow, PostRow } from '@/lib/types';
import { ErrorBox, friendlyError, useAction, useRetryKeys } from './bits';

export interface WallProps {
  queryKey: readonly unknown[];
  load: (before?: string) => Promise<PostRow[]>;
  publish?: (text: string) => Promise<unknown>;
  isPublic: boolean;
  audienceLabel?: string;
  placeholder?: string;
  empty?: string;
  filter?: (r: PostRow) => boolean;
  canDelete?: (r: PostRow) => boolean;
  actor?: (r: PostRow) => ReactNode;
  avatar?: (r: PostRow) => ReactNode;
  /** Container id (group/event) — set to use the shared feed Story. */
  wallContext?: string;
  canModerate?: boolean;
}

export function Wall(props: WallProps) {
  if (props.wallContext) return <ContainerWall {...props} wallContext={props.wallContext} />;
  return <PageWall {...props} />;
}

function ContainerWall(props: WallProps & { wallContext: string }) {
  const qc = useQueryClient();
  return (
    <div className="cm-wall">
      {props.publish && <Publisher publish={props.publish} isPublic={props.isPublic} label={props.audienceLabel}
        placeholder={props.placeholder} onDone={() => void qc.invalidateQueries({ queryKey: [...props.queryKey] })} />}
      <Stream queryKey={props.queryKey} wallContext={props.wallContext} canModerate={props.canModerate}
        load={async (before) => pageOf(await props.load(before), 20)}
        arrange={props.filter ? (rows) => rows.filter(props.filter!) : undefined}
        empty={<div className="gray" style={{ padding: '10px 0' }}>{props.empty ?? 'No posts yet.'}</div>} />
    </div>
  );
}

function PageWall(props: WallProps) {
  const { userId } = useSession();
  const q = useInfiniteQuery({
    queryKey: [...props.queryKey],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => props.load(pageParam),
    getNextPageParam: (last) => (last.length >= 20 ? last[last.length - 1]!.created_at : undefined),
    enabled: !!userId,
  });
  const rows = (q.data?.pages.flat() ?? []).filter((r) => (props.filter ? props.filter(r) : true));
  useKeyringVersion();
  useRetryKeys(rows.some((r) => { const d = readPost(r); return !d.ok && d.reason === 'waiting'; }), props.queryKey);
  return (
    <div className="cm-wall">
      {props.publish && <Publisher publish={props.publish} isPublic={props.isPublic} label={props.audienceLabel}
        placeholder={props.placeholder} onDone={() => void q.refetch()} />}
      {q.isError && <div className="err">Couldn&rsquo;t load posts. <a role="button" tabIndex={0} onClick={() => void q.refetch()}>Try again</a></div>}
      <div className="stream">
        {rows.map((r) => <Story key={r.id} row={r} canDelete={props.canDelete?.(r) ?? r.author_id === userId}
          actor={props.actor?.(r)} avatar={props.avatar?.(r)} onDeleted={() => void q.refetch()} />)}
      </div>
      {q.isLoading && <div className="gray" style={{ padding: 8 }}>Loading&hellip;</div>}
      {!q.isLoading && !rows.length && <div className="gray" style={{ padding: '10px 0' }}>{props.empty ?? 'No posts yet.'}</div>}
      {q.hasNextPage && (
        <div style={{ textAlign: 'center', padding: 8 }}>
          <button type="button" className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Older Posts</button>
        </div>
      )}
    </div>
  );
}

function Publisher({ publish, isPublic, label, placeholder, onDone }:
  { publish: (t: string) => Promise<unknown>; isPublic: boolean; label?: string; placeholder?: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    if (await run(() => publish(t))) { setText(''); onDone(); }
  };
  return (
    <div className="pub">
      <div className="tabs"><b>Share:</b><a className="on" aria-current="true"><Icon name="status" />Post</a></div>
      <ErrorBox error={error} />
      <div className="box">
        <textarea aria-label="Write a post" placeholder={placeholder ?? 'Write something...'} value={text} maxLength={5000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(); }} />
      </div>
      <div className="bar">
        <AudienceMark isPublic={isPublic} label={label} />
        <button type="button" className="btn b" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? 'Sharing…' : 'Share'}</button>
      </div>
    </div>
  );
}

function Story({ row, canDelete, actor, avatar, onDeleted }: { row: PostRow; canDelete: boolean; actor?: ReactNode; avatar?: ReactNode; onDeleted: () => void }) {
  useKeyringVersion();
  usePeopleVersion();
  const { userId } = useSession();
  const qc = useQueryClient();
  const [showCmt, setShowCmt] = useState(false);
  const d = readPost(row);
  const likes = useQuery({
    queryKey: ['likes', 'post', row.id],
    queryFn: async () => (must(await sb().from('likes').select('user_id').eq('target_kind', 'post').eq('target_id', row.id)) as { user_id: string }[]).map((x) => x.user_id),
    enabled: d.ok,
  });
  const iLike = !!userId && (likes.data ?? []).includes(userId);
  const like = async () => {
    await setLike('post', row.id, !iLike);
    await qc.invalidateQueries({ queryKey: ['likes', 'post', row.id] });
    if (!iLike && row.author_id !== userId) await notify(row.author_id, 'like', 'post', row.id).catch(() => undefined);
  };
  const [askDel, setAskDel] = useState(false);
  const remove = () => setAskDel(true);

  let body: ReactNode;
  if (!d.ok) body = d.reason === 'waiting' ? <Waiting authorId={row.author_id} what="this post" /> : <Unverified />;
  else {
    const p = d.value;
    body = (
      <>
        {p.text ? <span className="sh"> <Linkify text={p.text} /></span> : null}
        {p.note ? <div className="att"><Icon name="note" /><div className="ad"><b className="at">{p.note.title}</b>{p.note.body.slice(0, 300)}{p.note.body.length > 300 ? '…' : ''}</div></div> : null}
        {p.game ? <span className="sh"> {p.game.text}</span> : null}
      </>
    );
  }
  const n = likes.data?.length ?? 0;
  return (
    <div className="story">
      {avatar ?? <AvatarLink id={row.author_id} size={50} />}
      <div className="sb">
        <span className="actor">{actor ?? <NameLink id={row.author_id} />}</span>
        {body}
        <div className="sf">
          <AudienceMark isPublic={row.is_public} />{' '}
          <Link href={`/post/${row.id}`}>{when(row.created_at)}</Link>
          {d.ok && <> &middot; <a role="button" tabIndex={0} onClick={() => void like()} onKeyDown={(e) => { if (e.key === 'Enter') void like(); }}>{iLike ? 'Unlike' : 'Like'}</a>
            {' '}&middot; <a role="button" tabIndex={0} onClick={() => setShowCmt(true)} onKeyDown={(e) => { if (e.key === 'Enter') setShowCmt(true); }}>Comment</a></>}
          {canDelete && <> &middot; <a role="button" tabIndex={0} onClick={remove} onKeyDown={(e) => { if (e.key === 'Enter') remove(); }}>Delete</a></>}
        </div>
        {d.ok && (n > 0 || showCmt) && <Comments row={row} likes={n} iLike={iLike} autoFocus={showCmt} />}
        {d.ok && n === 0 && !showCmt && <CommentsIfAny row={row} />}
        {askDel && (
          <ConfirmDialog title="Delete Post" confirmLabel="Delete" onClose={() => setAskDel(false)}
            onConfirm={async () => { must(await sb().from('posts').delete().eq('id', row.id)); onDeleted(); }}>
            Are you sure you want to delete this post?
          </ConfirmDialog>
        )}
      </div>
    </div>
  );
}

function useComments(row: PostRow) {
  return useQuery({
    queryKey: ['comments', row.id],
    queryFn: async () => {
      const rows = must(await sb().from('comments').select('*').eq('post_id', row.id).order('created_at').limit(200)) as CommentRow[];
      await people.ensure(rows.map((r) => r.author_id));
      return rows;
    },
  });
}

function CommentsIfAny({ row }: { row: PostRow }) {
  const c = useComments(row);
  if (!c.data?.length) return null;
  return <Comments row={row} likes={0} iLike={false} autoFocus={false} />;
}

function Comments({ row, likes, iLike, autoFocus }: { row: PostRow; likes: number; iLike: boolean; autoFocus: boolean }) {
  usePeopleVersion();
  const { userId } = useSession();
  const qc = useQueryClient();
  const c = useComments(row);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = postContentKey(row);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setErr(null);
    try {
      await addComment({ postId: row.id, contentKey: key }, t);
      setText('');
      await qc.invalidateQueries({ queryKey: ['comments', row.id] });
      if (row.author_id !== userId) await notify(row.author_id, 'comment', 'post', row.id, t.slice(0, 80)).catch(() => undefined);
    } catch (e) { setErr(friendlyError(e)); } finally { setBusy(false); }
  };
  const delComment = async (id: string) => {
    must(await sb().from('comments').delete().eq('id', id));
    await qc.invalidateQueries({ queryKey: ['comments', row.id] });
  };
  return (
    <div className="ufi">
      {likes > 0 && <div className="ur"><Icon name="like" /><span>{iLike ? (likes === 1 ? 'You like this.' : `You and ${plural(likes - 1, 'other person', 'other people')} like this.`) : `${plural(likes, 'person', 'people')} like${likes === 1 ? 's' : ''} this.`}</span></div>}
      {(c.data ?? []).map((cm) => {
        const r = readComment(cm, row.is_public ? null : key);
        return (
          <div className="ur" key={cm.id}>
            <AvatarLink id={cm.author_id} size={32} />
            <div className="cmb">
              <NameLink id={cm.author_id} />{' '}
              {r.ok ? <Linkify text={r.value.text} /> : <span className="gray">{r.reason === 'waiting' ? 'Waiting for a key…' : 'This comment couldn’t be verified.'}</span>}
              <div className="ct">{when(cm.created_at)}
                {(cm.author_id === userId || row.author_id === userId) && <> &middot; <a role="button" tabIndex={0} onClick={() => void delComment(cm.id)} onKeyDown={(e) => { if (e.key === 'Enter') void delComment(cm.id); }}>Delete</a></>}
              </div>
            </div>
          </div>
        );
      })}
      <div className="ur">
        <div className="cm-cmt">
          <textarea aria-label="Write a comment" placeholder="Write a comment..." value={text} maxLength={2000} autoFocus={autoFocus}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <button type="button" className="btn" disabled={busy || !text.trim()} onClick={() => void send()}>Comment</button>
        </div>
      </div>
      {err && <div className="ur err" role="alert">{err}</div>}
    </div>
  );
}
