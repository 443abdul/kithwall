'use client';
// Abuse reports (spec §5): the reporter's device discloses the decrypted item and its content key
// to moderators. The server snapshots the stored ciphertext so moderators can verify the report.
import { b64u } from '@kithwall/crypto';
import { sb, must } from './supabase';
import { me } from './keys/session';

export type ReportKind = 'post' | 'comment' | 'photo' | 'message' | 'profile' | 'group' | 'event';
export type ReportReason = 'spam' | 'harassment' | 'hate' | 'violence' | 'nudity' | 'child_safety' | 'self_harm' | 'impersonation' | 'illegal' | 'other';

export interface Disclosure {
  /** Decrypted content the reporter saw (text, file refs etc.). */
  plaintext: unknown;
  /** Content key (or audience key for messages) that decrypts the stored ciphertext. */
  contentKey?: Uint8Array | null;
  /** Which key it is: 'content' (posts/photos), 'comment' (derived comment key), 'audience' (messages). */
  keyKind?: 'content' | 'comment' | 'audience';
}

export async function reportItem(args: { kind: ReportKind; id: string; reason: ReportReason; details?: string; disclosure?: Disclosure }) {
  const d = args.disclosure;
  must(await sb().from('reports').insert({
    reporter_id: me(), target_kind: args.kind, target_id: args.id, reason: args.reason,
    details: args.details?.slice(0, 2000) || null,
    disclosed: d ? { plaintext: d.plaintext, key: d.contentKey ? b64u.encode(d.contentKey) : null, keyKind: d.keyKind ?? null } : null,
  }));
}
