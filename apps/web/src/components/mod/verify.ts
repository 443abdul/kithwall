'use client';
// Report verification (spec §5 "Report"): the reporter's device disclosed the decrypted item and its
// key. Moderators check that key opens the ciphertext the SERVER snapshotted when the report was
// filed (stored_envelope + stored_meta), and that the author's signature verifies. So a reporter
// can't fabricate content, and a moderator sees exactly what was stored.
// Chat messages may instead carry franking evidence that the DATABASE verified when the report was filed
// (reports.frank, migration 20261102000600): then the committed body is the verified content, and it stays
// verifiable after the message was edited, unsent or has disappeared.
import { b64u, canonicalJson, openEnvelope, openWithContentKey, type Envelope } from '@kithwall/crypto';
import { commentHeader, postHeader } from '@/lib/content';
import { photoHeader } from '@/lib/photos';
import { messageHeader } from '@/lib/messages';
import { people } from '@/lib/people';
import type { PostRow } from '@/lib/types';

/** The server's verdict on a reported message's franking evidence (null for other kinds and older reports). */
export interface FrankVerdict {
  state: 'verified' | 'failed' | 'none' | 'not_included';
  sender?: string; conv?: string; at?: string; why?: string;
}

export interface ReportRow {
  id: string; reporter_id: string; target_kind: string; target_id: string; target_owner_id: string | null;
  reason: string; details: string | null; status: 'open' | 'actioned' | 'dismissed';
  disclosed: { plaintext?: unknown; key?: string | null; keyKind?: 'content' | 'comment' | 'audience' | null; frank?: { body?: unknown } } | null;
  frank: FrankVerdict | null;
  stored_envelope: Envelope | null; stored_meta: Record<string, unknown> | null;
  moderator_id: string | null; decision_note: string | null; created_at: string; resolved_at: string | null;
}

export type Verification =
  | { state: 'verified'; content: unknown; matches: boolean }
  /** The database checked the message's franking commitment and its binding to the sender, chat and time. */
  | { state: 'franked'; content: unknown; sender: string; at: string }
  | { state: 'unverifiable'; why: string };

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A payload without its franking key (the key is evidence, not content). */
function withoutFk(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const rest = { ...(v as Record<string, unknown>) };
  delete rest.fk;
  return rest;
}

/** What the reporter's device sent as the content: the plaintext, or the payload inside the franking body. */
export function reporterCopy(r: ReportRow): unknown {
  if (r.disclosed?.plaintext != null) return withoutFk(r.disclosed.plaintext);
  const body = r.disclosed?.frank?.body;
  if (typeof body !== 'string') return null;
  try { return (JSON.parse(body) as { payload?: unknown }).payload ?? null; } catch { return null; }
}

/** The verified message of a franked report, if the server verified it and the body is canonical. */
function frankedContent(r: ReportRow): Verification | null {
  if (r.target_kind !== 'message' || r.frank?.state !== 'verified') return null;
  const body = r.disclosed?.frank?.body;
  if (typeof body !== 'string') return null;
  try {
    const parsed = JSON.parse(body) as { payload?: unknown };
    // Recipients only produce canonical bodies; anything else is not what their app checked.
    if (canonicalJson(parsed) !== body) return null;
    return { state: 'franked', content: parsed.payload, sender: str(r.frank.sender), at: str(r.frank.at) };
  } catch {
    return null;
  }
}

export async function verifyReport(r: ReportRow): Promise<Verification> {
  const franked = frankedContent(r);
  if (franked) return franked;
  if (r.target_kind === 'profile' || r.target_kind === 'group' || r.target_kind === 'event') {
    return { state: 'unverifiable', why: 'Reports about a profile, circle or event carry no encrypted item; judge them from the account\'s behaviour and other reports.' };
  }
  const env = r.stored_envelope;
  const meta = r.stored_meta;
  if (!env || !meta) return { state: 'unverifiable', why: 'The item was already gone when it was reported, so there is nothing stored to check against.' };
  const authorId = str(meta.author_id) || str(meta.owner_id) || str(meta.sender_id);
  await people.ensure([authorId]);
  const author = people.get(authorId);
  if (!author) return { state: 'unverifiable', why: 'The author\'s account no longer exists, so their signature can\'t be checked.' };
  const signPub = b64u.decode(author.sign_pub);
  const keyB64 = r.disclosed?.key ?? null;
  let key: Uint8Array | null = null;
  try { key = keyB64 ? b64u.decode(keyB64) : null; } catch { return { state: 'unverifiable', why: 'The disclosed key is malformed.' }; }

  let opened: unknown;
  try {
    if (r.target_kind === 'post') {
      const header = postHeader(meta as unknown as PostRow);
      if (meta.is_public) opened = openEnvelope({ header, envelope: env, signPub });
      else if (key) opened = openWithContentKey({ header, envelope: env, contentKey: key, signPub });
      else return { state: 'unverifiable', why: 'The reporter\'s device didn\'t include the key.' };
    } else if (r.target_kind === 'comment') {
      const header = commentHeader({ id: str(meta.id), author_id: authorId, post_id: str(meta.post_id) || null, photo_id: str(meta.photo_id) || null });
      opened = key ? openWithContentKey({ header, envelope: env, contentKey: key, signPub }) : openEnvelope({ header: { ...header, audience: 'public' }, envelope: env, signPub });
    } else if (r.target_kind === 'photo') {
      const header = photoHeader({ id: str(meta.id), album_id: str(meta.album_id), owner_id: authorId, is_public: !!meta.is_public, audience_id: str(meta.audience_id) || null, epoch: (meta.epoch as number | null) ?? null });
      if (meta.is_public) opened = openEnvelope({ header, envelope: env, signPub });
      else if (key) opened = openWithContentKey({ header, envelope: env, contentKey: key, signPub });
      else return { state: 'unverifiable', why: 'The reporter\'s device didn\'t include the key.' };
    } else if (r.target_kind === 'message') {
      if (!key) return { state: 'unverifiable', why: 'The reporter\'s device didn\'t include the key.' };
      const header = messageHeader({ id: str(meta.id), conversation_id: str(meta.conversation_id), sender_id: authorId, epoch: Number(meta.epoch) }, str(meta.audience_id));
      opened = r.disclosed?.keyKind === 'content'
        ? openWithContentKey({ header, envelope: env, contentKey: key, signPub })
        : openEnvelope({ header, envelope: env, audienceKey: key, signPub });
    } else {
      return { state: 'unverifiable', why: 'Unknown item type.' };
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { state: 'unverifiable', why: code === 'bad_signature'
      ? 'The stored item\'s signature doesn\'t match its author. Treat this report with caution.'
      : 'The disclosed key does not open the stored item. The report may have been tampered with.' };
  }
  let matches = false;
  try { matches = canonicalJson(withoutFk(opened)) === canonicalJson(reporterCopy(r)); } catch { matches = false; }
  return { state: 'verified', content: withoutFk(opened), matches };
}

/** Readable text out of a decrypted payload (posts, comments, messages, photos). */
export function payloadText(p: unknown): string {
  if (!p || typeof p !== 'object') return String(p ?? '');
  const o = p as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.text === 'string') parts.push(o.text);
  if (typeof o.caption === 'string') parts.push(o.caption);
  if (o.note && typeof o.note === 'object') { const n = o.note as { title?: string; body?: string }; parts.push([n.title, n.body].filter(Boolean).join('\n')); }
  if (o.link && typeof o.link === 'object') parts.push(String((o.link as { url?: string }).url ?? ''));
  if (typeof o.subject === 'string') parts.unshift(o.subject);
  return parts.filter(Boolean).join('\n\n');
}
