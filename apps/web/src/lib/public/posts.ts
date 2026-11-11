// Public posts (docs/v2/10-follow-public.md §4): the typed query behind Explore, the shareable link
// /p/<id> and anything else that lists public posts (a later video feed: fetchPublicPosts({ kinds: ['video'] })).
//
// A public post is signed by its author and NOT encrypted. The database functions used here work with or
// without an account and return, with each post, what a reader needs to check and show it: the author's
// handle, public name and signing key, and the public like and comment counts. Ranking ("popular") happens
// on the server from those public counts and the post's age only; nothing about the reader is sent or kept.
import { sb, must } from '../supabase';
import { readPublicPost, readComment, type Decrypted } from '../content';
import type { CommentPayload, CommentRow, PostKind, PostPayload, PostRow } from '../types';

export interface PublicAuthor { author_username: string; author_name: string | null; author_sign_pub: string }

export interface PublicPostRow extends PostRow, PublicAuthor {
  like_count: number; comment_count: number;
  /** The author lets search engines show their public posts. */
  indexable: boolean;
}

export interface PublicCommentRow extends CommentRow, PublicAuthor {}

export type PublicSort = 'recent' | 'popular';

export interface PublicPostQuery {
  /** 'recent': newest first. 'popular': likes and comments weighed against age, last two weeks. */
  sort?: PublicSort;
  /** Only these kinds of post, e.g. ['video'] or ['photo', 'video']. Omit for everything. */
  kinds?: PostKind[];
  /** Only this account's public posts. */
  authorId?: string;
  limit?: number;
}

/** Where the next page starts: a time for 'recent', a position for 'popular'. */
export type PublicCursor = { before: string } | { offset: number };

export interface PublicPostPage { rows: PublicPostRow[]; next: PublicCursor | null }

export const PUBLIC_PAGE = 12;

export const publicPostsKey = (q: PublicPostQuery) =>
  ['public-posts', q.sort ?? 'recent', (q.kinds ?? []).join(','), q.authorId ?? ''] as const;

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const shape = (r: PublicPostRow): PublicPostRow => ({ ...r, like_count: num(r.like_count), comment_count: num(r.comment_count), indexable: !!r.indexable });

/** One page of public posts. Works signed in or out. */
export async function fetchPublicPosts(q: PublicPostQuery = {}, cursor?: PublicCursor | null): Promise<PublicPostPage> {
  const sort: PublicSort = q.sort === 'popular' ? 'popular' : 'recent';
  const limit = Math.min(Math.max(q.limit ?? PUBLIC_PAGE, 1), 50);
  const offset = cursor && 'offset' in cursor ? cursor.offset : 0;
  const rows = ((must(await sb().rpc('explore_posts', {
    p_sort: sort, p_kinds: q.kinds?.length ? q.kinds : null, p_before: cursor && 'before' in cursor ? cursor.before : null,
    p_offset: offset, p_limit: limit, p_author: q.authorId ?? null,
  })) ?? []) as PublicPostRow[]).map(shape);
  const more = rows.length === limit;
  const next: PublicCursor | null = !more ? null : sort === 'popular' ? { offset: offset + rows.length } : { before: rows[rows.length - 1]!.created_at };
  return { rows, next };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One public post by id, or null when it isn't public (any more). Works signed in or out. */
export async function fetchPublicPost(id: string): Promise<PublicPostRow | null> {
  if (!UUID.test(id)) return null;
  const rows = (must(await sb().rpc('public_post', { p_id: id })) ?? []) as PublicPostRow[];
  return rows[0] ? shape(rows[0]) : null;
}

/** The comments under a public post, oldest first, each with its author. Works signed in or out. */
export async function fetchPublicComments(postId: string): Promise<PublicCommentRow[]> {
  if (!UUID.test(postId)) return [];
  return (must(await sb().rpc('public_comments', { p_post: postId })) ?? []) as PublicCommentRow[];
}

/** Check the author's signature and return the post's content (never trusts unsigned text). */
export function openPublicPost(row: PublicPostRow): Decrypted<PostPayload> {
  return readPublicPost(row, row.author_sign_pub);
}

export function openPublicComment(row: PublicCommentRow): Decrypted<CommentPayload> {
  return readComment(row, null, row.author_sign_pub);
}

/** "Ann Public", falling back to the @handle. */
export const publicName = (a: Pick<PublicAuthor, 'author_name' | 'author_username'>) => a.author_name?.trim() || `@${a.author_username}`;

/** The link people can open without an account. */
export const publicPostPath = (id: string) => `/p/${id}`;
