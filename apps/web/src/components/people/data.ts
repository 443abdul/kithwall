'use client';
// Connections (v2's name for v1 friendships — same data model: friendships, blocks, the friends
// audience and its key rotation) and personal invite links.
import { useQuery } from '@tanstack/react-query';
import { sb, must } from '@/lib/supabase';
import { me, useSession } from '@/lib/keys/session';
import { notify } from '@/lib/friends';
import { people } from '@/lib/people';
import type { FriendshipRow } from '@/lib/types';

export type Relation = 'self' | 'connected' | 'sent' | 'received' | 'none' | 'blocked';

const pair = (a: string, b: string) => (a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a });

export async function relationTo(userId: string): Promise<Relation> {
  const self = me();
  if (userId === self) return 'self';
  const [{ data: f }, { data: b }] = await Promise.all([
    sb().from('friendships').select('*').match(pair(self, userId)).maybeSingle(),
    sb().from('blocks').select('blocked').match({ blocker: self, blocked: userId }).maybeSingle(),
  ]);
  if (b) return 'blocked';
  const row = f as FriendshipRow | null;
  if (!row) return 'none';
  if (row.status === 'accepted') return 'connected';
  return row.requested_by === self ? 'sent' : 'received';
}

/** Relation to a person; lives under ['friends'] so friendship changes (realtime) refresh it. */
export function useRelation(userId: string | null | undefined) {
  const { status } = useSession();
  return useQuery({ queryKey: ['friends', 'relation', userId], enabled: status === 'ready' && !!userId, queryFn: () => relationTo(userId!) });
}

/** Pending requests I've sent (ids). */
export async function outgoingRequests(): Promise<string[]> {
  const rows = must(await sb().from('friendships').select('*').eq('status', 'pending').eq('requested_by', me())) as FriendshipRow[];
  const ids = rows.map((r) => (r.user_a === me() ? r.user_b : r.user_a));
  await people.ensure(ids);
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Invite links: a code in public.invites (10 uses, 30 days). Redeeming sends the inviter a request.

export interface InviteRow { code: string; inviter_id: string; max_uses: number; uses: number; expires_at: string; created_at: string }

export async function currentInvite(): Promise<InviteRow> {
  const rows = must(await sb().from('invites').select('*').eq('inviter_id', me()).gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(5)) as InviteRow[];
  const usable = rows.find((r) => r.uses < r.max_uses);
  return usable ?? newInvite();
}

export async function newInvite(): Promise<InviteRow> {
  return must(await sb().from('invites').insert({ inviter_id: me() }).select().single()) as InviteRow;
}

export const inviteUrl = (origin: string, code: string) => `${origin}/join?invite=${encodeURIComponent(code)}`;

/** Redeem an invite as a signed-in user: sends the inviter a connection request. Returns the inviter. */
export async function redeemInvite(code: string): Promise<string> {
  const { data, error } = await sb().rpc('redeem_invite', { invite_code: code });
  if (error || typeof data !== 'string') throw new Error(error?.message ?? 'invalid');
  if (data !== me()) await notify(data, 'friend_request', 'profile', me()).catch(() => undefined);
  await people.ensure([data]);
  return data;
}

export { HANDLE_RE } from '@/lib/auth/passkey-shared';

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase().replace(/\s+/g, '');
}
