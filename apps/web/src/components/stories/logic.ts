// Pure helpers for the stories row and viewer (no React, no network).

export interface StoryLike { id: string; author_id: string; created_at: string; expires_at: string }

export interface Ring<T extends StoryLike> {
  authorId: string;
  stories: T[];           // oldest first (the order they play in)
  unseen: number;
  latest: string;         // created_at of the newest story
}

/**
 * Group live stories by author for the row at the top of Home: my own ring first, then people with
 * unseen stories (most recent first), then people whose stories I've all seen (most recent first).
 */
export function buildRings<T extends StoryLike>(rows: T[], self: string, seen: ReadonlySet<string>, now = Date.now()): Ring<T>[] {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    if (new Date(r.expires_at).getTime() <= now) continue;
    const list = by.get(r.author_id) ?? [];
    list.push(r);
    by.set(r.author_id, list);
  }
  const rings: Ring<T>[] = [...by.entries()].map(([authorId, stories]) => {
    stories.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return {
      authorId, stories,
      unseen: authorId === self ? 0 : stories.filter((s) => !seen.has(s.id)).length,
      latest: stories[stories.length - 1]!.created_at,
    };
  });
  return rings.sort((a, b) => {
    if (a.authorId === self) return -1;
    if (b.authorId === self) return 1;
    if (!!a.unseen !== !!b.unseen) return a.unseen ? -1 : 1;
    return b.latest.localeCompare(a.latest);
  });
}

/** Where to start playing a ring: the first unseen story, else the first one. */
export function startIndex<T extends StoryLike>(ring: Ring<T>, seen: ReadonlySet<string>): number {
  const i = ring.stories.findIndex((s) => !seen.has(s.id));
  return i < 0 ? 0 : i;
}

export type StoryStep = { ring: number; story: number } | 'close';

/** Next/previous position across rings (tap right/left, swipe, or the timer). */
export function step(rings: { stories: unknown[] }[], pos: { ring: number; story: number }, dir: 1 | -1): StoryStep {
  const ring = rings[pos.ring];
  if (!ring) return 'close';
  const s = pos.story + dir;
  if (s >= 0 && s < ring.stories.length) return { ring: pos.ring, story: s };
  const r = pos.ring + dir;
  if (r < 0) return { ring: 0, story: 0 };
  if (r >= rings.length) return 'close';
  return { ring: r, story: dir === 1 ? 0 : rings[r]!.stories.length - 1 };
}

/** Hours left before a story expires, rounded up (for "23 h left"). */
export function hoursLeft(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 3_600_000));
}
