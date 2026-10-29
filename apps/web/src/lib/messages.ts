'use client';
// Messages & chat (spec §3.10): one system. A conversation = an audience of kind 'conversation'
// whose epoch key is sealed to each member. Messages are envelopes under that key.
//
// Key authority: only the conversation OWNER's device mints keys (on creation and on rotation).
// Membership changes set `conversations.rekey_needed` in the database; the owner's device then
// advances the epoch with a compare-and-swap and seals the new key to the remaining members, so
// people who left can't read anything sent afterwards. If the owner leaves, the database hands
// ownership to a remaining member (leave_conversation RPC), whose device rotates.
import { b64u, extractContentKey, decryptBlob, encryptBlob, openEnvelope, sealEnvelope, type EnvelopeHeader } from '@kithwall/crypto';
import { sb, must } from './supabase';
import { identity, me } from './keys/session';
import { keyring, KeyWaitingError } from './keys/keyring';
import { isHiddenChat } from './safety/hidden';
import { people } from './people';
import { keyAuthorities } from './keys/roster';
import type { AudienceRow, FileRef, MessagePayload, MessageRow } from './types';
import type { Decrypted } from './content';
import type { VoiceMeta } from './chat/voice';

export interface ConversationRow {
  id: string; audience_id: string; created_by: string; dm_key: string | null; last_message_at: string; created_at: string;
  rekey_needed?: boolean;
  /** Disappearing messages (phase 3): seconds, null = off. New chats start at 4 weeks. */
  disappear_secs?: number | null;
  /** When someone last chose the timer (null for chats from before phase 3 that nobody has set). */
  disappear_set_at?: string | null;
}
export interface ConversationSummary extends ConversationRow {
  /** Everyone in the conversation (owner + active members), including me. */
  members: string[];
  lastReadAt: string | null;
  unread: boolean;
  ownerId: string | null;
  admins: string[];
  /** Who may hand out this chat's keys as far as this device can verify: the owner plus admins with a signed
   *  grant checked against pinned keys (security re-review R-K-2). */
  keyAuthorities: string[];
  epoch: number;
  nameEnc: unknown;
  isDm: boolean;
  /** Newest message (ciphertext), if any. */
  last: MessageRow | null;
  /** When I joined (null for the owner / unknown). */
  joinedAt: string | null;
  /** 'conversation' for chats; 'group' for a circle's chat (it uses the circle's own audience). */
  kind: 'conversation' | 'group';
  /** The circle (groups.id) for a circle chat. */
  circleId: string | null;
}

/** Things that happen in a conversation, shown inline ("Alice added Bob."). */
export type ConversationEvent =
  | { kind: 'rename'; name: string }
  | { kind: 'added'; ids: string[] }
  | { kind: 'removed'; ids: string[] }
  | { kind: 'left' }
  /** Server notice (phase 3): someone changed the disappearing-messages timer (null = off). */
  | { kind: 'timer'; secs: number | null }
  /** Server notice (phase 4): a voice/video call. state: still ringing, someone answered, or nobody did. */
  | { kind: 'call'; video: boolean; state: 'ringing' | 'answered' | 'missed'; mine: boolean }
  /** Server notice (security re-review R-K-2): someone joined, was made an admin, or now owns the chat. */
  | { kind: 'roster'; what: 'joined' | 'admin' | 'owner'; member: string };
export interface ChatPayload extends MessagePayload {
  event?: ConversationEvent;
  /** Quoted message (Kithwall 2): the id plus its author, so the quote survives if it scrolls out of the loaded page. */
  replyTo?: { id: string; author: string };
  /** Link preview made through the no-log proxy, encrypted with the message (like a post's link). */
  link?: { url: string; title?: string; description?: string; site?: string; image?: FileRef };
  /** Voice note (phase 4): length and waveform; the audio itself is the audio/* file in `attachments`. */
  voice?: VoiceMeta;
  /** A reply to (or reaction on) one of the recipient's stories: whose story it was. */
  story?: { author: string };
}

export const MAX_MESSAGE_CHARS = 20_000;
export const dmKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export function messageHeader(m: Pick<MessageRow, 'id' | 'conversation_id' | 'sender_id' | 'epoch'>, audienceId: string): EnvelopeHeader {
  return { v: 1, type: 'message', id: m.id, author: m.sender_id, wall: m.conversation_id, audience: { id: audienceId, epoch: m.epoch } };
}

