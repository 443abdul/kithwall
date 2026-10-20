'use client';
// Notes (Kithwall 2): long posts and journals. A note is a post of kind 'note' (lib/content.ts), so it
// is sealed exactly like any post: to my connections, to only me (my private journal, the "self"
// audience), or to a circle (group_id + the circle's audience).
import { useQuery } from '@tanstack/react-query';
import { sb, must } from '@/lib/supabase';
import { me, useSession } from '@/lib/keys/session';
import { keyring } from '@/lib/keys/keyring';
import { useFriendIds, useKeyringVersion } from '@/lib/hooks';
import { createPost, editPost, preparePosts, readPost, type Audience, type Decrypted } from '@/lib/content';
import { deletePost, fetchPost } from '@/lib/feed/feed';
import type { PostRow } from '@/lib/types';
import type { ShareAudience } from '@/components/circles/shared';

export interface NoteBody { title: string; body: string }

export const MAX_TITLE = 200;
export const MAX_BODY = 40_000;

export function readNote(row: PostRow): Decrypted<NoteBody> {
  const d = readPost(row);
  if (!d.ok) return d;
  const n = d.value.note;
  if (!n) return { ok: false, reason: 'unverified' };
  return { ok: true, value: { title: n.title, body: n.body } };
}

export type NoteAudience = { kind: 'connections' } | { kind: 'only_me' } | { kind: 'circle'; circleId: string } | { kind: 'theirs' };

export function noteAudience(row: PostRow): NoteAudience {
  if (row.group_id) return { kind: 'circle', circleId: row.group_id };
  if (row.author_id === me() && row.audience_id === keyring.selfAudience?.id) return { kind: 'only_me' };
  if (row.author_id === me()) return { kind: 'connections' };
  return { kind: 'theirs' };
}

export async function createNote(n: NoteBody, aud: ShareAudience, circleAudienceId?: string): Promise<PostRow> {
  const payload = { note: { title: n.title.trim().slice(0, MAX_TITLE), body: n.body.slice(0, MAX_BODY), tagged: [] as string[] } };
  if (aud.kind === 'circle') {
    if (!circleAudienceId) throw new Error('circle');
    return createPost({ kind: 'note', payload, groupId: aud.circleId, audience: { kind: 'audience', id: circleAudienceId } });
  }
  const audience: Audience = aud.kind === 'only_me' ? { kind: 'self' } : { kind: 'friends' };
  return createPost({ kind: 'note', payload, audience });
}

export async function saveNote(row: PostRow, n: NoteBody) {
  await editPost(row, { note: { title: n.title.trim().slice(0, MAX_TITLE), body: n.body.slice(0, MAX_BODY), tagged: [] } });
}

export async function removeNote(row: PostRow) { await deletePost(row); }

export async function myNotes(): Promise<PostRow[]> {
  const rows = must(await sb().from('posts').select('*').eq('kind', 'note').eq('author_id', me())
    .order('created_at', { ascending: false }).limit(200)) as PostRow[];
  await preparePosts(rows);
  return rows;
}

export async function connectionsNotes(friendIds: string[]): Promise<PostRow[]> {
  if (!friendIds.length) return [];
  const rows = must(await sb().from('posts').select('*').eq('kind', 'note').in('author_id', friendIds.slice(0, 300))
    .is('group_id', null).order('created_at', { ascending: false }).limit(100)) as PostRow[];
  await preparePosts(rows);
  return rows;
}

export async function circleNotes(circleId: string): Promise<PostRow[]> {
  const rows = must(await sb().from('posts').select('*').eq('kind', 'note').eq('group_id', circleId)
    .order('created_at', { ascending: false }).limit(200)) as PostRow[];
  await preparePosts(rows);
  return rows;
}

// ---------------------------------------------------------------------------------------
// Hooks

function useReady() { return useSession().status === 'ready'; }

export function useMyNotes() {
  const ready = useReady();
  useKeyringVersion();
  return useQuery({ queryKey: ['notes', 'mine'], enabled: ready, queryFn: myNotes });
}

export function useConnectionsNotes() {
  const ready = useReady();
  const f = useFriendIds();
  useKeyringVersion();
  return useQuery({ queryKey: ['notes', 'connections', f.data?.length ?? 0], enabled: ready && !!f.data, queryFn: () => connectionsNotes(f.data ?? []) });
}

export function useCircleNotes(circleId: string) {
  const ready = useReady();
  useKeyringVersion();
  return useQuery({ queryKey: ['notes', 'circle', circleId], enabled: ready, queryFn: () => circleNotes(circleId) });
}

export function useNote(id: string) {
  const ready = useReady();
  useKeyringVersion();
  const valid = /^[0-9a-f-]{36}$/i.test(id);
  return useQuery({ queryKey: ['notes', 'one', id], enabled: ready && valid, queryFn: async () => {
    const row = await fetchPost(id);
    return row && row.kind === 'note' ? row : null;
  } });
}
