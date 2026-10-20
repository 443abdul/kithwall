'use client';
// Events data layer (Kithwall 2). Reuses the v1 container plumbing (lib/events.ts, lib/groups.ts):
// event details are sealed to the guest list's audience; RSVPs are audience_members.rsvp (metadata).
// New in v2: events can belong to a circle (events.group_id, migration 20261022000100_circles.sql);
// circle members see such events and can join them, then a host/admin device delivers the key.
import { useQuery } from '@tanstack/react-query';
import { sb, must } from '@/lib/supabase';
import { me, useSession } from '@/lib/keys/session';
import { keyring } from '@/lib/keys/keyring';
import { people } from '@/lib/people';
import { useKeyringVersion } from '@/lib/hooks';
import { deliverMemberKeys, membersOf, sealContainer, type MemberRow } from '@/lib/groups';
import {
  deleteEvent, downloadIcs, inviteToEvent, readEvent, removeGuest, setRsvp, updateEvent,
  type EventInfo, type EventRow, type Rsvp,
} from '@/lib/events';
import type { Decrypted } from '@/lib/content';
import { isValidTimeZone } from './time';

export type { MemberRow as GuestRow, Rsvp };

export interface EventRow2 extends EventRow { group_id: string | null }
/** v1 EventInfo + the host's time zone (IANA), all sealed. */
export interface EventInfo2 extends EventInfo { tz?: string }

export interface EventSummary { event: EventRow2; me: MemberRow | null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** canonicalJson (used to sign envelopes) rejects undefined, so drop empty optional fields. */
export function cleanInfo(i: EventInfo2): EventInfo2 {
  const out: EventInfo2 = { name: i.name.trim().slice(0, 140), start: i.start };
  if (i.end) out.end = i.end;
  if (i.tz && isValidTimeZone(i.tz)) out.tz = i.tz;
  const where = i.where?.trim().slice(0, 300);
  if (where) out.where = where;
  const description = i.description?.trim().slice(0, 8000);
  if (description) out.description = description;
  if (i.cancelled) out.cancelled = true;
  return out;
}

export function readEvent2(e: EventRow2): Decrypted<EventInfo2> {
  return readEvent(e) as Decrypted<EventInfo2>;
}

export const isHost = (e: EventRow2, m: MemberRow | null | undefined) =>
  e.host_id === me() || (m?.role === 'admin' && m.status === 'active');

async function attachMine(rows: EventRow2[]): Promise<EventSummary[]> {
  if (!rows.length) return [];
  const mine = must(await sb().from('audience_members').select('*').eq('member_id', me())
    .in('audience_id', rows.map((r) => r.audience_id))) as MemberRow[];
  const by = new Map(mine.map((m) => [m.audience_id, m]));
  await people.ensure(rows.flatMap((r) => [r.host_id, r.envelope_by ?? '']).filter(Boolean));
  return rows.map((event) => ({ event, me: by.get(event.audience_id) ?? null }));
}

/** Events I'm hosting or invited to, plus events in my circles. */
export async function listMyEvents(): Promise<EventSummary[]> {
  const rows = must(await sb().from('events').select('*').order('created_at', { ascending: false }).limit(500)) as EventRow2[];
  const all = await attachMine(rows);
  // Public v1 events I have nothing to do with stay out of "my" events.
  return all.filter((s) => s.me || s.event.group_id || s.event.host_id === me());
}

export async function listCircleEvents(circleId: string): Promise<EventSummary[]> {
  const rows = must(await sb().from('events').select('*').eq('group_id', circleId).order('created_at', { ascending: false }).limit(200)) as EventRow2[];
  return attachMine(rows);
}

export async function getEvent2(id: string): Promise<EventSummary | null> {
  if (!UUID_RE.test(id)) return null;
  const row = must(await sb().from('events').select('*').eq('id', id).maybeSingle()) as EventRow2 | null;
  if (!row) return null;
  return (await attachMine([row]))[0] ?? null;
}

export async function createEvent2(args: { info: EventInfo2; invite: string[]; circleId?: string | null }): Promise<string> {
  const info = cleanInfo(args.info);
  const id = crypto.randomUUID();
  const aud = await keyring.createAudience('event');
  try {
    must(await sb().from('audience_members').insert({ audience_id: aud.id, member_id: me(), role: 'admin', status: 'active', rsvp: 'yes' }));
    const { envelope, epoch } = await sealContainer('event', id, aud.id, info, false);
    must(await sb().from('events').insert({
      id, host_id: me(), audience_id: aud.id, is_public: false, public_body: null,
      envelope, envelope_epoch: epoch, group_id: args.circleId ?? null,
    }));
  } catch (e) {
    await sb().from('audiences').delete().eq('id', aud.id);
    throw e;
  }
  const invite = args.invite.filter((x) => x !== me());
  if (invite.length) await inviteToEvent({ id, audience_id: aud.id }, invite, info.name);
  return id;
}

export async function saveEvent(e: EventRow2, info: EventInfo2) {
  await updateEvent(e, cleanInfo(info));
}

export async function cancelEvent(e: EventRow2, info: EventInfo2, cancelled: boolean) {
  await updateEvent(e, cleanInfo({ ...info, cancelled }));
}

export async function inviteGuests(e: EventRow2, ids: string[], name: string) {
  return inviteToEvent({ id: e.id, audience_id: e.audience_id }, ids, name);
}

/** Join a circle event I can see (I'm in its circle) and answer at the same time. */
export async function joinAndRsvp(e: EventRow2, rsvp: Rsvp) {
  const r = await sb().from('audience_members').insert({ audience_id: e.audience_id, member_id: me(), role: 'member', status: 'active' });
  if (r.error && r.error.code !== '23505') throw new Error(r.error.message);
  await setRsvp(e.audience_id, rsvp);
}

export async function answer(s: EventSummary, rsvp: Rsvp) {
  if (!s.me) await joinAndRsvp(s.event, rsvp);
  else await setRsvp(s.event.audience_id, rsvp);
}

/** Leave an event's guest list (not for the host). */
export async function leaveEvent(e: EventRow2) {
  must(await sb().from('audience_members').delete().eq('audience_id', e.audience_id).eq('member_id', me()));
}

export async function guestsOf(e: EventRow2): Promise<MemberRow[]> { return membersOf(e.audience_id); }

/** Host/admin device: deliver keys to guests who joined or were invited by others. */
export async function eventHousekeeping(e: EventRow2) {
  try { await deliverMemberKeys(e.audience_id); } catch { /* best effort */ }
}

export { deleteEvent, downloadIcs, removeGuest };

// ---------------------------------------------------------------------------------------
// Hooks

function useReady() { return useSession().status === 'ready'; }

export function useMyEvents() {
  const ready = useReady();
  useKeyringVersion();
  return useQuery({ queryKey: ['events', 'mine'], enabled: ready, queryFn: listMyEvents });
}

export function useCircleEvents(circleId: string) {
  const ready = useReady();
  useKeyringVersion();
  return useQuery({ queryKey: ['events', 'circle', circleId], enabled: ready, queryFn: () => listCircleEvents(circleId) });
}

export function useEvent2(id: string) {
  const ready = useReady();
  useKeyringVersion();
  return useQuery({ queryKey: ['events', 'one', id], enabled: ready, queryFn: () => getEvent2(id) });
}

export function useGuests(e: EventRow2 | null | undefined, enabled = true) {
  const ready = useReady();
  return useQuery({ queryKey: ['events', 'guests', e?.audience_id], enabled: ready && !!e && enabled, queryFn: () => guestsOf(e!) });
}
