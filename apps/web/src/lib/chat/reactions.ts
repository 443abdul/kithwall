'use client';
// Message reactions (Kithwall 2, migration 20261022000500). One reaction per person per message.
// The emoji is encrypted under the conversation key of the epoch it was made in:
//   enc = encryptBlob(key, utf8(emoji), "message-reaction/<message id>/<user id>/<epoch>")
// Removing a reaction sets enc = null (an UPDATE, so Realtime can filter it by conversation).
// Reactions live beside the messages, so they don't bump the chat, mark it unread or push.
import { decryptBlob, encryptBlob } from '@kithwall/crypto';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { sb, must } from '../supabase';
import { me, useSession } from '../keys/session';
import { keyring } from '../keys/keyring';
import { conversationKey, type ConversationRow } from '../messages';

/** The quick picker. Anything else is rejected on read, so a reaction can't smuggle text. */
export const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'] as const;
export type ReactionEmoji = (typeof REACTIONS)[number];
const ALLOWED = new Set<string>(REACTIONS);

export interface ReactionRow { message_id: string; user_id: string; conversation_id: string; epoch: number; enc: string | null; updated_at: string }

const aad = (messageId: string, userId: string, epoch: number) => `message-reaction/${messageId}/${userId}/${epoch}`;

export function readReaction(audienceId: string, r: ReactionRow): ReactionEmoji | null {
  if (!r.enc) return null;
  const key = keyring.get(audienceId, r.epoch);
  if (!key) return null;
  try {
    const v = new TextDecoder().decode(decryptBlob(key, r.enc, aad(r.message_id, r.user_id, r.epoch)));
    return ALLOWED.has(v) ? (v as ReactionEmoji) : null;
  } catch { return null; }
}

export async function fetchReactions(convId: string, messageIds: string[]): Promise<ReactionRow[]> {
  if (!messageIds.length) return [];
  const out: ReactionRow[] = [];
  for (let i = 0; i < messageIds.length; i += 150) {
    const rows = must(await sb().from('message_reactions').select('message_id, user_id, conversation_id, epoch, enc, updated_at')
      .eq('conversation_id', convId).in('message_id', messageIds.slice(i, i + 150))) as ReactionRow[];
    out.push(...rows);
  }
  return out;
}

/** Set (or with null, remove) my reaction to a message. */
export async function setReaction(conv: ConversationRow, messageId: string, emoji: ReactionEmoji | null): Promise<void> {
  const { key, epoch } = await conversationKey(conv);
  const enc = emoji ? encryptBlob(key, new TextEncoder().encode(emoji), aad(messageId, me(), epoch)) : null;
  const r = await sb().from('message_reactions').upsert({ message_id: messageId, user_id: me(), conversation_id: conv.id, epoch, enc });
  if (r.error) throw new Error(r.error.code === 'P0429' ? 'rate_limited' : r.error.message);
}

/** Reactions of the loaded messages, live while the thread is open. */
export function useReactions(convId: string | null | undefined, messageIds: string[]) {
  const { status } = useSession();
  const qc = useQueryClient();
  const key = messageIds.join(',');
  const q = useQuery({
    queryKey: ['reactions', convId, key],
    enabled: status === 'ready' && !!convId && messageIds.length > 0,
    queryFn: () => fetchReactions(convId!, messageIds),
    staleTime: 15_000,
  });
  useEffect(() => {
    if (status !== 'ready' || !convId) return;
    const ch = sb().channel(`reactions:${convId}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions', filter: `conversation_id=eq.${convId}` },
        () => { void qc.invalidateQueries({ queryKey: ['reactions', convId] }); })
      .subscribe();
    return () => { void sb().removeChannel(ch); };
  }, [status, convId, qc]);
  return q;
}
