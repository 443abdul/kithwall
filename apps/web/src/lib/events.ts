'use client';
// Events: private events are end-to-end encrypted to the guest list (an audience with epoch keys);
// public events (only while the operator enables Public) carry a signed, unencrypted body.
// Invitees are added as active members straight away so they can read the details and wall;
// their RSVP lives in audience_members.rsvp (metadata the server can see, like the guest list).
import { b64u, openEnvelope, sealEnvelope, type Envelope } from '@kithwall/crypto';
import { sb, must } from './supabase';
import { identity, me } from './keys/session';
import { keyring } from './keys/keyring';
import { people } from './people';
import { createPost, type Decrypted } from './content';
import {
  containerHeader, deliverMemberKeys, membersOf, notifyWith, openContainer, rotateIfNeeded, sealContainer,
  type ContainerRow, type MemberRow,
} from './groups';
import type { PostPayload, PostRow } from './types';

export interface EventRow extends ContainerRow {
  host_id: string; is_public: boolean; public_body: Envelope | null; created_at: string;
}

export interface EventInfo {
  name: string;
  tagline?: string;
  start: string;          // ISO (UTC)
  end?: string;           // ISO (UTC)
  where?: string;
  street?: string;
  description?: string;
  cancelled?: boolean;
}

export type Rsvp = 'yes' | 'maybe' | 'no';
export const RSVP_LABEL: Record<Rsvp, string> = { yes: 'Attending', maybe: 'Maybe Attending', no: 'Not Attending' };

export function readEvent(e: EventRow, signers?: Set<string>): Decrypted<EventInfo> {
  if (e.is_public) {
    // Public events: the signed body lives in public_body.
    if (!e.public_body || !e.envelope_by) return { ok: false, reason: 'unverified' };
    if (signers && !signers.has(e.envelope_by)) return { ok: false, reason: 'unverified' };
    const author = people.get(e.envelope_by);
    if (!author) return { ok: false, reason: 'waiting' };
    try {
      const value = openEnvelope<EventInfo>({ header: containerHeader('event', e.id, e.envelope_by, e.audience_id, null), envelope: e.public_body, signPub: b64u.decode(author.sign_pub) });
      return { ok: true, value };
    } catch { return { ok: false, reason: 'unverified' }; }
  }
  return openContainer<EventInfo>('event', e, e.envelope, false, signers);
}

export async function listEvents(): Promise<EventRow[]> {
  const rows = must(await sb().from('events').select('*').order('created_at', { ascending: false }).limit(500)) as EventRow[];
  await people.ensure(rows.flatMap((r) => [r.host_id, r.envelope_by ?? '']).filter(Boolean));
  return rows;
}

export async function getEvent(id: string): Promise<EventRow | null> {
  const { data, error } = await sb().from('events').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  const e = data as EventRow | null;
  if (e) await people.ensure([e.host_id, e.envelope_by ?? ''].filter(Boolean));
  return e;
}

async function sealEvent(id: string, aud: string, info: EventInfo, isPublic: boolean) {
  if (isPublic) {
    const body = sealEnvelope({ header: containerHeader('event', id, me(), aud, null), payload: info, signPriv: identity().signPriv });
    return { envelope: null, public_body: body, envelope_epoch: null };
  }
  const { envelope, epoch } = await sealContainer('event', id, aud, info, false);
  return { envelope, public_body: null, envelope_epoch: epoch };
}

export async function createEvent(args: { info: EventInfo; isPublic: boolean; invite: string[] }): Promise<string> {
  const id = crypto.randomUUID();
  const aud = await keyring.createAudience('event');
  try {
    must(await sb().from('audience_members').insert({ audience_id: aud.id, member_id: me(), role: 'admin', status: 'active', rsvp: 'yes' }));
    const sealed = await sealEvent(id, aud.id, args.info, args.isPublic);
    must(await sb().from('events').insert({ id, host_id: me(), audience_id: aud.id, is_public: args.isPublic, ...sealed }));
  } catch (e) {
    await sb().from('audiences').delete().eq('id', aud.id);
    throw e;
  }
  if (args.invite.length) await inviteToEvent({ id, audience_id: aud.id }, args.invite, args.info.name);
  return id;
}

export async function updateEvent(e: EventRow, info: EventInfo): Promise<void> {
  const sealed = await sealEvent(e.id, e.audience_id, info, e.is_public);
  must(await sb().from('events').update(sealed).eq('id', e.id));
}

