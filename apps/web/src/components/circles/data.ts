'use client';
// Circles data layer (Kithwall 2). A circle is a v1 group (lib/groups.ts) with privacy 'secret':
// invite-only, never listed, no join requests. Name, description, emoji and colour live in the group's
// envelope, sealed to the circle's audience (epoch keys). Members are audience_members rows;
// removal rotates the audience (rotateIfNeeded) so ex-members can't read anything new.
import { useQuery } from '@tanstack/react-query';
import { sb, must } from '@/lib/supabase';
import { me, useSession } from '@/lib/keys/session';
import { keyring } from '@/lib/keys/keyring';
import { people } from '@/lib/people';
import { useKeyringVersion } from '@/lib/hooks';
import {
  acceptInvite, createGroup, deleteGroup, deliverMemberKeys, getGroup, inviteToGroup, leave, membersOf,
  readGroup, removeMember, rotateIfNeeded, setRole, updateGroup,
  type GroupRow, type MemberRow,
} from '@/lib/groups';
import type { Decrypted } from '@/lib/content';
import { cleanCircleInfo, type CircleTone } from './look';

export type { GroupRow as CircleRow, MemberRow };

/** Decrypted circle metadata (a superset of v1 GroupInfo). */
export interface CircleInfo { name: string; description?: string; emoji?: string; tone?: CircleTone; color?: string }

export interface CircleSummary {
  circle: GroupRow;
  /** My membership row (absent for the creator only on very old v1 groups). */
  membership: MemberRow | null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readCircle(c: GroupRow): Decrypted<CircleInfo> {
  return readGroup(c) as Decrypted<CircleInfo>;
}

export const isAdmin = (c: GroupRow, m: MemberRow | null | undefined) =>
  c.creator_id === me() || (m?.role === 'admin' && m.status === 'active');

/** Every circle I belong to or am invited to (no directory: membership rows only). */
export async function listMyCircles(): Promise<{ active: CircleSummary[]; invited: CircleSummary[] }> {
  const mine = must(await sb().from('audience_members').select('*').eq('member_id', me())) as MemberRow[];
  const byAud = new Map(mine.map((m) => [m.audience_id, m]));
  const groups = must(await sb().from('groups').select('*').order('created_at', { ascending: false })) as GroupRow[];
  const out = { active: [] as CircleSummary[], invited: [] as CircleSummary[] };
  for (const g of groups) {
    const m = byAud.get(g.audience_id) ?? null;
    if (g.creator_id !== me() && !m) continue; // e.g. an Open v1 group I only see while Public is on
    if (m?.status === 'invited') out.invited.push({ circle: g, membership: m });
    else if (m?.status === 'requested') continue;
    else out.active.push({ circle: g, membership: m });
  }
  await people.ensure(groups.flatMap((g) => [g.creator_id, g.envelope_by ?? '']).filter(Boolean));
  const inviters = out.invited.map((s) => s.membership?.invited_by ?? '').filter(Boolean);
  await people.ensure(inviters);
  return out;
}

export async function getCircle(id: string): Promise<CircleSummary | null> {
  if (!UUID_RE.test(id)) return null;
  const g = await getGroup(id);
  if (!g) return null;
  const { data } = await sb().from('audience_members').select('*').eq('audience_id', g.audience_id).eq('member_id', me()).maybeSingle();
  return { circle: g, membership: (data as MemberRow | null) ?? null };
}

export async function createCircle(input: { name: string; description?: string; emoji?: string; tone?: string }, invite: string[]): Promise<string> {
  const info = cleanCircleInfo(input);
  if (!info.name) throw new Error('name');
  return createGroup({ info, privacy: 'secret', invite });
}

export async function saveCircle(c: GroupRow, input: { name: string; description?: string; emoji?: string; tone?: string }) {
  const info = cleanCircleInfo(input);
  if (!info.name) throw new Error('name');
  await updateGroup(c, info);
}

export async function inviteToCircle(c: GroupRow, ids: string[], name: string) {
  return inviteToGroup({ id: c.id, audience_id: c.audience_id }, ids, name);
}

export { acceptInvite, setRole };

/** Decline an invitation or leave a circle. The creator can't leave (they delete it instead). */
export async function leaveCircle(c: GroupRow) {
  if (c.creator_id === me()) throw new Error('creator');
  await leave(c.audience_id);
}

export async function removeFromCircle(c: GroupRow, memberId: string) {
  const info = readCircle(c);
  await removeMember(c, memberId, info.ok ? info.value : null);
}

export async function deleteCircle(c: GroupRow) { await deleteGroup(c); }

/**
 * Admin housekeeping, run when an admin opens a circle: deliver epoch keys to members who lack them,
 * and rotate (then re-seal the circle's info) if someone who left still holds the current key.
 */
export async function circleHousekeeping(c: GroupRow): Promise<void> {
  try {
    await deliverMemberKeys(c.audience_id);
    const before = readCircle(c);
    if (await rotateIfNeeded(c.audience_id)) {
      const fresh = await getGroup(c.id);
      if (fresh && before.ok) await updateGroup(fresh, before.value);
    }
  } catch { /* best effort; the next admin visit retries */ }
}

export async function circleMembers(c: GroupRow): Promise<MemberRow[]> {
  return membersOf(c.audience_id);
}

// ---------------------------------------------------------------------------------------
// React Query hooks

function useReady() { return useSession().status === 'ready'; }

export function useMyCircles() {
  const ready = useReady();
  useKeyringVersion();
  return useQuery({ queryKey: ['circles', 'mine'], enabled: ready, queryFn: listMyCircles });
}

export function useCircle(id: string) {
  const ready = useReady();
  useKeyringVersion();
  return useQuery({ queryKey: ['circles', 'one', id], enabled: ready, queryFn: () => getCircle(id) });
}

export function useCircleMembers(c: GroupRow | null | undefined) {
  const ready = useReady();
  return useQuery({ queryKey: ['circles', 'members', c?.audience_id], enabled: ready && !!c, queryFn: () => circleMembers(c!) });
}

/** Active circles (decrypted names) for audience pickers in events, albums and notes. */
export function useCircleOptions() {
  const q = useMyCircles();
  const kv = useKeyringVersion();
  void kv;
  const options = (q.data?.active ?? []).map((s) => {
    const d = readCircle(s.circle);
    return { id: s.circle.id, audienceId: s.circle.audience_id, info: d.ok ? d.value : null, row: s.circle };
  });
  return { ...q, options };
}

export function hasKeyFor(c: GroupRow): boolean {
  return !!c.envelope_epoch && keyring.has(c.audience_id, c.envelope_epoch);
}
