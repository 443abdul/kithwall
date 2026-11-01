'use client';
// Legacy contact (docs/v2/03-safety.md §12, migration 20261102000200_legacy_contact.sql).
//
// One trusted connection receives a farewell note if I stop opening Kithwall for 3, 6 or 12 months. The note
// is sealed here, on my device (lib/legacy/note.ts), to their identity key; the server keeps ciphertext and
// decides only WHEN to hand it over. legacyHeartbeat() tells the server, at most once a day, that I opened the
// app; that alone keeps the note on hold, and takes back a release if I come back after one.
import { b64u, pqKeysFromKx, verifiedPqPub, type Sealed } from '@kithwall/crypto';
import { sb, must } from '../supabase';
import { getSession, identity, me, unlockedKeys } from '../keys/session';
import { sealGate } from '../keys/pins';
import { people } from '../people';
import { isLegacyMonths, legacyDueOn, utcDay, type LegacyMonths } from './model';
import { noteNeedsReseal, openNote, openSelf, sealNote } from './note';

export interface LegacyRow {
  owner_id: string;
  contact_id: string;
  inactive_months: number;
  sealed_note: Sealed | null;
  sealed_self: Sealed | null;
  note_kx: string | null;
  last_active_on: string;
  reminders: number;
  reminded_on: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Someone who chose me (legacy_for_me). */
export interface LegacyRole { owner_id: string; chosen_at: string; released_at: string | null; has_note: boolean | null }

export type LegacyErrorCode = 'key_changed' | 'not_connected' | 'too_long' | 'unverified' | 'failed';
export class LegacyError extends Error {
  constructor(public code: LegacyErrorCode, message?: string) { super(message ?? code); }
}

/** My setup, or null. */
export async function myLegacy(): Promise<LegacyRow | null> {
  const row = must(await sb().from('legacy_contacts').select('*').eq('owner_id', me()).maybeSingle()) as LegacyRow | null;
  return row;
}

export const dueOn = (row: Pick<LegacyRow, 'last_active_on' | 'inactive_months'>) => legacyDueOn(row.last_active_on, row.inactive_months);

/** My key-exchange keys, current first (earlier ones after an identity change). */
function myKxKeys(): { kxPriv: Uint8Array; kxPub: Uint8Array }[] {
  const u = unlockedKeys();
  return [{ kxPriv: u.identity.kxPriv, kxPub: u.identity.kxPub }, ...(u.previousKx ?? [])];
}

/** The note as I wrote it (from my own sealed copy), or null when there is none or it can't be opened. */
export function readMyNote(row: Pick<LegacyRow, 'sealed_self'>): string | null {
  if (!row.sealed_self) return null;
  try { return openSelf({ sealed: row.sealed_self, ownerId: me(), signPub: identity().signPub, keys: myKxKeys() }).text; } catch { return null; }
}

/**
 * The contact's keys to seal to: the published ones, only if this device trusts them (pinned, or a vouched or
 * verified change; lib/keys/pins.ts sealGate), plus their verified post-quantum key when they have one.
 */
async function contactKeys(contactId: string): Promise<{ kx: Uint8Array; pq: Uint8Array | null }> {
  const { data, error } = await sb().from('profiles').select('id, sign_pub, kx_pub, pq_pub, pq_sig').eq('id', contactId).maybeSingle();
  if (error) throw new LegacyError('failed', error.message);
  const p = data as { id: string; sign_pub: string; kx_pub: string; pq_pub: string | null; pq_sig: string | null } | null;
  if (!p) throw new LegacyError('not_connected');
  const ok = await sealGate([{ id: p.id, s: p.sign_pub, x: p.kx_pub }]);
  if (!ok.has(p.id)) throw new LegacyError('key_changed');
  const kx = b64u.decode(p.kx_pub);
  let pq: Uint8Array | null = null;
  try { pq = verifiedPqPub({ userId: p.id, kxPub: kx, pqPub: p.pq_pub, sig: p.pq_sig, signPub: b64u.decode(p.sign_pub) }); } catch { pq = null; }
  return { kx, pq };
}

function sealFor(contactId: string, keys: { kx: Uint8Array; pq: Uint8Array | null }, text: string) {
  const id = identity();
  return sealNote({
    ownerId: me(), contactId, text, signPriv: id.signPriv,
    contactKxPub: keys.kx, contactPqPub: keys.pq, ownKxPub: id.kxPub, ownPqPub: pqKeysFromKx(id.kxPriv).pub,
  });
}

/** Choose (or change) my legacy contact, period and note. An empty note stores none. */
export async function saveLegacy(contactId: string, months: LegacyMonths, text: string): Promise<void> {
  if (!isLegacyMonths(months)) throw new LegacyError('failed');
  const note = text.trim();
  let sealed: ReturnType<typeof sealFor> | null = null;
  if (note) {
    try { sealed = sealFor(contactId, await contactKeys(contactId), note); }
    catch (e) { if (e instanceof LegacyError) throw e; throw new LegacyError(/too long/.test(String(e)) ? 'too_long' : 'failed'); }
  }
  const { error } = await sb().rpc('set_legacy_contact', {
    p_contact: contactId, p_months: months,
    p_note: sealed?.note ?? null, p_self: sealed?.self ?? null, p_note_kx: sealed?.noteKx ?? null,
  });
  if (error) throw new LegacyError(error.code === '42501' ? 'not_connected' : 'failed', error.message);
}

export async function removeLegacy(): Promise<void> {
  must(await sb().rpc('remove_legacy_contact'));
}

// ---------------------------------------------------------------------------------------------- heartbeat

const SEEN = 'kw.legacy.seen';
let beating: Promise<void> | null = null;

/**
 * Tell the server I opened the app (at most once a UTC day per device and account). If I have a legacy
 * contact, also reseal the note when their key, my key or their post-quantum key changed. Never throws.
 */
export function legacyHeartbeat(): Promise<void> {
  beating ??= beat().finally(() => { beating = null; });
  return beating;
}

async function beat(): Promise<void> {
  const s = getSession();
  if (s.status !== 'ready' || !s.userId) return;
  const key = `${SEEN}.${s.userId}`;
  const today = utcDay();
  try { if (localStorage.getItem(key) === today) return; } catch { /* private mode: ping anyway */ }
  try {
    const { data, error } = await sb().rpc('legacy_seen');
    if (error) throw new Error(error.message);
    try { localStorage.setItem(key, today); } catch { /* ignore */ }
    if ((data as { legacy?: boolean } | null)?.legacy) await resealIfNeeded();
  } catch (e) { console.warn('legacy heartbeat', e); }
}

async function resealIfNeeded(): Promise<void> {
  const row = await myLegacy();
  if (!row?.sealed_note || !row.sealed_self) return;
  let keys: { kx: Uint8Array; pq: Uint8Array | null };
  try { keys = await contactKeys(row.contact_id); } catch { return; }   // key change not confirmed yet: keep the old box
  const stale = noteNeedsReseal({
    sealed: row.sealed_note, noteKx: row.note_kx, ownerId: row.owner_id, contactId: row.contact_id,
    mySignPub: identity().signPub, contactKxPub: keys.kx, contactPqPub: keys.pq,
  });
  if (!stale) return;
  const text = readMyNote(row);
  if (!text) return;
  const sealed = sealFor(row.contact_id, keys, text);
  const months = isLegacyMonths(row.inactive_months) ? row.inactive_months : 6;
  const { error } = await sb().rpc('set_legacy_contact', { p_contact: row.contact_id, p_months: months, p_note: sealed.note, p_self: sealed.self, p_note_kx: sealed.noteKx });
  if (error) console.warn('legacy reseal', error.message);
}

// ---------------------------------------------------------------------------------------------- as a contact

export async function legacyRoles(): Promise<LegacyRole[]> {
  const rows = must(await sb().rpc('legacy_for_me')) as LegacyRole[] | null;
  await people.ensure((rows ?? []).map((r) => r.owner_id));
  return rows ?? [];
}

/** Fetch and open the note someone left me (only after release). */
export async function readLegacyNote(ownerId: string): Promise<{ text: string; writtenAt: string } | null> {
  const res = must(await sb().rpc('legacy_note', { p_owner: ownerId })) as { sealed: Sealed | null; kx: string | null } | null;
  if (!res?.sealed) return null;
  await people.ensure([ownerId]);
  const owner = people.get(ownerId);   // the identity key this device trusts for them
  if (!owner) throw new LegacyError('unverified');
  try {
    const p = openNote({ sealed: res.sealed, ownerId, contactId: me(), senderSignPub: b64u.decode(owner.sign_pub), keys: myKxKeys(), noteKx: res.kx });
    return { text: p.text, writtenAt: p.at };
  } catch { throw new LegacyError('unverified'); }
}

export async function declineLegacy(ownerId: string): Promise<void> {
  must(await sb().rpc('decline_legacy_contact', { p_owner: ownerId }));
}

/** Remember (or stop remembering) the account of someone whose note was released to me. */
export async function rememberAccount(ownerId: string, on: boolean): Promise<void> {
  must(await sb().rpc('remember_account', { p_owner: ownerId, p_on: on }));
  people.forget([ownerId]);
  await people.ensure([ownerId]);
}

// ---------------------------------------------------------------------------------------------- export

/** For "Download my data" (lib/export.ts): my setup with the note decrypted here, and who chose me. */
export async function exportLegacy(): Promise<unknown> {
  const nameOf = (id: string) => people.person(id)?.name ?? null;
  const row = await myLegacy();
  if (row) await people.ensure([row.contact_id]);
  const roles = await legacyRoles();
  const notes = new Map<string, string | null>();
  for (const r of roles) {
    if (r.released_at && r.has_note) notes.set(r.owner_id, await readLegacyNote(r.owner_id).then((n) => n?.text ?? null).catch(() => null));
  }
  return {
    my_legacy_contact: row ? {
      contact: { id: row.contact_id, name: nameOf(row.contact_id), username: people.get(row.contact_id)?.username ?? null },
      inactive_months: row.inactive_months,
      last_active_on: row.last_active_on,
      releases_after: dueOn(row),
      reminders_sent: row.reminders,
      released_at: row.released_at,
      note: row.sealed_self ? readMyNote(row) : null,
      chosen_at: row.created_at,
    } : null,
    legacy_contact_for: roles.map((r) => ({
      id: r.owner_id, name: nameOf(r.owner_id), username: people.get(r.owner_id)?.username ?? null,
      chosen_at: r.chosen_at, released_at: r.released_at, note: notes.get(r.owner_id) ?? null,
    })),
  };
}
