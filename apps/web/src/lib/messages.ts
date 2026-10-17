'use client';
// Messages & chat (spec §3.10): one system. A conversation = an audience of kind 'conversation'
// whose epoch key is sealed to each member. Messages are envelopes under that key.
import { b64u, openEnvelope, sealEnvelope, type EnvelopeHeader } from '@kithwall/crypto';
import { sb, must } from './supabase';
import { identity, me } from './keys/session';
import { keyring, KeyWaitingError } from './keys/keyring';
import { people } from './people';
import type { MessagePayload, MessageRow } from './types';
import type { Decrypted } from './content';

export interface ConversationRow { id: string; audience_id: string; created_by: string; dm_key: string | null; last_message_at: string; created_at: string }
export interface ConversationSummary extends ConversationRow { members: string[]; lastReadAt: string | null; unread: boolean }

export const dmKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export function messageHeader(m: Pick<MessageRow, 'id' | 'conversation_id' | 'sender_id' | 'epoch'>, audienceId: string): EnvelopeHeader {
  return { v: 1, type: 'message', id: m.id, author: m.sender_id, wall: m.conversation_id, audience: { id: audienceId, epoch: m.epoch } };
}

/** Find or create the one-to-one conversation with a friend. */
export async function openDm(friendId: string): Promise<ConversationRow> {
  const key = dmKey(me(), friendId);
  const existing = (await sb().from('conversations').select('*').eq('dm_key', key).maybeSingle()).data as ConversationRow | null;
  if (existing) return existing;
  return createConversation([friendId], key);
}

export async function createConversation(memberIds: string[], dm: string | null = null): Promise<ConversationRow> {
  const aud = await keyring.createAudience('conversation');
  for (const m of memberIds) {
    must(await sb().from('audience_members').insert({ audience_id: aud.id, member_id: m, role: 'member', status: 'active', invited_by: me() }));
  }
  const conv = await sb().from('conversations').insert({ audience_id: aud.id, created_by: me(), dm_key: dm }).select().single();
  if (conv.error) {
    // Lost a race creating the same DM: use the other one.
    if (dm && conv.error.code === '23505') {
      await sb().from('audiences').delete().eq('id', aud.id);
      return must(await sb().from('conversations').select('*').eq('dm_key', dm).single()) as ConversationRow;
    }
    throw new Error(conv.error.message);
  }
  await keyring.deliverPending();
  return conv.data as ConversationRow;
}

export async function addMembers(conv: ConversationRow, memberIds: string[]) {
  for (const m of memberIds) {
    must(await sb().from('audience_members').insert({ audience_id: conv.audience_id, member_id: m, status: 'active', role: 'member', invited_by: me() }));
  }
  await keyring.deliverPending();
}

/** Leave a group conversation; the remaining members rotate the key when they next open it. */
export async function leaveConversation(conv: ConversationRow) {
  must(await sb().from('audience_members').delete().match({ audience_id: conv.audience_id, member_id: me() }));
}

export async function sendMessage(conv: ConversationRow, payload: MessagePayload, id = crypto.randomUUID()): Promise<MessageRow> {
  const { key, epoch } = await keyring.current(conv.audience_id);
  const base = { id, conversation_id: conv.id, sender_id: me(), epoch };
  const envelope = sealEnvelope({ header: messageHeader(base, conv.audience_id), payload, audienceKey: key, signPriv: identity().signPriv });
  return must(await sb().from('messages').insert({ ...base, envelope }).select().single()) as MessageRow;
}

export async function fetchMessages(conv: ConversationRow, before?: string, pageSize = 50): Promise<MessageRow[]> {
  let q = sb().from('messages').select('*').eq('conversation_id', conv.id).order('created_at', { ascending: false }).limit(pageSize);
  if (before) q = q.lt('created_at', before);
  const rows = (must(await q) as MessageRow[]).reverse();
  await people.ensure(rows.map((r) => r.sender_id));
  return rows;
}

export function readMessage(conv: ConversationRow, row: MessageRow): Decrypted<MessagePayload> {
  const sender = people.get(row.sender_id);
  const key = keyring.get(conv.audience_id, row.epoch);
  if (!sender || !key) return { ok: false, reason: 'waiting' };
  try {
    return { ok: true, value: openEnvelope<MessagePayload>({ header: messageHeader(row, conv.audience_id), envelope: row.envelope, audienceKey: key, signPub: b64u.decode(sender.sign_pub) }) };
  } catch {
    return { ok: false, reason: 'unverified' };
  }
}

/** My conversations, newest first, with members and unread state. */
export async function listConversations(limit = 30): Promise<ConversationSummary[]> {
  const convs = must(await sb().from('conversations').select('*').order('last_message_at', { ascending: false }).limit(limit)) as ConversationRow[];
  if (!convs.length) return [];
  const auds = convs.map((c) => c.audience_id);
  const members = must(await sb().from('audience_members').select('audience_id, member_id, last_read_at').in('audience_id', auds)) as
    { audience_id: string; member_id: string; last_read_at: string | null }[];
  const owners = must(await sb().from('audiences').select('id, owner_id').in('id', auds)) as { id: string; owner_id: string }[];
  const out = convs.map((c) => {
    const ms = members.filter((m) => m.audience_id === c.audience_id);
    const ids = new Set(ms.map((m) => m.member_id));
    const owner = owners.find((o) => o.id === c.audience_id)?.owner_id;
    if (owner) ids.add(owner);
    const mine = ms.find((m) => m.member_id === me());
    // Owners have no membership row; keep their read marker in localStorage.
    const lastReadAt = mine?.last_read_at ?? ownerReadAt(c.id);
    return { ...c, members: [...ids], lastReadAt, unread: !lastReadAt || lastReadAt < c.last_message_at };
  });
  await people.ensure(out.flatMap((c) => c.members));
  return out;
}

const READ_KEY = 'kw.read.';
function ownerReadAt(convId: string): string | null {
  try { return localStorage.getItem(READ_KEY + convId); } catch { return null; }
}

export async function markRead(conv: ConversationRow) {
  const now = new Date().toISOString();
  const r = await sb().from('audience_members').update({ last_read_at: now }).match({ audience_id: conv.audience_id, member_id: me() }).select();
  if (!r.data?.length) { try { localStorage.setItem(READ_KEY + conv.id, now); } catch { /* ignore */ } }
}

export { KeyWaitingError };