// ---------------------------------------------------------------------------------------------
// Creating conversations

/** The existing one-to-one conversation with someone, without creating one. */
export async function findDm(userId: string): Promise<ConversationRow | null> {
  return (await sb().from('conversations').select('*').eq('dm_key', dmKey(me(), userId)).maybeSingle()).data as ConversationRow | null;
}

/** Find or create the one-to-one conversation with someone (friends, or anyone by username). */
export async function openDm(friendId: string): Promise<ConversationRow> {
  if (friendId === me()) throw new Error('You can\'t message yourself.');
  const existing = await findDm(friendId);
  if (existing) return existing;
  return createConversation([friendId], dmKey(me(), friendId));
}

/**
 * Thrown when someone in the list can't be added: chats are only with connections, or with people who
 * share a circle with you and accept requests (security review D2, enforced by the database).
 */
export class NotConnectedError extends Error {
  constructor() { super('not_connected'); }
}

/** True for the database's "not_connected" refusal (create_conversation / adding a chat member). */
export function isNotConnected(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && e.code === '42501' && /not_connected/.test(e.message ?? '');
}

export async function createConversation(memberIds: string[], dm: string | null = null, name?: string): Promise<ConversationRow> {
  const ids = [...new Set(memberIds)].filter((m) => m !== me());
  if (!ids.length) throw new Error('Choose at least one person.');
  const aud = await keyring.createAudience('conversation');
  // Members and the conversation are created in one transaction by the database, which checks that
  // every person is someone I may start a chat with (supabase/migrations/20261028010200_authz_conversations.sql).
  const conv = await sb().rpc('create_conversation', { p_audience: aud.id, p_members: ids, p_dm: !!dm });
  if (conv.error) {
    await sb().from('audiences').delete().eq('id', aud.id);
    // Lost a race creating the same DM: use the other one.
    if (dm && conv.error.code === '23505') return must(await sb().from('conversations').select('*').eq('dm_key', dm).single()) as ConversationRow;
    if (isNotConnected(conv.error)) throw new NotConnectedError();
    throw new Error(conv.error.code === 'P0429' ? 'You\'ve started too many conversations today. Try again tomorrow.' : conv.error.message);
  }
  if (name?.trim() && !dm) await writeName(aud, name.trim()).catch((e) => console.warn('conversation name', e));
  // Sign each addition (the database created the rows), so devices deliver keys to these members only.
  for (const id of ids) {
    await sb().from('audience_members').update(keyring.memberAdd(aud.id, id)).match({ audience_id: aud.id, member_id: id });
  }
  await keyring.deliverPending();
  return conv.data as ConversationRow;
}

// ---------------------------------------------------------------------------------------------
// Keys

async function audienceRow(aud: string): Promise<AudienceRow> {
  return must(await sb().from('audiences').select('*').eq('id', aud).single()) as AudienceRow;
}

/** Current conversation key. Never mints a key except through rotation (see header comment). */
export async function conversationKey(conv: Pick<ConversationRow, 'audience_id'>): Promise<{ key: Uint8Array; epoch: number }> {
  let row = await audienceRow(conv.audience_id);
  let key = keyring.get(row.id, row.current_epoch);
  if (!key) { await keyring.load(); key = keyring.get(row.id, row.current_epoch); }
  if (!key && row.owner_id === me() && row.kind === 'conversation') {
    // The owner is the only key authority: if even the owner has no key for this epoch, nobody
    // does (e.g. an interrupted rotation), so it's safe to move to a fresh epoch.
    if (await rotateConversation(conv)) {
      row = await audienceRow(conv.audience_id);
      key = keyring.get(row.id, row.current_epoch);
    }
  }
  if (!key) throw new KeyWaitingError(conv.audience_id);
  return { key, epoch: row.current_epoch };
}

const rotating = new Map<string, Promise<boolean>>();

/**
 * Advance the conversation to a new epoch (owner only). Compare-and-swap on the epoch so two of
 * my tabs can't both mint a key; the name is re-encrypted under the new key. Returns true if
 * this call rotated.
 */
