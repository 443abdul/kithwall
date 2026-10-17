'use client';
// Feed helpers on top of lib/content.ts: batched engagement loading, on-device "Top News"
// ranking, post listings by kind, sharing, deletion, notifications and a session-only search
// index over posts this device has already decrypted. Plaintext never leaves the device.
import type { QueryClient } from '@tanstack/react-query';
import { sb, must } from '../supabase';
import { getSession, me } from '../keys/session';
import { notify } from '../friends';
import { createPost, preparePosts, type Audience } from '../content';
import { deleteMedia, fileUrl, uploadEncrypted } from '../media';
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

export async function fetchCommentLikes(commentIds: string[]): Promise<LikeRow[]> {
  if (!commentIds.length) return [];
  const out: LikeRow[] = [];
  for (const part of chunk(commentIds, 100)) {
    out.push(...(must(await sb().from('likes').select('*').eq('target_kind', 'comment').in('target_id', part)) as LikeRow[]));
  }
  return out;
}

export async function fetchComments(postId: string): Promise<CommentRow[]> {
  return must(await sb().from('comments').select('*').eq('post_id', postId).order('created_at', { ascending: true })) as CommentRow[];
}

// ---------------------------------------------------------------------------------------
// Top News: ranked on this device from likes, comments and how often I interact with the author.
export interface Engagement { likes: LikeRow[]; comments: CommentRow[] }

export function rankTopNews(rows: PostRow[], eng: (id: string) => Engagement | undefined, self: string, now = Date.now()): PostRow[] {
  const affinity = new Map<string, number>();
  for (const r of rows) {
    const e = eng(r.id);
    if (!e || r.author_id === self) continue;
    const mine = e.likes.filter((l) => l.user_id === self).length + e.comments.filter((c) => c.author_id === self).length;
    if (mine) affinity.set(r.author_id, (affinity.get(r.author_id) ?? 0) + mine);
  }
  const score = (r: PostRow) => {
    const e = eng(r.id);
    const likes = e?.likes.length ?? 0;
    const comments = e?.comments.length ?? 0;
    const commenters = new Set(e?.comments.map((c) => c.author_id)).size;
    const close = Math.min(affinity.get(r.author_id) ?? 0, 10);
    const engagement = likes + comments * 2 + commenters + close * 1.5 + (r.wall_owner_id === self && r.author_id !== self ? 4 : 0) + 1;
    const hours = (now - new Date(r.created_at).getTime()) / 3_600_000;
    return engagement / Math.pow(Math.max(hours, 0) + 2, 1.15);
  };
  return [...rows].sort((a, b) => score(b) - score(a));
}

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
  const img = payload?.link?.image;
  if (img && row.author_id === me() && img.path.startsWith(`${me()}/`)) await deleteMedia([img.path]).catch(() => undefined);
  must(await sb().from('posts').delete().eq('id', row.id));
}

/** Copy a decrypted file into a fresh encrypted upload of my own (so my audience can read it). */
async function reupload(ref: FileRef): Promise<FileRef> {
  const url = await fileUrl(ref);
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return { ...(await uploadEncrypted(bytes, ref.mime)), w: ref.w, h: ref.h };
}

/** Share a link from someone's story as a new link post of my own. */
export async function shareLink(link: NonNullable<PostPayload['link']>, text: string, audience: Audience): Promise<PostRow> {
  const id = crypto.randomUUID();
  let image: FileRef | undefined;
  if (link.image) image = await reupload(link.image).catch(() => undefined);
  const row = await createPost({ id, kind: 'link', audience, payload: clean({ text: text.trim() || undefined, link: { ...link, image } }) });
  if (image) await linkPostMedia([image.path], id);
  return row;
}

/** Share a public post (only public posts can be re-shared; friends-only posts never leave their audience). */
export async function sharePublicPost(original: PostRow, text: string, audience: Audience): Promise<PostRow> {
  if (!original.is_public) throw new Error('Only public posts can be shared.');
  const row = await createPost({ kind: 'share', sharedPostId: original.id, audience, payload: clean({ sharedText: text.trim() || undefined }) });
  if (original.author_id !== me()) await notifySafe(original.author_id, 'share', 'post', row.id);
  return row;
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
// Session-only search over posts decrypted on this device (cleared on reload/lock).

interface Indexed { id: string; author: string; created_at: string; text: string }
const index = new Map<string, Indexed>();

export function payloadText(p: PostPayload): string {
  return [p.text, p.sharedText, p.link?.title, p.link?.description, p.link?.url, p.question?.text, ...(p.question?.options ?? []),
    p.note?.title, p.note?.body, p.checkin?.place, p.checkin?.address, p.lifeEvent?.title, ...(p.photos?.map((x) => x.caption) ?? [])]
    .filter(Boolean).join('\n');
}

export function indexPost(row: PostRow, payload: PostPayload) {
  if (index.has(row.id)) return;
  const text = payloadText(payload);
  if (text) index.set(row.id, { id: row.id, author: row.author_id, created_at: row.created_at, text: text.toLowerCase() });
  if (index.size > 5000) index.delete(index.keys().next().value as string);
}

export function searchSession(q: string, limit = 30): Indexed[] {
  if (getSession().status !== 'ready') { index.clear(); return []; }
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return [...index.values()].filter((x) => terms.every((t) => x.text.includes(t)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

export function clearSessionIndex() { index.clear(); }

/** canonicalJson (used to sign envelopes) rejects `undefined`; drop such keys from plain data. */
export function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
