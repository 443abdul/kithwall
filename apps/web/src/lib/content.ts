'use client';
// Encrypt/decrypt posts and comments (spec §3.8). Every function here is the ONLY way the
// app should create or read posts/comments, so headers are built consistently.
import {
  b64u, deriveSubkey, extractContentKey, openEnvelope, openWithContentKey, sealEnvelope, sealWithContentKey,
  type Envelope, type EnvelopeHeader,
} from '@kithwall/crypto';
import { sb, must } from './supabase';
import { identity, me } from './keys/session';
import { keyring, KeyWaitingError } from './keys/keyring';
import { people } from './people';
import type { CommentPayload, CommentRow, PostKind, PostPayload, PostRow } from './types';

export type Audience =
  | { kind: 'friends' }                 // my friends (or the wall owner's friends when posting on their wall)
  | { kind: 'self' }                    // only me
  | { kind: 'audience'; id: string }    // a friend list, group, or event audience
  | { kind: 'public' };                 // only when the operator enabled Public

export function postHeader(p: Pick<PostRow, 'id' | 'author_id' | 'wall_owner_id' | 'group_id' | 'event_id' | 'page_id' | 'kind' | 'is_public' | 'audience_id' | 'epoch'>): EnvelopeHeader {
  const wall = p.wall_owner_id ?? p.group_id ?? p.event_id ?? p.page_id ?? undefined;
  return {
    v: 1, type: `post:${p.kind}`, id: p.id, author: p.author_id, ...(wall ? { wall } : {}),
    audience: p.is_public ? 'public' : { id: p.audience_id!, epoch: p.epoch! },
  };
}

export interface CreatePostArgs {
  kind: PostKind;
  payload: PostPayload;
  wallOwnerId?: string;          // defaults to me (own wall)
  groupId?: string; eventId?: string; pageId?: string;
  audience?: Audience;           // defaults to friends
  sharedPostId?: string;
  id?: string;                   // pre-generated (e.g. when media was uploaded first)
}

/** Resolve which audience (and key) a new post uses. */
async function resolveAudience(args: CreatePostArgs): Promise<{ audienceId: string | null; epoch: number | null; key: Uint8Array | null }> {
  const a = args.audience ?? { kind: 'friends' };
  if (a.kind === 'public') return { audienceId: null, epoch: null, key: null };
  let audienceId: string;
  if (a.kind === 'audience') audienceId = a.id;
  else if (a.kind === 'self') audienceId = keyring.selfAudience!.id;
  else if (args.wallOwnerId && args.wallOwnerId !== me()) {
    const row = must(await sb().from('audiences').select('id').eq('owner_id', args.wallOwnerId).eq('kind', 'friends').single()) as { id: string };
    audienceId = row.id;
  } else audienceId = keyring.friendsAudience!.id;
  const { key, epoch } = await keyring.current(audienceId);
  return { audienceId, epoch, key };
}

export async function createPost(args: CreatePostArgs): Promise<PostRow> {
  const id = args.id ?? crypto.randomUUID();
  const { audienceId, epoch, key } = await resolveAudience(args);
  const ctxIds = { wall_owner_id: null as string | null, group_id: args.groupId ?? null, event_id: args.eventId ?? null, page_id: args.pageId ?? null };
  if (!args.groupId && !args.eventId && !args.pageId) ctxIds.wall_owner_id = args.wallOwnerId ?? me();
  const row = {
    id, author_id: me(), ...ctxIds, kind: args.kind, is_public: audienceId === null,
    audience_id: audienceId, epoch, shared_post_id: args.sharedPostId ?? null,
  };
  const envelope = sealEnvelope({ header: postHeader(row), payload: args.payload, audienceKey: key ?? undefined, signPriv: identity().signPriv });
  return must(await sb().from('posts').insert({ ...row, envelope }).select().single()) as PostRow;
}

export async function editPost(post: PostRow, payload: PostPayload): Promise<void> {
  const key = post.is_public ? undefined : keyring.get(post.audience_id!, post.epoch!) ?? undefined;
  if (!post.is_public && !key) throw new KeyWaitingError(post.audience_id!);
  const envelope = sealEnvelope({ header: postHeader(post), payload, audienceKey: key, signPriv: identity().signPriv });
  must(await sb().from('posts').update({ envelope }).eq('id', post.id));
}

export type Decrypted<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'waiting' | 'unverified' };

const cache = new Map<string, Decrypted<PostPayload>>();

export async function preparePosts(rows: PostRow[]): Promise<void> {
  await people.ensure(rows.flatMap((r) => [r.author_id, r.wall_owner_id ?? '']).filter(Boolean));
}

