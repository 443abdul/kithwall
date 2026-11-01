'use client';
// Safety check-ins (docs/v2/03-safety.md §5, migration 20261024000500_safety_checkins.sql).
//
// The alert is written now and sealed now, on this device, to each chosen contact: an ordinary chat
// message in our one-to-one conversation (same envelope, conversation key and signature as
// lib/messages.ts sendMessage), with its message id fixed in advance. The server keeps the sealed
// messages in safety_checkin_alerts, invisible to the recipients, until the deadline; then pg_cron
// copies them into public.messages and the normal push goes out. Checking in first deletes them.
// Each alert carries its franking commitment (lib/chat/franking.ts) like any other message; the server
// tags it when it is released.
import { sealEnvelope } from '@kithwall/crypto';
import { sb, must } from '../supabase';
import { identity, me } from '../keys/session';
import { conversationKey, messageHeader, openDm, type ChatPayload } from '../messages';
import { frankPayload } from '../chat/franking';

export interface Checkin {
  id: string;
  due_at: string;
  repeat_daily: boolean;
  released_at: string | null;
  created_at: string;
  /** The one-to-one chats that will be alerted. */
  conversations: string[];
}

export interface CheckinLocation { lat: number; lon: number; accuracy: number; at: string }

/** Extra, optional structure inside the sealed payload (readers that don't know it just show the text). */
export interface SafetyAlertPayload extends ChatPayload {
  safetyAlert: { v: 1; dueAt: string; location?: CheckinLocation };
}

export async function listCheckins(): Promise<Checkin[]> {
  const rows = must(await sb().from('safety_checkins').select('id, due_at, repeat_daily, released_at, created_at')
    .order('due_at', { ascending: true })) as Omit<Checkin, 'conversations'>[];
  if (!rows.length) return [];
  const alerts = must(await sb().from('safety_checkin_alerts').select('checkin_id, conversation_id')
    .in('checkin_id', rows.map((r) => r.id))) as { checkin_id: string; conversation_id: string }[];
  return rows.map((r) => ({ ...r, conversations: alerts.filter((a) => a.checkin_id === r.id).map((a) => a.conversation_id) }));
}

/** The other person in each of my one-to-one chats, by conversation id. */
export async function dmPeers(conversationIds: string[]): Promise<Map<string, string>> {
  if (!conversationIds.length) return new Map();
  const rows = must(await sb().from('conversations').select('id, dm_key').in('id', conversationIds)) as { id: string; dm_key: string | null }[];
  const self = me();
  return new Map(rows.filter((r) => r.dm_key).map((r) => [r.id, r.dm_key!.split(':').find((x) => x !== self) ?? self]));
}

/** Ask the browser for the current position, once, when the person taps "Attach my location". */
export function captureLocation(): Promise<CheckinLocation> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { reject(new Error('unsupported')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        lat: Math.round(p.coords.latitude * 1e5) / 1e5, lon: Math.round(p.coords.longitude * 1e5) / 1e5,
        accuracy: Math.round(p.coords.accuracy), at: new Date(p.timestamp || Date.now()).toISOString(),
      }),
      (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable')),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000 },
    );
  });
}

export function mapLink(l: CheckinLocation): string {
  return `https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lon}#map=16/${l.lat}/${l.lon}`;
}

/**
 * Arm a check-in. `text` is the full alert text as the contacts will read it (the screen composes it
 * from the person's message, the deadline and the optional location, in their language).
 */
export async function createCheckin(args: {
  due: Date; repeatDaily: boolean; text: string; contacts: string[]; location?: CheckinLocation | null;
}): Promise<string> {
  const contacts = [...new Set(args.contacts)].filter((c) => c !== me());
  if (!contacts.length) throw new Error('choose_people');
  const alerts = [];
  for (const c of contacts) {
    const conv = await openDm(c);
    const { key, epoch } = await conversationKey(conv);
    const id = crypto.randomUUID();
    const payload: SafetyAlertPayload = {
      text: args.text,
      safetyAlert: { v: 1, dueAt: args.due.toISOString(), ...(args.location ? { location: args.location } : {}) },
    };
    const base = { id, conversation_id: conv.id, sender_id: me(), epoch };
    const franked = frankPayload(base, payload);
    const envelope = sealEnvelope({
      header: messageHeader(base, conv.audience_id),
      payload: franked.payload, audienceKey: key, signPriv: identity().signPriv,
    });
    alerts.push({ id, conversation_id: conv.id, epoch, envelope, frank_commit: franked.commit });
  }
  const { data, error } = await sb().rpc('create_safety_checkin', { p_due: args.due.toISOString(), p_repeat: args.repeatDaily, p_alerts: alerts });
  if (error) throw new Error(error.code === 'P0429' ? 'too_many' : error.code === '22023' ? 'bad_deadline' : error.message);
  return data as string;
}

/** "I'm OK". Returns the next deadline for a daily check-in, or null when it is gone. */
export async function checkIn(id: string): Promise<string | null> {
  return must(await sb().rpc('safety_check_in', { p_id: id })) as string | null;
}

export async function cancelCheckin(id: string): Promise<void> {
  must(await sb().from('safety_checkins').delete().eq('id', id));
}

/** Send the alerts now (the owner's own early release). */
export async function alertNow(id: string): Promise<number> {
  return must(await sb().rpc('safety_checkin_alert_now', { p_id: id })) as number;
}
