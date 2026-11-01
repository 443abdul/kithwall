// Message franking (docs/v2/03-franking.md): every message and every edit carries a fresh franking key `fk`
// inside its sealed payload and a commitment to its content next to the ciphertext (messages.frank_commit),
// which the database tags with the sender, chat and time. Recipients check the commitment when they open a
// message; a reporter can hand the message, fk and the tag to Kithwall, which verifies them
// (supabase/migrations/20261102000600_message_franking.sql). Nothing here reaches the server unless the
// person reports the message.
import { b64u, frankCommit, frankingBody, frankMatches, newFrankingKey } from '@kithwall/crypto';
import type { MessageRow } from '../types';

type Ids = Pick<MessageRow, 'id' | 'conversation_id' | 'sender_id'>;

/** The payload as committed: everything except the franking key itself. */
export function withoutFk<T extends object>(payload: T): Omit<T, 'fk'> {
  const rest = { ...payload } as T & { fk?: unknown };
  delete rest.fk;
  return rest;
}

function bodyOf(m: Ids, payload: object): string {
  return frankingBody({ conversationId: m.conversation_id, messageId: m.id, senderId: m.sender_id, payload: withoutFk(payload) });
}

/**
 * Before sealing: put a fresh franking key into the payload (replacing any earlier one, as an edit must) and
 * compute the commitment that is stored next to the ciphertext.
 */
export function frankPayload<T extends object>(m: Ids, payload: T): { payload: Omit<T, 'fk'> & { fk: string }; commit: string } {
  const fk = newFrankingKey();
  try {
    const commit = frankCommit(fk, bodyOf(m, payload));
    return { payload: { ...withoutFk(payload), fk: b64u.encode(fk) }, commit };
  } finally {
    fk.fill(0);
  }
}

/**
 * After opening: 'ok' when the commitment matches what was decrypted, 'none' for a message that carries no
 * commitment (server notices, older apps, messages from before franking), 'bad' when it doesn't match:
 * the sender's app or the server tampered with it, and the message must not be shown as genuine.
 */
export type FrankState = 'ok' | 'none' | 'bad';

export function checkFrank(row: Ids & Pick<MessageRow, 'frank_commit'>, payload: object): FrankState {
  if (!row.frank_commit) return 'none';
  const fk = (payload as { fk?: unknown }).fk;
  if (typeof fk !== 'string') return 'bad';
  try {
    return frankMatches(fk, bodyOf(row, payload), row.frank_commit) ? 'ok' : 'bad';
  } catch {
    return 'bad';
  }
}

/** What a report includes so Kithwall can verify who sent the message (the server checks every field). */
export interface FrankEvidence {
  fk: string;
  /** The exact committed text: canonical JSON of the chat, message id, sender and payload. */
  body: string;
  commit: string;
  tag: string | null;
  conv: string;
  sender: string;
  /** The server time the tag binds: when this version was sent (or edited). */
  at: string;
}

/** Evidence for a message whose commitment checked out on this device; null when it has none. */
export function frankEvidence(row: MessageRow, payload: object): FrankEvidence | null {
  if (checkFrank(row, payload) !== 'ok') return null;
  return {
    fk: (payload as { fk: string }).fk,
    body: bodyOf(row, payload),
    commit: row.frank_commit as string,
    tag: row.frank_tag ?? null,
    conv: row.conversation_id,
    sender: row.sender_id,
    at: row.edited_at ?? row.created_at,
  };
}