/** Decrypt and verify a post. Call preparePosts() first so authors' keys are loaded. */
export function readPost(row: PostRow): Decrypted<PostPayload> {
  const cacheKey = `${row.id}:${row.edited_at ?? ''}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.ok) return hit;
  const author = people.get(row.author_id);
  if (!author) return { ok: false, reason: 'waiting' };
  const key = row.is_public ? undefined : keyring.get(row.audience_id!, row.epoch!);
  if (!row.is_public && !key) return { ok: false, reason: 'waiting' };
  let res: Decrypted<PostPayload>;
  try {
    res = { ok: true, value: openEnvelope<PostPayload>({ header: postHeader(row), envelope: row.envelope, audienceKey: key ?? undefined, signPub: b64u.decode(author.sign_pub) }) };
  } catch {
    res = { ok: false, reason: 'unverified' };
  }
  cache.set(cacheKey, res);
  return res;
}

/** The post's content key (needed for comments, poll votes and abuse reports). */
export function postContentKey(row: PostRow): Uint8Array | null {
  if (row.is_public) return null;
  const key = keyring.get(row.audience_id!, row.epoch!);
  if (!key) return null;
  return extractContentKey({ header: postHeader(row), envelope: row.envelope, audienceKey: key });
}

// ---------------------------------------------------------------------------------------
// Comments: encrypted under HKDF(contentKey, "comment", commentId). Public posts → public comments.
// Photos have their own content key (see photos module); pass it as parentKey.

export function commentHeader(c: Pick<CommentRow, 'id' | 'author_id' | 'post_id' | 'photo_id'>): EnvelopeHeader {
  return { v: 1, type: 'comment', id: c.id, author: c.author_id, wall: (c.post_id ?? c.photo_id)!, audience: 'self' };
}

export async function addComment(parent: { postId?: string; photoId?: string; contentKey: Uint8Array | null }, text: string): Promise<CommentRow> {
  const id = crypto.randomUUID();
  const base = { id, author_id: me(), post_id: parent.postId ?? null, photo_id: parent.photoId ?? null };
  const header = commentHeader(base);
  const payload: CommentPayload = { text };
  const envelope = parent.contentKey
    ? sealWithContentKey({ header, payload, contentKey: deriveSubkey(parent.contentKey, 'comment', id), signPriv: identity().signPriv })
    : sealEnvelope({ header: { ...header, audience: 'public' }, payload, signPriv: identity().signPriv });
  return must(await sb().from('comments').insert({ ...base, envelope }).select().single()) as CommentRow;
}

export function readComment(row: CommentRow, parentKey: Uint8Array | null): Decrypted<CommentPayload> {
  const author = people.get(row.author_id);
  if (!author) return { ok: false, reason: 'waiting' };
  try {
    const signPub = b64u.decode(author.sign_pub);
    const header = commentHeader(row);
    const value = parentKey
      ? openWithContentKey<CommentPayload>({ header, envelope: row.envelope as Envelope, contentKey: deriveSubkey(parentKey, 'comment', row.id), signPub })
      : openEnvelope<CommentPayload>({ header: { ...header, audience: 'public' }, envelope: row.envelope as Envelope, signPub });
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'unverified' };
  }
}

// ---------------------------------------------------------------------------------------
// Likes (metadata rows; visible to whoever can read the item).
export async function setLike(kind: 'post' | 'comment' | 'photo', id: string, on: boolean) {
  if (on) {
    const r = await sb().from('likes').insert({ target_kind: kind, target_id: id, user_id: me() });
    if (r.error && r.error.code !== '23505') throw new Error(r.error.message);
  } else {
    must(await sb().from('likes').delete().match({ target_kind: kind, target_id: id, user_id: me() }));
  }
}

// ---------------------------------------------------------------------------------------
// Feed
export async function fetchFeed(before?: string, pageSize = 20): Promise<PostRow[]> {
  const rows = must(await sb().rpc('feed_posts', before ? { before, page_size: pageSize } : { page_size: pageSize })) as PostRow[];
  await preparePosts(rows);
  return rows;
}

export async function fetchWall(userId: string, before?: string, pageSize = 20): Promise<PostRow[]> {
  let q = sb().from('posts').select('*').eq('wall_owner_id', userId).order('created_at', { ascending: false }).limit(pageSize);
  if (before) q = q.lt('created_at', before);
  const rows = must(await q) as PostRow[];
  await preparePosts(rows);
  return rows;
}
