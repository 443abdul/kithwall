'use client';
import { b64u, seal, sealEnvelope } from '@kithwall/crypto';
import { sb, must } from './supabase';
import { identity, me } from './keys/session';
import { keyring } from './keys/keyring';
import { people, profileHeader } from './people';
import type { FriendshipRow, ProfileInfo } from './types';

const pair = (a: string, b: string) => (a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a });
export const other = (f: FriendshipRow, self: string) => (f.user_a === self ? f.user_b : f.user_a);

export async function myFriendships(): Promise<FriendshipRow[]> {
  return must(await sb().from('friendships').select('*')) as FriendshipRow[];
}

export async function myFriendIds(): Promise<string[]> {
  const rows = await myFriendships();
  return rows.filter((r) => r.status === 'accepted').map((r) => other(r, me()));
}

export async function incomingRequests(): Promise<FriendshipRow[]> {
  const rows = await myFriendships();
  return rows.filter((r) => r.status === 'pending' && r.requested_by !== me());
}

export async function friendStatus(userId: string): Promise<'self' | 'friends' | 'sent' | 'received' | 'none'> {
  if (userId === me()) return 'self';
  const { data } = await sb().from('friendships').select('*').match(pair(me(), userId)).maybeSingle();
  const f = data as FriendshipRow | null;
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friends';
  return f.requested_by === me() ? 'sent' : 'received';
}

async function notify(recipient: string, type: string, objectKind?: string, objectId?: string, preview?: string) {
  let sealed: unknown = null;
  if (preview) {
    await people.ensure([recipient]);
    const r = people.get(recipient);
    if (r) sealed = seal({ recipientKxPub: b64u.decode(r.kx_pub), senderSignPriv: identity().signPriv, context: `notification/${recipient}`, plaintext: new TextEncoder().encode(preview) });
  }
  await sb().from('notifications').insert({ recipient_id: recipient, actor_id: me(), type, object_kind: objectKind ?? null, object_id: objectId ?? null, sealed });
}
export { notify };

export async function sendFriendRequest(userId: string, note?: string) {
  let sealedNote: unknown = null;
  if (note) {
    await people.ensure([userId]);
    const r = people.get(userId)!;
    sealedNote = seal({ recipientKxPub: b64u.decode(r.kx_pub), senderSignPriv: identity().signPriv, context: `friend-note/${me()}/${userId}`, plaintext: new TextEncoder().encode(note) });
  }
  must(await sb().from('friendships').insert({ ...pair(me(), userId), requested_by: me(), note: sealedNote }));
  await notify(userId, 'friend_request', 'profile', me()).catch(() => undefined);
}

export async function acceptFriend(userId: string) {
  must(await sb().from('friendships').update({ status: 'accepted' }).match(pair(me(), userId)));
  await keyring.deliverPending();
  await notify(userId, 'friend_accept', 'profile', me()).catch(() => undefined);
  await republishProfileInfo();
}

export async function ignoreRequest(userId: string) {
  must(await sb().from('friendships').delete().match(pair(me(), userId)));
}

export async function cancelRequest(userId: string) { await ignoreRequest(userId); }

/** Unfriend: remove the friendship, then rotate my friends key so they can't read anything new. */
export async function unfriend(userId: string) {
  must(await sb().from('friendships').delete().match(pair(me(), userId)));
  await keyring.rotate(keyring.friendsAudience!.id);
  await republishProfileInfo();
}

export async function block(userId: string) {
  must(await sb().from('blocks').insert({ blocker: me(), blocked: userId }));
  await keyring.rotate(keyring.friendsAudience!.id);
  await republishProfileInfo();
}
export async function unblock(userId: string) {
  must(await sb().from('blocks').delete().match({ blocker: me(), blocked: userId }));
}

export async function poke(userId: string) {
  must(await sb().from('pokes').insert({ from_id: me(), to_id: userId }));
  await notify(userId, 'poke', 'profile', me()).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------
// My encrypted profile info (shared with my friends audience).
export function myInfo(): ProfileInfo | null { return people.person(me())?.info ?? null; }

export async function saveProfileInfo(info: ProfileInfo) {
  const aud = keyring.friendsAudience!.id;
  const { key, epoch } = await keyring.current(aud);
  // Keep my friend list in sync (friends can see who my friends are unless I hide it).
  const friends = info.hideFriends ? undefined : await myFriendIds();
  const payload: ProfileInfo = { ...info, friends };
  if (!payload.friends) delete payload.friends; // canonicalJson rejects undefined values
  const envelope = sealEnvelope({ header: profileHeader(me(), aud, epoch), payload, audienceKey: key, signPriv: identity().signPriv });
  must(await sb().from('profile_info').upsert({ user_id: me(), audience_id: aud, epoch, envelope, updated_at: new Date().toISOString() }));
  await people.refreshInfo(me());
}

/** Re-encrypt my profile info under the current epoch and refresh my friend list. */
export async function republishProfileInfo() {
  await people.refreshInfo(me());
  const info = myInfo();
  if (info) await saveProfileInfo(info);
}