export function rotateConversation(conv: Pick<ConversationRow, 'audience_id'>): Promise<boolean> {
  const aud = conv.audience_id;
  const inflight = rotating.get(aud);
  if (inflight) return inflight;
  const p = (async () => {
    const row = await audienceRow(aud);
    if (row.owner_id !== me()) return false;
    const name = readName(row);
    // Mints the key, publishes its signed record and advances the epoch atomically (K1).
    const next = await keyring.advance(aud, row.current_epoch);
    if (!next) return false; // another device of mine got there first
    if (name.ok && name.value) await writeName(next, name.value).catch((e) => console.warn('conversation name re-encryption', e));
    await keyring.deliverPending();
    return true;
  })();
  rotating.set(aud, p);
  void p.finally(() => rotating.delete(aud)).catch(() => undefined);
  return p;
}

// ---------------------------------------------------------------------------------------------
// Conversation name: stored in audiences.name_enc, encrypted under the current epoch key.

interface NameEnc { v: 1; epoch: number; blob: string }
const nameAad = (aud: string, epoch: number) => `conversation-name/${aud}/${epoch}`;

async function writeName(aud: AudienceRow, name: string) {
  const key = keyring.get(aud.id, aud.current_epoch);
  if (!key) throw new KeyWaitingError(aud.id);
  const nameEnc: NameEnc | null = name
    ? { v: 1, epoch: aud.current_epoch, blob: encryptBlob(key, new TextEncoder().encode(name.slice(0, 120)), nameAad(aud.id, aud.current_epoch)) }
    : null;
  must(await sb().from('audiences').update({ name_enc: nameEnc }).eq('id', aud.id));
}

/** Decrypt a conversation name (ok with '' when it has none). */
export function readName(a: { id: string; name_enc: unknown } | { audience_id: string; nameEnc: unknown }): Decrypted<string> {
  const id = 'audience_id' in a ? a.audience_id : a.id;
  const enc = ('nameEnc' in a ? a.nameEnc : a.name_enc) as NameEnc | null;
  if (!enc) return { ok: true, value: '' };
  const key = keyring.get(id, enc.epoch);
  if (!key) return { ok: false, reason: 'waiting' };
  try {
    return { ok: true, value: new TextDecoder().decode(decryptBlob(key, enc.blob, nameAad(id, enc.epoch))) };
  } catch {
    return { ok: false, reason: 'unverified' };
  }
}

/** Rename a group conversation (owner/admins; the database enforces it). */
export async function renameConversation(conv: ConversationSummary, name: string) {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 120);
  await conversationKey(conv); // make sure we hold the current key
  await writeName(await audienceRow(conv.audience_id), clean);
  await sendMessage(conv, { text: '', event: { kind: 'rename', name: clean } });
}

// ---------------------------------------------------------------------------------------------
// Membership

export async function addMembers(conv: ConversationRow, memberIds: string[]) {
  const ids = [...new Set(memberIds)].filter((m) => m !== me());
  if (!ids.length) return;
  for (const m of ids) {
    const r = await sb().from('audience_members').insert({ audience_id: conv.audience_id, member_id: m, status: 'active', role: 'member', invited_by: me(), ...keyring.memberAdd(conv.audience_id, m) });
    if (r.error && r.error.code !== '23505') {
      throw new Error(r.error.code === '42501' ? 'You can only add your friends to this conversation.' : r.error.message);
    }
  }
  // Owner: new epoch so newcomers don't receive the earlier key. Others: hand over the current
  // key now; the owner's device rotates when it next sees the change.
  if (!(await rotateConversation(conv).catch(() => false))) await keyring.deliverPending();
  await sendMessage(conv, { text: '', event: { kind: 'added', ids } }).catch(() => undefined);
}

/** Owner removes someone; their access ends and the key is rotated. */
export async function removeMember(conv: ConversationSummary, memberId: string) {
  await sendMessage(conv, { text: '', event: { kind: 'removed', ids: [memberId] } }).catch(() => undefined);
  must(await sb().from('audience_members').delete().match({ audience_id: conv.audience_id, member_id: memberId }));
  await rotateConversation(conv);
}

