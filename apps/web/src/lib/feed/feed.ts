'use client';
// Feed helpers on top of lib/content.ts: batched engagement loading, on-device "Top News"
// ranking, post listings by kind, sharing, deletion, notifications and a session-only search
// index over posts this device has already decrypted. Plaintext never leaves the device.
import type { QueryClient } from '@tanstack/react-query';
import { sb, must } from '../supabase';
import { me } from '../keys/session';
import { notify } from '../friends';
import { preparePosts } from '../content';
import { deleteMedia, fileRefPaths } from '../media';
import { people } from '../people';
import type { CommentRow, FileRef, LikeRow, PostPayload, PostRow } from '../types';
import { forgetPost } from '../search';

export const likesKey = (kind: 'post' | 'comment', id: string) => ['likes', kind, id] as const;
export const commentsKey = (postId: string) => ['comments', postId] as const;
/** May I comment on this post? (docs/v2/10-follow-public.md §6; the database decides) */
export const commentGateKey = (postId: string) => ['comment-gate', postId] as const;

const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/**
 * Load likes and comments for a page of posts in two queries and seed the per-story caches (plus, in a third,
 * whether I may comment on other people's profile posts). `strangers(row)`: a Followers or Public post, whose
 * likers and commenters may be people I don't know: they are not looked up in my people directory (which
 * would pin the identity key of every one of them); their names come with the thread instead.
 */
export async function prefetchEngagement(qc: QueryClient, rows: PostRow[], strangers: (row: PostRow) => boolean = () => false) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return;
  const likes: LikeRow[] = [];
  const comments: CommentRow[] = [];
  for (const part of chunk(ids, 100)) {
    const [l, c] = await Promise.all([
      sb().from('likes').select('*').eq('target_kind', 'post').in('target_id', part),
      sb().from('comments').select('*').in('post_id', part).order('created_at', { ascending: true }),
    ]);
    likes.push(...((l.data ?? []) as LikeRow[]));
    comments.push(...((c.data ?? []) as CommentRow[]));
  }
  const wide = new Set(rows.filter(strangers).map((r) => r.id));
  await people.ensure([...likes.filter((l) => !wide.has(l.target_id)).map((l) => l.user_id), ...comments.filter((c) => !wide.has(c.post_id ?? '')).map((c) => c.author_id)]);
  for (const id of ids) {
    qc.setQueryData(likesKey('post', id), likes.filter((x) => x.target_id === id));
    qc.setQueryData(commentsKey(id), comments.filter((x) => x.post_id === id));
  }
  const others = rows.filter((r) => r.wall_owner_id && r.author_id !== me()).map((r) => r.id);
  const gates = others.length ? await fetchCommentGates(others).catch(() => null) : null;
  if (gates) for (const id of others) qc.setQueryData(commentGateKey(id), gates.get(id) ?? true);
}

/** Which of these posts I may comment on (posts the database doesn't answer for are left out). */
export async function fetchCommentGates(postIds: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (const part of chunk(postIds, 200)) {
    const rows = (must(await sb().rpc('comment_gates', { p_posts: part })) ?? []) as { post_id: string; can_comment: boolean }[];
    for (const r of rows) out.set(r.post_id, !!r.can_comment);
  }
  return out;
}

export async function fetchCommentGate(postId: string): Promise<boolean> {
  return (await fetchCommentGates([postId])).get(postId) ?? true;
}

/** Who wrote a comment, as told with the thread of a Followers or Public post. */
export interface CommentAuthor { id: string; username: string; name: string | null; sign_pub: string }

/** The people who commented on a Followers or Public post I can read (empty for other posts). */
export async function fetchCommentAuthors(postId: string): Promise<Map<string, CommentAuthor>> {
  const rows = (must(await sb().rpc('comment_authors', { p_post: postId })) ?? []) as { id: string; username: string; display_name: string | null; sign_pub: string }[];
  return new Map(rows.map((r) => [r.id, { id: r.id, username: r.username, name: r.display_name, sign_pub: r.sign_pub }]));
}

/**
 * Re-read the likes of posts in batched queries (default: every post whose likes are on screen) instead
 * of refetching one query per post. Likes are metadata rows; nothing here is decrypted.
 */
