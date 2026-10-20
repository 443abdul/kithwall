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

export const likesKey = (kind: 'post' | 'comment', id: string) => ['likes', kind, id] as const;
export const commentsKey = (postId: string) => ['comments', postId] as const;

const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Load likes and comments for a page of posts in two queries and seed the per-story caches. */
export async function prefetchEngagement(qc: QueryClient, rows: PostRow[]) {
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
  await people.ensure([...likes.map((l) => l.user_id), ...comments.map((c) => c.author_id)]);
  for (const id of ids) {
    qc.setQueryData(likesKey('post', id), likes.filter((x) => x.target_id === id));
    qc.setQueryData(commentsKey(id), comments.filter((x) => x.post_id === id));
  }
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
  const { data } = await sb().from('posts').select('*').eq('id', id).maybeSingle();
  const row = (data as PostRow | null) ?? null;
  if (row) await preparePosts([row]);
  return row;
}

/** Posts of one kind (notes, questions, check-ins) by the given authors, newest first. */
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
  return [p.text, p.sharedText, p.video?.title, p.link?.title, p.link?.description, p.link?.url, p.question?.text, ...(p.question?.options ?? []),
    p.note?.title, p.note?.body, p.checkin?.place, p.checkin?.address, p.lifeEvent?.title, ...(p.photos?.map((x) => x.caption) ?? [])]
    .filter(Boolean).join('\n');
}




/** canonicalJson (used to sign envelopes) rejects `undefined`; drop such keys from plain data. */
export function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