/** Leave a group conversation. The database hands ownership over if needed. */
export async function leaveConversation(conv: ConversationRow) {
  await sendMessage(conv, { text: '', event: { kind: 'left' } }).catch(() => undefined);
  must(await sb().rpc('leave_conversation', { conv: conv.id }));
}

// ---------------------------------------------------------------------------------------------
// Messages

export async function sendMessage(conv: ConversationRow, payload: ChatPayload, id = crypto.randomUUID()): Promise<MessageRow> {
  if ((payload.text ?? '').length > MAX_MESSAGE_CHARS) throw new Error('That message is too long.');
  const { key, epoch } = await conversationKey(conv);
  const base = { id, conversation_id: conv.id, sender_id: me(), epoch };
  const envelope = sealEnvelope({ header: messageHeader(base, conv.audience_id), payload, audienceKey: key, signPriv: identity().signPriv });
  const res = await sb().from('messages').insert({ ...base, envelope }).select().single();
  if (res.error) {
    if (res.error.code === 'P0429') throw new Error('You\'ve sent a lot of messages today. Try again later.');
    if (res.error.code === '42501') throw new Error('You can\'t send messages in this conversation.');
    throw new Error(res.error.message);
  }
  return res.data as MessageRow;
}

/**
 * Unsend (for everyone). Removes my files from storage, then the database wipes the ciphertext and keeps a
 * content-free tombstone for a few minutes so the other members' screens drop it live
 * (unsend_message RPC, migration 20261024000100).
 */
export async function deleteMessage(row: MessageRow, attachments: FileRef[] = []) {
  if (row.sender_id !== me()) throw new Error('You can only delete your own messages.');
  const mine = attachments.map((a) => a.path).filter((p) => p.startsWith(`${me()}/`));
  if (mine.length) {
    await sb().storage.from('media').remove(mine);
  }
  must(await sb().rpc('unsend_message', { msg: row.id }));
  forget(row.id);
}

/**
 * Edit my message: a new payload sealed under the SAME epoch key (so an edit never reaches people who
 * joined later), replacing the old one; the server sets edited_at and keeps no history.
 */
export async function editMessage(conv: Pick<ConversationRow, 'audience_id'>, row: MessageRow, text: string): Promise<void> {
  if (row.sender_id !== me()) throw new Error('You can only edit your own messages.');
  if (text.length > MAX_MESSAGE_CHARS) throw new Error('That message is too long.');
  const cur = readMessage(conv, row);
  if (!cur.ok || cur.value.event) throw new Error("This message can't be edited.");
  const next: ChatPayload = { ...cur.value, text: text.trim() };
  if (!next.text && !next.attachments?.length) throw new Error("A message can't be empty.");
  let key = keyring.get(conv.audience_id, row.epoch);
  if (!key) { await keyring.load(); key = keyring.get(conv.audience_id, row.epoch); }
  if (!key) throw new KeyWaitingError(conv.audience_id);
  const envelope = sealEnvelope({ header: messageHeader(row, conv.audience_id), payload: next, audienceKey: key, signPriv: identity().signPriv });
  const res = await sb().from('messages').update({ envelope }).eq('id', row.id).select('id');
  if (res.error) throw new Error(res.error.code === 'P0429' ? "You've edited a lot of messages today. Try again later." : res.error.message);
  if (!res.data?.length) throw new Error("This message can't be edited any more.");
  forget(row.id);
}

/** Set (seconds) or turn off (null) disappearing messages. The server posts a notice in the thread. */
export async function setConversationTimer(conv: Pick<ConversationRow, 'id'>, secs: number | null): Promise<void> {
  const r = await sb().rpc('set_conversation_timer', { conv: conv.id, secs });
  if (r.error) throw new Error(r.error.code === '42501' ? 'not_allowed' : r.error.code === 'P0429' ? 'rate_limited' : r.error.message);
}

export async function fetchMessages(conv: Pick<ConversationRow, 'id'>, before?: string, pageSize = 50): Promise<MessageRow[]> {
  let q = sb().from('messages').select('*').eq('conversation_id', conv.id).order('created_at', { ascending: false }).limit(pageSize);
  if (before) q = q.lt('created_at', before);
  const rows = (must(await q) as MessageRow[]).reverse();
  await people.ensure(rows.map((r) => r.sender_id));
  return rows;
}

