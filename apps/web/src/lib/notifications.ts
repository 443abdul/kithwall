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
