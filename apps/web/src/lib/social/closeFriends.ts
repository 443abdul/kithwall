'use client';
// Close friends: one private list audience (audiences.kind = 'list') owned by me. Its key reaches the
// members through the normal key delivery (pending_key_deliveries), so posts, stories and profile fields
// sealed to it are readable only by them. The list's id lives in my encrypted vault; who is on it is
// known to the server only as audience_members rows of an unnamed list (members see co-members, as for
// every list). Removing someone rotates the key, so they can't read anything shared afterwards.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sb, must } from '../supabase';
import { me, onLock } from '../keys/session';
import { keyring } from '../keys/keyring';
import { vaultGet, vaultUpdate } from '../settings';
import { people } from '../people';

const NS = 'closeFriends';
interface CloseState { audienceId?: string }

let cached: string | null | undefined;
onLock(() => { cached = undefined; });

/** My close friends list, or null when I haven't made one. */
export async function closeListId(): Promise<string | null> {
  if (cached !== undefined) return cached;
  // No catch: caching "no list" after a failed read would make ensureCloseList create a second one.
  const v = await vaultGet<CloseState>(NS);
  cached = v?.audienceId ?? null;
  return cached;
}

/** The list's id, creating the list (with its first key) the first time it is needed. */
export async function ensureCloseList(): Promise<string> {
  const have = await closeListId();
  if (have) return have;
  await keyring.whenReady();
  const row = await keyring.createAudience('list');
  await vaultUpdate<CloseState>(NS, (prev) => ({ ...(prev ?? {}), audienceId: row.id }));
  cached = row.id;
  return row.id;
}

export async function closeMembers(): Promise<string[]> {
  const aud = await closeListId();
  if (!aud) return [];
  const rows = must(await sb().from('audience_members').select('member_id').eq('audience_id', aud).eq('status', 'active')) as { member_id: string }[];
  const ids = rows.map((r) => r.member_id).filter((id) => id !== me());
  await people.ensure(ids);
  return ids;
}

export async function addCloseFriend(userId: string): Promise<void> {
  const aud = await ensureCloseList();
  const r = await sb().from('audience_members').insert({ audience_id: aud, member_id: userId, status: 'active', role: 'member' });
  if (r.error && r.error.code !== '23505') throw new Error(r.error.message);
  await keyring.deliverPending();
}

/** Remove someone and rotate the key, so nothing shared with close friends from now on reaches them. */
export async function removeCloseFriend(userId: string): Promise<void> {
  const aud = await closeListId();
  if (!aud) return;
  must(await sb().from('audience_members').delete().match({ audience_id: aud, member_id: userId }));
  await keyring.rotate(aud);
  // Profile fields shared with close friends are re-sealed under the new key.
  const { republishProfileInfo } = await import('../friends');
  await republishProfileInfo().catch(() => undefined);
}

export function useCloseFriends(enabled = true) {
  return useQuery({ queryKey: ['close-friends'], enabled, queryFn: closeMembers });
}

export function useCloseFriendsInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['close-friends'] });
}