const cache = new Map<string, Decrypted<ChatPayload>>();
const cacheKey = (row: Pick<MessageRow, 'id' | 'edited_at'>) => `${row.id}:${row.edited_at ?? ''}`;
function forget(id: string) {
  for (const k of cache.keys()) if (k.startsWith(`${id}:`)) cache.delete(k);
}

/** A server notice (timer change) as a system event. Notices carry no content, so nothing to decrypt. */
function readNotice(row: MessageRow): Decrypted<ChatPayload> {
  const n = row.notice as { kind?: unknown; secs?: unknown } | null | undefined;
  if (n && n.kind === 'timer' && (n.secs === null || (typeof n.secs === 'number' && Number.isFinite(n.secs)))) {
    return { ok: true, value: { text: '', event: { kind: 'timer', secs: n.secs as number | null } } };
  }
  const c = row.notice as { kind?: unknown; video?: unknown; ans?: unknown } | null | undefined;
  if (c && c.kind === 'call') {
    // Calls ring for 45 s (lib/calls/engine.ts); after that, an unanswered call is a missed call.
    const state = c.ans === true ? 'answered' : Date.now() - Date.parse(row.created_at) < 50_000 ? 'ringing' : 'missed';
    return { ok: true, value: { text: '', event: { kind: 'call', video: c.video === true, state, mine: row.sender_id === me() } } };
  }
  const r = row.notice as { kind?: unknown; what?: unknown; m?: unknown } | null | undefined;
  if (r && r.kind === 'roster' && (r.what === 'joined' || r.what === 'admin' || r.what === 'owner') && typeof r.m === 'string') {
    return { ok: true, value: { text: '', event: { kind: 'roster', what: r.what, member: r.m } } };
  }
  return { ok: false, reason: 'unverified' };
}

