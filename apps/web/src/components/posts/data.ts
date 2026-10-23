'use client';
// Data access for the Kithwall 2 post components, on top of the v1 data layer (lib/content.ts,
// lib/feed/feed.ts, lib/groups.ts). Everything here returns ciphertext rows; decryption happens in the
// components with readPost()/readComment() so "waiting for a key" can re-render when keys arrive.
import { sb, must } from '@/lib/supabase';
import { fetchFeed, fetchWall, preparePosts } from '@/lib/content';
import { containerPosts } from '@/lib/groups';
import { people } from '@/lib/people';
import { me } from '@/lib/keys/session';
import { deleteMedia, fileRefPaths } from '@/lib/media';
import type { FileRef, PostPayload, PostRow } from '@/lib/types';
import type { FeedScope } from '.';
import { nextCursor } from './logic';
import { isExpired, isScheduled } from '@/lib/chat/ephemeral';

export const PAGE_SIZE = 12;

export const feedKey = (scope: FeedScope) =>
  ['v2feed', scope.kind, scope.kind === 'home' ? '' : scope.kind === 'profile' ? scope.userId : scope.kind === 'circle' ? scope.circleId : scope.eventId] as const;

export interface FeedPage { rows: PostRow[]; cursor?: string }

export async function fetchScopePage(scope: FeedScope, before?: string): Promise<FeedPage> {
  let rows: PostRow[];
  switch (scope.kind) {
    case 'home': rows = await fetchFeed(before, PAGE_SIZE); break;
    case 'profile': rows = await fetchWall(scope.userId, before, PAGE_SIZE); break;
    case 'circle': rows = await containerPosts('group_id', scope.circleId, before, PAGE_SIZE); break;
    case 'event': rows = await containerPosts('event_id', scope.eventId, before, PAGE_SIZE); break;
  }
  await rememberAudienceKinds(rows);
  // Circle docs are stored as note revisions (shared_post_id = the doc); only the newest is a post.
  // My own scheduled posts wait in "Scheduled" (You), not in feeds; expired ones are already gone.
  const now = Date.now();
  const shown = rows.filter((r) => !(r.kind === 'note' && r.shared_post_id && r.group_id)
    && !isScheduled(r, now) && !isExpired(r, now));
  return { rows: shown, cursor: nextCursor(rows, PAGE_SIZE) };
}

// ---------------------------------------------------------------------------------------------
// Audience kinds (friends / list / self / group / event) for the badge on each post. Audiences are
// readable by their members, so this costs one small query per page.

const kinds = new Map<string, string>();

async function rememberAudienceKinds(rows: PostRow[]) {
  const ids = [...new Set(rows.map((r) => r.audience_id).filter((x): x is string => !!x && !kinds.has(x)))];
  if (!ids.length) return;
  const found = must(await sb().from('audiences').select('id, kind').in('id', ids)) as { id: string; kind: string }[];
  for (const a of found) kinds.set(a.id, a.kind);
}

export type AudienceBadge =
  | { kind: 'connections' } | { kind: 'some' } | { kind: 'only_me' } | { kind: 'public' }
  | { kind: 'circle'; circleId: string } | { kind: 'event'; eventId: string };

export function audienceOf(row: PostRow): AudienceBadge {
  if (row.group_id) return { kind: 'circle', circleId: row.group_id };
  if (row.event_id) return { kind: 'event', eventId: row.event_id };
  if (row.is_public) return { kind: 'public' };
  const k = row.audience_id ? kinds.get(row.audience_id) : undefined;
  if (k === 'self') return { kind: 'only_me' };
  if (k === 'list') return { kind: 'some' };
  return { kind: 'connections' };
}

/** Load one post (e.g. after an edit) with its author ready for decryption. */
export async function refetchPost(id: string): Promise<PostRow | null> {
  const { data } = await sb().from('posts').select('*').eq('id', id).maybeSingle();
  const row = (data as PostRow | null) ?? null;
  if (row) { await preparePosts([row]); await rememberAudienceKinds([row]); }
  return row;
}

export async function ensurePeople(ids: string[]) { await people.ensure(ids); }

// ---------------------------------------------------------------------------------------------
// Deleting: storage objects first (deleting the post row cascades its media_objects rows, after which
// the ciphertext could no longer be found by path), then the row.

/** Every storage path of my own that a post's payload references. */
export function myPayloadPaths(payload: PostPayload | null | undefined, self: string): string[] {
  if (!payload) return [];
  const refs: FileRef[] = [];
  if (payload.link?.image) refs.push(payload.link.image);
  if (payload.video) { refs.push(payload.video.file); if (payload.video.poster) refs.push(payload.video.poster); }
  // Kithwall 2 post photos are post-linked files (albumId ''); v1 album photos belong to their album.
  for (const p of payload.photos ?? []) if (!p.albumId) refs.push(p.files.big, p.files.med, p.files.thumb);
  return refs.flatMap(fileRefPaths).filter((p) => p.startsWith(`${self}/`));
}

export async function deletePostFully(row: PostRow, payload: PostPayload | null | undefined): Promise<void> {
  const mine = row.author_id === me() ? myPayloadPaths(payload, me()) : [];
  if (mine.length) await deleteMedia(mine).catch(() => undefined);
  must(await sb().from('posts').delete().eq('id', row.id));
}
