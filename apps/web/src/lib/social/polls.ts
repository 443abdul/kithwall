'use client';
// Questions (polls): each vote is an envelope encrypted with a key derived from the question's
// content key — deriveSubkey(contentKey, 'vote', voterId) — so only people who can read the
// question can read (and tally) the votes. Votes are signed by the voter. When the question
// allows it, a vote may name a new option; readers add it to the list when tallying.
import {
  b64u, deriveSubkey, openEnvelope, openWithContentKey, sealEnvelope, sealWithContentKey, type Envelope, type EnvelopeHeader,
} from '@kithwall/crypto';
import { sb, must } from '../supabase';
import { identity, me } from '../keys/session';
import { people } from '../people';

export interface VotePayload { choice: string }
interface VoteRow { post_id: string; voter_id: string; envelope: Envelope; created_at: string }

const MAX_CHOICE = 80;

const voteHeader = (postId: string, voterId: string, isPublic: boolean): EnvelopeHeader =>
  ({ v: 1, type: 'poll_vote', id: postId, author: voterId, wall: postId, audience: isPublic ? 'public' : 'self' });

export async function castVote(postId: string, contentKey: Uint8Array | null, choice: string) {
  const c = choice.trim().slice(0, MAX_CHOICE);
  if (!c) throw new Error('Please choose an option.');
  const payload: VotePayload = { choice: c };
  const header = voteHeader(postId, me(), !contentKey);
  const envelope = contentKey
    ? sealWithContentKey({ header, payload, contentKey: deriveSubkey(contentKey, 'vote', me()), signPriv: identity().signPriv })
    : sealEnvelope({ header, payload, signPriv: identity().signPriv });
  must(await sb().from('poll_votes').upsert({ post_id: postId, voter_id: me(), envelope }));
}

export async function removeVote(postId: string) {
  must(await sb().from('poll_votes').delete().match({ post_id: postId, voter_id: me() }));
}

export interface DecryptedVote { voter: string; choice: string }

export async function fetchVotes(postId: string, contentKey: Uint8Array | null): Promise<DecryptedVote[]> {
  const rows = must(await sb().from('poll_votes').select('*').eq('post_id', postId)) as VoteRow[];
  await people.ensure(rows.map((r) => r.voter_id));
  const out: DecryptedVote[] = [];
  for (const r of rows) {
    const voter = people.get(r.voter_id);
    if (!voter) continue;
    try {
      const signPub = b64u.decode(voter.sign_pub);
      const header = voteHeader(postId, r.voter_id, !contentKey);
      const v = contentKey
        ? openWithContentKey<VotePayload>({ header, envelope: r.envelope, contentKey: deriveSubkey(contentKey, 'vote', r.voter_id), signPub })
        : openEnvelope<VotePayload>({ header, envelope: r.envelope, signPub });
      if (typeof v.choice === 'string' && v.choice.trim()) out.push({ voter: r.voter_id, choice: v.choice.trim().slice(0, MAX_CHOICE) });
    } catch { /* unverifiable votes are ignored */ }
  }
  return out;
}

/** Options = the asker's options plus (if allowed) new options named in votes; with counts. */
export function tally(options: string[], allowAdd: boolean, votes: DecryptedVote[]) {
  const norm = (s: string) => s.trim().toLowerCase();
  const list = options.map((t) => ({ text: t, voters: [] as string[] }));
  for (const v of votes) {
    let o = list.find((x) => norm(x.text) === norm(v.choice));
    if (!o) {
      if (!allowAdd) continue;
      o = { text: v.choice, voters: [] };
      list.push(o);
    }
    o.voters.push(v.voter);
  }
  return list;
}
