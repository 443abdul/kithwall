'use client';
import { b64u, openSealed, type Sealed } from '@kithwall/crypto';
import { sb, must } from './supabase';
import { identity, me } from './keys/session';
import { people } from './people';
import type { NotificationRow } from './types';

export async function fetchNotifications(limit = 30): Promise<NotificationRow[]> {
  const rows = must(await sb().from('notifications').select('*').eq('recipient_id', me()).order('created_at', { ascending: false }).limit(limit)) as NotificationRow[];
  await people.ensure(rows.map((r) => r.actor_id));
  return rows;
}

export async function markAllRead() {
  must(await sb().from('notifications').update({ read_at: new Date().toISOString() }).eq('recipient_id', me()).is('read_at', null));
}
export async function markRead(id: string) {
  must(await sb().from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id));
}

/** Decrypt the optional preview text sealed to me by the actor. */
export function preview(n: NotificationRow): string | null {
  if (!n.sealed) return null;
  const actor = people.get(n.actor_id);
  if (!actor) return null;
  try {
    const id = identity();
    const bytes = openSealed({ sealed: n.sealed as Sealed, recipientKxPriv: id.kxPriv, recipientKxPub: id.kxPub, senderSignPub: b64u.decode(actor.sign_pub), context: `notification/${me()}` });
    return new TextDecoder().decode(bytes);
  } catch { return null; }
}

export const NOTIF_ICON: Record<string, string> = {
  friend_request: 'friends', friend_accept: 'friends', wall_post: 'wall', comment: 'comment', like: 'like', tag: 'photo',
  poke: 'poke', group_invite: 'group', group_request: 'group', event_invite: 'event', mention: 'comment', share: 'share',
  question_vote: 'question', checkin_tag: 'place', relationship: 'heart', recovery_request: 'key', recovery_trustee: 'key',
  game: 'game', key_waiting: 'lock',
};

const TEXT: Record<string, string> = {
  friend_request: 'sent you a friend request.', friend_accept: 'accepted your friend request.',
  wall_post: 'wrote on your Wall.', comment: 'commented on your post.', like: 'likes your post.',
  tag: 'tagged you in a photo.', poke: 'poked you.', group_invite: 'added you to a group.',
  group_request: 'asked to join your group.', event_invite: 'invited you to an event.', mention: 'mentioned you in a comment.',
  share: 'shared your post.', question_vote: 'answered your question.', checkin_tag: 'checked in with you.',
  relationship: 'listed you in a relationship.', recovery_request: 'is asking for your help to recover their account.',
  recovery_trustee: 'chose you as a trusted friend for account recovery.', game: 'sent you a Kithville request.',
  key_waiting: 'is waiting for your device to share your posts with them.',
};
export const notifText = (type: string) => TEXT[type] ?? 'did something.';

/** Where clicking a notification goes. */
export function notifHref(n: NotificationRow, actorUsername?: string): string {
  switch (n.object_kind) {
    case 'post': return `/post/${n.object_id}`;
    case 'photo': return `/photos/${n.object_id}`;
    case 'group': return `/groups/${n.object_id}`;
    case 'event': return `/events/${n.object_id}`;
    case 'conversation': return `/messages/${n.object_id}`;
    case 'recovery_request': return `/settings/security#trusted`;
    case 'page': return `/pages/${n.object_id}`;
  }
  if (n.type === 'friend_request') return '/requests';
  if (n.type === 'poke') return '/pokes';
  return actorUsername ? `/${actorUsername}` : '/notifications';
}
