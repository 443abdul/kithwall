'use client';
// Keeps my audiences consistent with my friendships. Either side can end a friendship (or a
// block removes it), but only the owner's device can rotate the owner's keys. So whenever the
// app opens we check: does anyone who is no longer my friend still hold my *current* friends
// key, or sit in one of my friend lists? If so, remove them and rotate (spec §3.7).
import { b64u, openSealed, type Sealed } from '@kithwall/crypto';
import { sb, must } from '../supabase';
import { identity, me } from '../keys/session';
import { keyring } from '../keys/keyring';
import { myFriendIds, republishProfileInfo, unfriend } from '../friends';
import { people } from '../people';
import type { AudienceRow, FriendshipRow } from '../types';

let reconciling: Promise<void> | null = null;
let lastRun = 0;

/** Run at most once a minute; safe to call from any page. */
export function reconcileAudiences(force = false): Promise<void> {
  if (reconciling) return reconciling;
  if (!force && Date.now() - lastRun < 60_000) return Promise.resolve();
  lastRun = Date.now();
  reconciling = doReconcile().catch((e) => console.warn('audience reconcile', e)).finally(() => { reconciling = null; });
  return reconciling;
}

async function doReconcile() {
  const fa = keyring.friendsAudience;
  if (!fa) return;
  const friends = new Set(await myFriendIds());
  const self = me();

  const aud = must(await sb().from('audiences').select('*').eq('id', fa.id).single()) as AudienceRow;
  const holders = must(await sb().from('audience_keys').select('recipient_id')
    .eq('audience_id', fa.id).eq('epoch', aud.current_epoch).eq('sealed_by', self)) as { recipient_id: string }[];
  if (holders.some((h) => h.recipient_id !== self && !friends.has(h.recipient_id))) {
    await keyring.rotate(fa.id);
    await republishProfileInfo();
  }

  const lists = must(await sb().from('audiences').select('id').eq('owner_id', self).eq('kind', 'list')) as { id: string }[];
  if (!lists.length) return;
  const mem = must(await sb().from('audience_members').select('audience_id, member_id')
    .in('audience_id', lists.map((l) => l.id))) as { audience_id: string; member_id: string }[];
  const stale = mem.filter((m) => m.member_id !== self && !friends.has(m.member_id));
  const touched = new Set<string>();
  for (const m of stale) {
    const r = await sb().from('audience_members').delete().match({ audience_id: m.audience_id, member_id: m.member_id });
    if (!r.error) touched.add(m.audience_id);
  }
  for (const id of touched) await keyring.rotate(id);
}

/** Unfriend: end the friendship, rotate my friends key, and drop them from all my lists. */
export async function unfriendFully(userId: string) {
  await unfriend(userId);
  const lists = must(await sb().from('audiences').select('id').eq('owner_id', me()).eq('kind', 'list')) as { id: string }[];
  if (lists.length) {
    const rows = must(await sb().from('audience_members').select('audience_id')
      .eq('member_id', userId).in('audience_id', lists.map((l) => l.id))) as { audience_id: string }[];
    for (const r of rows) {
      must(await sb().from('audience_members').delete().match({ audience_id: r.audience_id, member_id: userId }));
      await keyring.rotate(r.audience_id);
    }
  }
}

/** Decrypt the optional intro note sealed to me with a friend request. */
export function readRequestNote(f: FriendshipRow): string | null {
  if (!f.note) return null;
  const sender = people.get(f.requested_by);
  if (!sender) return null;
  try {
    const id = identity();
    const bytes = openSealed({
      sealed: f.note as Sealed, recipientKxPriv: id.kxPriv, recipientKxPub: id.kxPub,
      senderSignPub: b64u.decode(sender.sign_pub), context: `friend-note/${f.requested_by}/${me()}`,
    });
    return new TextDecoder().decode(bytes);
  } catch { return null; }
}

/** Requests I have sent that are still pending. */
export async function sentRequests(): Promise<string[]> {
  const rows = must(await sb().from('friendships').select('*').eq('status', 'pending').eq('requested_by', me())) as FriendshipRow[];
  const ids = rows.map((r) => (r.user_a === me() ? r.user_b : r.user_a));
  await people.ensure(ids);
  return ids;
}