export function readMessage(conv: Pick<ConversationRow, 'audience_id'>, row: MessageRow): Decrypted<ChatPayload> {
  if (row.notice) return readNotice(row);
  const hit = cache.get(cacheKey(row));
  if (hit) return hit;
  const sender = people.get(row.sender_id);
  const key = keyring.get(conv.audience_id, row.epoch);
  if (!sender || !key) return { ok: false, reason: 'waiting' };
  let out: Decrypted<ChatPayload>;
  try {
    const value = openEnvelope<ChatPayload>({ header: messageHeader(row, conv.audience_id), envelope: row.envelope, audienceKey: key, signPub: b64u.decode(sender.sign_pub) });
    out = value && typeof value === 'object' && typeof (value.text ?? '') === 'string' ? { ok: true, value } : { ok: false, reason: 'unverified' };
  } catch {
    out = { ok: false, reason: 'unverified' };
  }
  if (cache.size > 5000) cache.clear();
  cache.set(cacheKey(row), out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Listing

interface MemberRow { audience_id: string; member_id: string; role: string; status: string; last_read_at: string | null; created_at: string; grant_by: string | null; grant_sig: string | null }

async function summarize(convs: ConversationRow[]): Promise<ConversationSummary[]> {
  if (!convs.length) return [];
  const auds = convs.map((c) => c.audience_id);
  const [members, audRows, previews, reads, circles] = await Promise.all([
    sb().from('audience_members').select('audience_id, member_id, role, status, last_read_at, created_at, grant_by, grant_sig').in('audience_id', auds).eq('status', 'active'),
    sb().from('audiences').select('id, owner_id, kind, current_epoch, name_enc').in('id', auds),
    sb().rpc('conversation_previews', { conv_ids: convs.map((c) => c.id) }),
    // My private read markers (migration 20261022000500; co-members can't see them).
    sb().from('conversation_reads').select('conversation_id, last_read_at').in('conversation_id', convs.map((c) => c.id)),
    sb().from('groups').select('id, audience_id').in('audience_id', auds),
  ]);
  const ms = must(members) as MemberRow[];
  const as = must(audRows) as Pick<AudienceRow, 'id' | 'owner_id' | 'kind' | 'current_epoch' | 'name_enc'>[];
  const last = new Map((must(previews) as MessageRow[]).map((m) => [m.conversation_id, m]));
  const readAt = new Map(((reads.data ?? []) as { conversation_id: string; last_read_at: string }[]).map((r) => [r.conversation_id, r.last_read_at]));
  const circleOf = new Map(((circles.data ?? []) as { id: string; audience_id: string }[]).map((g) => [g.audience_id, g.id]));
  const self = me();
  const out = convs.map((c): ConversationSummary => {
    const mine = ms.filter((m) => m.audience_id === c.audience_id);
    const a = as.find((x) => x.id === c.audience_id);
    const ids = new Set(mine.map((m) => m.member_id));
    if (a) ids.add(a.owner_id);
    const myRow = mine.find((m) => m.member_id === self);
    // Private marker first; then the pre-2026-10-22 shared column; then this device's own marker.
    const lastReadAt = latest(readAt.get(c.id) ?? null, myRow?.last_read_at ?? null, localReadAt(c.id));
    const lm = last.get(c.id) ?? null;
    const unread = !!lm && lm.sender_id !== self && (!lastReadAt || lastReadAt < lm.created_at);
    return {
      ...c, members: [...ids], lastReadAt, unread, last: lm,
      ownerId: a?.owner_id ?? null, epoch: a?.current_epoch ?? 1, nameEnc: a?.name_enc ?? null, isDm: !!c.dm_key,
      admins: [...new Set([...(a ? [a.owner_id] : []), ...mine.filter((m) => m.role === 'admin').map((m) => m.member_id)])],
      keyAuthorities: [],
      joinedAt: a?.owner_id === self ? null : myRow?.created_at ?? null,
      kind: a?.kind === 'group' ? 'group' : 'conversation',
      circleId: circleOf.get(c.audience_id) ?? null,
    };
  });
  await people.ensure(out.flatMap((c) => [...c.members, ...(c.last ? [c.last.sender_id] : [])]));
  // Signed admin grants are checked once the granters' (trusted) keys are loaded.
  for (const c of out) {
    if (c.ownerId) c.keyAuthorities = keyAuthorities({ id: c.audience_id, owner_id: c.ownerId }, ms.filter((m) => m.audience_id === c.audience_id));
  }
  return out;
}

/** My conversations, newest first, with members, unread state and the newest message. */
export async function listConversations(limit = 30): Promise<ConversationSummary[]> {
  const convs = must(await sb().from('conversations').select('*').order('last_message_at', { ascending: false }).limit(limit)) as ConversationRow[];
  return summarize(convs);
}

export async function getConversation(id: string): Promise<ConversationSummary | null> {
  const c = (await sb().from('conversations').select('*').eq('id', id).maybeSingle()).data as ConversationRow | null;
  if (!c) return null;
  return (await summarize([c]))[0] ?? null;
}

const latest = (...xs: (string | null)[]): string | null => xs.reduce<string | null>((a, b) => (b && (!a || b > a) ? b : a), null);

const READ_KEY = 'kw.read.';
function localReadAt(convId: string): string | null {
  try { return localStorage.getItem(READ_KEY + convId); } catch { return null; }
}

export async function markRead(conv: ConversationRow) {
  const now = new Date().toISOString();
  // Private read marker (owner-only; shared with co-members only as an opt-in read receipt).
  const r = await sb().from('conversation_reads').upsert({ conversation_id: conv.id, user_id: me(), last_read_at: now });
  // Offline fallback only, and never for a hidden chat: its id must not sit in plaintext storage (security review L10).
  if (r.error && !isHiddenChat(conv.id)) { try { localStorage.setItem(READ_KEY + conv.id, now); } catch { /* ignore */ } }
}


export { KeyWaitingError };

/**
 * Per-message content key for abuse reports: discloses only this message, not the whole
 * conversation epoch. Returns null if we don't hold the key or the message fails verification.
 */
export function messageContentKey(conv: { id: string; audience_id: string }, row: MessageRow): Uint8Array | null {
  const sender = people.get(row.sender_id);
  const key = keyring.get(conv.audience_id, row.epoch);
  if (!sender || !key) return null;
  try {
    return extractContentKey({ header: messageHeader(row, conv.audience_id), envelope: row.envelope, audienceKey: key, signPub: b64u.decode(sender.sign_pub) });
  } catch { return null; }
}
