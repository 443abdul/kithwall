'use client';
// Circle chats (migration 20261022000500): a circle's chat is a conversation on the circle's OWN
// audience, so its members and keys are exactly the circle's (rotated by the circles code when
// someone leaves). Any active member may start it; there is at most one per circle.
import { sb } from '../supabase';
import { me } from '../keys/session';
import { getGroup } from '../groups';
import type { ConversationRow } from '../messages';

export class NotInCircleError extends Error {}

/** Find, or create, the chat of a circle (groups.id). */
export async function openCircleChat(circleId: string): Promise<ConversationRow> {
  const g = await getGroup(circleId);
  if (!g) throw new NotInCircleError('not_found');
  const find = async () => (await sb().from('conversations').select('*').eq('audience_id', g.audience_id).maybeSingle()).data as ConversationRow | null;
  const existing = await find();
  if (existing) return existing;
  const res = await sb().from('conversations').insert({ audience_id: g.audience_id, created_by: me(), dm_key: null }).select().single();
  if (!res.error) return res.data as ConversationRow;
  if (res.error.code === '23505') {
    const again = await find();
    if (again) return again;
  }
  if (res.error.code === '42501') throw new NotInCircleError('not_member');
  throw new Error(res.error.message);
}
