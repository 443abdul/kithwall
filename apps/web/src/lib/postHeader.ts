// The signed header of a post's envelope (spec §3.8). One definition for the browser (lib/content.ts) and the
// server job that signs the automated accounts' public posts (lib/official/run.ts): both must produce the
// same bytes, or the signature would not verify.
import type { EnvelopeHeader } from '@kithwall/crypto';
import type { PostRow } from './types';

export function postHeader(p: Pick<PostRow, 'id' | 'author_id' | 'wall_owner_id' | 'group_id' | 'event_id' | 'kind' | 'is_public' | 'audience_id' | 'epoch'>): EnvelopeHeader {
  const wall = p.wall_owner_id ?? p.group_id ?? p.event_id ?? undefined;
  return {
    v: 1, type: `post:${p.kind}`, id: p.id, author: p.author_id, ...(wall ? { wall } : {}),
    audience: p.is_public ? 'public' : { id: p.audience_id!, epoch: p.epoch! },
  };
}
