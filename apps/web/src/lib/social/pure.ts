// Pure helpers for lib/social/engage (no network, no session): unit-tested in pure.test.ts.

export interface PollVote { voter: string; choices: number[] }

export function tally(votes: PollVote[], options: number): { counts: number[]; voters: number } {
  const counts = Array.from({ length: options }, () => 0);
  for (const v of votes) for (const c of v.choices) counts[c]!++;
  return { counts, voters: votes.length };
}


const MENTION = /(^|[^\p{L}\p{N}_@.])@([a-z0-9][a-z0-9._-]{1,29})/giu;

/** @handles written in a text (lower-case, without '@', at most 20). */
export function handlesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION)) { out.add(m[2]!.toLowerCase().replace(/[._-]+$/, '')); if (out.size >= 20) break; }
  return [...out];
}