export async function refreshPostLikes(qc: QueryClient, ids?: string[]) {
  const targets = [...new Set(ids ?? qc.getQueryCache().findAll({ queryKey: ['likes', 'post'], type: 'active' }).map((q) => q.queryKey[2] as string))];
  // Likes on screens that are not mounted now are re-read when they mount again.
  void qc.invalidateQueries({ queryKey: ['likes'], refetchType: 'none' });
  if (!targets.length) return;
  const likes: LikeRow[] = [];
  for (const part of chunk(targets, 100)) {
    likes.push(...(must(await sb().from('likes').select('*').eq('target_kind', 'post').in('target_id', part)) as LikeRow[]));
  }
  await people.ensure(likes.map((l) => l.user_id));
  for (const id of targets) qc.setQueryData(likesKey('post', id), likes.filter((x) => x.target_id === id));
}

export async function fetchPostLikes(kind: 'post' | 'comment', id: string): Promise<LikeRow[]> {
  return must(await sb().from('likes').select('*').eq('target_kind', kind).eq('target_id', id)) as LikeRow[];
}


export async function fetchComments(postId: string): Promise<CommentRow[]> {
  return must(await sb().from('comments').select('*').eq('post_id', postId).order('created_at', { ascending: true })) as CommentRow[];
}

// ---------------------------------------------------------------------------------------
// Top News: ranked on this device from likes, comments and how often I interact with the author.
export interface Engagement { likes: LikeRow[]; comments: CommentRow[] }


// ---------------------------------------------------------------------------------------
// Listings

export async function fetchPost(id: string): Promise<PostRow | null> {
  const { data, error } = await sb().from('posts').select('*').eq('id', id).maybeSingle();
  const row = (data as PostRow | null) ?? null;
  if (row) await preparePosts([row]);
  // The server answered and the post isn't there (deleted, expired, or no longer mine to read): it leaves
  // the on-device search index too (lib/search).
  else if (!error) forgetPost(id);
  return row;
}

/** Posts of one kind (e.g. notes) by the given authors, newest first. */
export async function fetchByKind(kind: PostRow['kind'], authors: string[] | null, before?: string, pageSize = 20): Promise<PostRow[]> {
  let q = sb().from('posts').select('*').eq('kind', kind).order('created_at', { ascending: false }).limit(pageSize);
  if (authors) {
    if (!authors.length) return [];
    if (authors.length <= 300) q = q.in('author_id', authors);
  }
  if (before) q = q.lt('created_at', before);
  const rows = must(await q) as PostRow[];
  await preparePosts(rows);
  return rows;
}

// ---------------------------------------------------------------------------------------
// Delete / share

export async function deletePost(row: PostRow, payload?: PostPayload | null) {
  const refs = [payload?.link?.image, payload?.video?.file, payload?.video?.poster].filter((r): r is FileRef => !!r);
  const mine = refs.flatMap(fileRefPaths).filter((p) => p.startsWith(`${me()}/`));
  if (mine.length && row.author_id === me()) await deleteMedia(mine).catch(() => undefined);
  must(await sb().from('posts').delete().eq('id', row.id));
  forgetPost(row.id);
}




export async function linkPostMedia(paths: string[], postId: string) {
  if (!paths.length) return;
  must(await sb().from('media_objects').update({ post_id: postId }).in('path', paths));
}

// ---------------------------------------------------------------------------------------
// Notifications (best effort; RLS decides who may be notified).

export function snippet(s: string | undefined | null, n = 80): string | undefined {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export async function notifySafe(recipient: string | null | undefined, type: string, objectKind?: string, objectId?: string, preview?: string) {
  if (!recipient || recipient === me()) return;
  try { await notify(recipient, type, objectKind, objectId, preview); } catch { /* not allowed or rate-limited */ }
}

// ---------------------------------------------------------------------------------------
// Plain text of a post payload (for previews and reports).

export function payloadText(p: PostPayload): string {
  return [p.text, p.sharedText, p.video?.title, p.link?.title, p.link?.description, p.link?.url,
    p.note?.title, p.note?.body, ...(p.photos?.map((x) => x.caption) ?? [])]
    .filter(Boolean).join('\n');
}




/** canonicalJson (used to sign envelopes) rejects `undefined`; drop such keys from plain data. */
export function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
