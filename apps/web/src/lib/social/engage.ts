'use client';
// Polls, emoji reactions, @mentions and reposts. Every value a person picks is sealed on their device under
// a subkey of the post's content key (like comments), signed by them, and readable only by people who can
// read the post (supabase/migrations/20261101000100_social_batch1.sql). Public posts use signed public
// envelopes instead, as their comments do.
import { b64u, deriveSubkey, openEnvelope, openWithContentKey, sealEnvelope, sealWithContentKey, type Envelope, type EnvelopeHeader } from '@kithwall/crypto';
import { sb, must } from '../supabase';
import { identity, me } from '../keys/session';
import { people } from '../people';
import { postContentKey } from '../content';
import { myFriendIds, notify } from '../friends';
import type { LikeRow, PostRow } from '../types';
import { handlesIn, type PollVote } from './pure';

export { handlesIn, tally } from './pure';
export type { PollVote } from './pure';

// --------------------------------------------------------------------------------------- sealing helpers
function seal<T>(row: PostRow, label: string, type: string, payload: T): Envelope {
  const header: EnvelopeHeader = { v: 1, type, id: row.id, author: me(), wall: row.id, audience: 'self' };
  const ck = postContentKey(row);
  if (ck) return sealWithContentKey({ header, payload, contentKey: deriveSubkey(ck, label, me()), signPriv: identity().signPriv });
  if (!row.is_public) throw new Error('The key for this post is not here yet.');
  return sealEnvelope({ header: { ...header, audience: 'public' }, payload, signPriv: identity().signPriv });
}

function open<T>(row: PostRow, label: string, type: string, author: string, env: unknown): T | null {
  const p = people.get(author);
  if (!p || !env) return null;
  const header: EnvelopeHeader = { v: 1, type, id: row.id, author, wall: row.id, audience: 'self' };
  try {
    const signPub = b64u.decode(p.sign_pub);
    const ck = postContentKey(row);
    if (ck) return openWithContentKey<T>({ header, envelope: env as Envelope, contentKey: deriveSubkey(ck, label, author), signPub });
    if (row.is_public) return openEnvelope<T>({ header: { ...header, audience: 'public' }, envelope: env as Envelope, signPub });
  } catch { /* forged, or sealed for another post */ }
  return null;
}

// --------------------------------------------------------------------------------------- polls
export const POLL_MAX_OPTIONS = 6;

/** Cast (or change) my vote: indexes into the poll's options. */
export async function castVote(row: PostRow, choices: number[]): Promise<void> {
  const envelope = seal(row, 'vote', 'poll_vote', { choices: [...new Set(choices)].sort((a, b) => a - b) });
  must(await sb().from('post_votes').upsert({ post_id: row.id, voter_id: me(), envelope, updated_at: new Date().toISOString() }));
}

export async function withdrawVote(row: PostRow): Promise<void> {
  must(await sb().from('post_votes').delete().match({ post_id: row.id, voter_id: me() }));
}

/** Every readable vote on a poll (forged or out-of-range ones are dropped). */
export async function fetchVotes(row: PostRow, options: number): Promise<PollVote[]> {
  const rows = must(await sb().from('post_votes').select('voter_id, envelope').eq('post_id', row.id)) as { voter_id: string; envelope: unknown }[];
  await people.ensure(rows.map((r) => r.voter_id));
  const out: PollVote[] = [];
  for (const r of rows) {
    const v = open<{ choices?: unknown }>(row, 'vote', 'poll_vote', r.voter_id, r.envelope);
    const choices = Array.isArray(v?.choices) ? (v.choices as unknown[]).filter((c): c is number => Number.isInteger(c) && (c as number) >= 0 && (c as number) < options) : [];
    if (choices.length) out.push({ voter: r.voter_id, choices });
  }
  return out;
}

// --------------------------------------------------------------------------------------- reactions
export const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'] as const;
export type Reaction = (typeof REACTIONS)[number];

/** React to a post (replacing an earlier reaction), or take it back with null. */
export async function setReaction(row: PostRow, emoji: Reaction | null): Promise<void> {
  must(await sb().from('likes').delete().match({ target_kind: 'post', target_id: row.id, user_id: me() }));
  if (!emoji) return;
  const sealed = emoji === '❤️' ? null : seal(row, 'reaction', 'reaction', { e: emoji });
  const r = await sb().from('likes').insert({ target_kind: 'post', target_id: row.id, user_id: me(), sealed });
  if (r.error && r.error.code !== '23505') throw new Error(r.error.message);
}

/** The emoji behind a like (a plain like, or one that can't be opened, is a heart). */
export function reactionOf(row: PostRow, like: LikeRow): Reaction {
  if (!like.sealed) return '❤️';
  const v = open<{ e?: unknown }>(row, 'reaction', 'reaction', like.user_id, like.sealed);
  return (REACTIONS as readonly string[]).includes(v?.e as string) ? (v!.e as Reaction) : '❤️';
}

// --------------------------------------------------------------------------------------- mentions
/** The connections a text mentions (only they can read it, so only they are notified). */
export async function resolveMentions(text: string): Promise<string[]> {
  const handles = handlesIn(text);
  if (!handles.length) return [];
  const friends = new Set(await myFriendIds());
  const ids: string[] = [];
  for (const h of handles) {
    const p = await people.byUsername(h).catch(() => null);
    if (p && p.id !== me() && friends.has(p.id)) ids.push(p.id);
  }
  return ids;
}

export async function notifyMentions(ids: string[], objectKind: 'post', objectId: string): Promise<void> {
  for (const id of ids) await notify(id, 'mention', objectKind, objectId).catch(() => undefined);
}
