'use client';
import { b64u, seal, sealEnvelope } from '@kithwall/crypto';
import { sb, must } from './supabase';
import { identity, me } from './keys/session';
import { keyring } from './keys/keyring';
import { people, profileHeader } from './people';
import type { FriendshipRow, ProfileInfo } from './types';
import { loadVisibility, myPrivateFields, saveMyPrivateFields, sealExtra, splitProfile, tierOf } from './social/visibility';
import { ensureCloseList } from './social/closeFriends';

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


// ---------------------------------------------------------------------------------------
// My encrypted profile info (shared with my friends audience).
export function myInfo(): ProfileInfo | null { return people.person(me())?.info ?? null; }

/**
 * Seal my profile. Each field goes where Settings → Privacy → Profile says (lib/social/visibility):
 * connections (this envelope), close friends (inside it, under the close list's key) or only me (vault).
 * `replacePrivate`: the caller passes every field (the editor); otherwise my 'only me' fields are kept.
 */
export async function saveProfileInfo(info: ProfileInfo, opts: { replacePrivate?: boolean } = {}) {
  await keyring.whenReady();
  const aud = keyring.friendsAudience!.id;
  const { key, epoch } = await keyring.current(aud);
  const vis = await loadVisibility();
  const prevPrivate = await myPrivateFields();
  const full: ProfileInfo = opts.replacePrivate ? { ...info } : { ...prevPrivate, ...info };
  delete full.friends;
  const { open, close, mine } = splitProfile(full, vis);
  // Keep my friend list in sync (friends can see who my friends are unless I hide it).
  const friendsTier = tierOf(vis, 'friends');
  if (!info.hideFriends && friendsTier !== 'me') {
    const ids = await myFriendIds();
    if (friendsTier === 'close') close.friends = ids; else open.friends = ids;
  }
  if (Object.keys(close).length) {
    const list = await ensureCloseList();
    const k = await keyring.current(list);
    open.x = sealExtra(me(), list, k.epoch, k.key, close);
  }
  if (JSON.stringify(mine) !== JSON.stringify(prevPrivate)) await saveMyPrivateFields(mine);
  const payload: ProfileInfo = open;
  const envelope = sealEnvelope({ header: profileHeader(me(), aud, epoch), payload, audienceKey: key, signPriv: identity().signPriv });
  const row = { user_id: me(), audience_id: aud, epoch, envelope, updated_at: new Date().toISOString() };
  // Show it everywhere on this device right away (rail, You, posts, chats…); the server sets updated_at.
  const prev = people.infoRow(me());
  people.applyInfoRows([row]);
  try {
    must(await sb().from('profile_info').upsert(row));
  } catch (e) {
    people.applyInfoRows(prev ? [prev] : [], prev ? [] : [me()]);
    throw e;
  }
  await people.refreshInfo(me()).catch(() => undefined);
}

/** Re-encrypt my profile info under the current epoch and refresh my friend list. */
export async function republishProfileInfo() {
  await people.refreshInfo(me());
  const info = myInfo();
  if (info) await saveProfileInfo(info);
}