export async function inviteToEvent(e: { id: string; audience_id: string }, friendIds: string[], name: string): Promise<number> {
  let n = 0;
  for (const f of friendIds) {
    const r = await sb().from('audience_members').insert({ audience_id: e.audience_id, member_id: f, role: 'member', status: 'active' });
    if (r.error && r.error.code !== '23505') throw new Error(r.error.message);
    if (!r.error) {
      n++;
      await notifyWith(f, 'event_invite', 'event', e.id, `invited you to ${name}`);
    }
  }
  await deliverMemberKeys(e.audience_id).catch(() => undefined);
  await keyring.deliverPending().catch(() => undefined);
  return n;
}

export async function setRsvp(aud: string, rsvp: Rsvp) {
  must(await sb().from('audience_members').update({ rsvp }).eq('audience_id', aud).eq('member_id', me()));
}

/** Host/admin removes a guest; the guest list's key rotates so they can't read new posts. */
export async function removeGuest(e: EventRow, memberId: string, info: EventInfo | null) {
  must(await sb().from('audience_members').delete().eq('audience_id', e.audience_id).eq('member_id', memberId));
  if (!e.is_public && (await rotateIfNeeded(e.audience_id)) && info) {
    const fresh = await getEvent(e.id);
    if (fresh) await updateEvent(fresh, info);
  }
}

export async function deleteEvent(e: EventRow) {
  must(await sb().from('audiences').delete().eq('id', e.audience_id));
}

export async function postToEvent(e: EventRow, payload: PostPayload): Promise<PostRow> {
  return createPost({ kind: 'status', payload, eventId: e.id, audience: e.is_public ? { kind: 'public' } : { kind: 'audience', id: e.audience_id } });
}

export { membersOf, type MemberRow };

// ---------------------------------------------------------------------------------------
// Dates

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const monShort = (d: Date) => MON[d.getMonth()];

function clock(d: Date) {
  let h = d.getHours();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return d.getMinutes() ? `${h}:${String(d.getMinutes()).padStart(2, '0')}${ap}` : `${h}:00${ap}`;
}

/** 2010 style: "Saturday, October 23 at 8:00pm" (+ " until 11:00pm"). */
export function fmtEventTime(info: Pick<EventInfo, 'start' | 'end'>): string {
  const s = new Date(info.start);
  let out = `${DAYS[s.getDay()]}, ${MONTHS[s.getMonth()]} ${s.getDate()}${s.getFullYear() !== new Date().getFullYear() ? `, ${s.getFullYear()}` : ''} at ${clock(s)}`;
  if (info.end) {
    const e = new Date(info.end);
    out += e.toDateString() === s.toDateString() ? ` until ${clock(e)}` : ` until ${MONTHS[e.getMonth()]} ${e.getDate()} at ${clock(e)}`;
  }
  return out;
}

export function isPast(info: Pick<EventInfo, 'start' | 'end'>, now = Date.now()) {
  const end = info.end ? Date.parse(info.end) : Date.parse(info.start) + 3 * 3600_000;
  return end < now;
}

/** Days until the next occurrence of a YYYY-MM-DD birthday (0 = today), or null. */
export function daysUntilBirthday(birthday: string | undefined, now = new Date()): number | null {
  const m = birthday?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const month = Number(m[2]) - 1, day = Number(m[3]);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), month, day);
  if (next < today) next = new Date(now.getFullYear() + 1, month, day);
  return Math.round((next.getTime() - today.getTime()) / 86400_000);
}

export function birthdayLabel(birthday: string): string {
  const m = birthday.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}` : '';
}

// ---------------------------------------------------------------------------------------
// Calendar export (.ics), generated on this device from the decrypted event. Never uploaded.

function icsEscape(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
const icsDate = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Fold lines at 75 octets (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (bytes.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function eventIcs(id: string, info: EventInfo): string {
  const end = info.end ?? new Date(Date.parse(info.start) + 3 * 3600_000).toISOString();
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kithwall//Events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${id}@kithwall`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(info.start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(info.name)}`,
    ...(info.where || info.street ? [`LOCATION:${icsEscape([info.where, info.street].filter(Boolean).join(', '))}`] : []),
    ...(info.description || info.tagline ? [`DESCRIPTION:${icsEscape([info.tagline, info.description].filter(Boolean).join('\n\n'))}`] : []),
    ...(info.cancelled ? ['STATUS:CANCELLED'] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Save the .ics file locally (blob: URL; nothing leaves the device). */
export function downloadIcs(id: string, info: EventInfo) {
  const blob = new Blob([eventIcs(id, info)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${info.name.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'event'}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export { rotateIfNeeded, deliverMemberKeys, type MemberRow as GuestRow };
