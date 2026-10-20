// Run: npx vitest run src/components/stories
import { describe, expect, it } from 'vitest';
import { buildRings, hoursLeft, startIndex, step } from './logic';

const now = Date.UTC(2026, 9, 20, 12);
const s = (id: string, author: string, minsAgo: number, expired = false) => ({
  id, author_id: author,
  created_at: new Date(now - minsAgo * 60_000).toISOString(),
  expires_at: new Date(expired ? now - 1000 : now + 3_600_000).toISOString(),
});

describe('buildRings', () => {
  it('puts me first, then unseen, then seen (newest first)', () => {
    const rows = [s('a1', 'ann', 50), s('b1', 'bob', 40), s('m1', 'me', 30), s('c1', 'cat', 20), s('a2', 'ann', 10)];
    const rings = buildRings(rows, 'me', new Set(['c1']), now);
    expect(rings.map((r) => r.authorId)).toEqual(['me', 'ann', 'bob', 'cat']);
    expect(rings[1]!.stories.map((x) => x.id)).toEqual(['a1', 'a2']);
    expect(rings[1]!.unseen).toBe(2);
    expect(rings[3]!.unseen).toBe(0);
    expect(rings[0]!.unseen).toBe(0);
  });
  it('drops expired stories', () => {
    expect(buildRings([s('x', 'ann', 5, true)], 'me', new Set(), now)).toEqual([]);
  });
});

describe('startIndex and step', () => {
  // bob's ring is newer, so it comes first: [bob, ann]
  const rings = buildRings([s('a1', 'ann', 50), s('a2', 'ann', 40), s('b1', 'bob', 30)], 'me', new Set(['a1']), now);
  const ann = rings.findIndex((r) => r.authorId === 'ann');
  it('starts at the first unseen story', () => {
    expect(ann).toBe(1);
    expect(startIndex(rings[ann]!, new Set(['a1']))).toBe(1);
    expect(startIndex(rings[ann]!, new Set(['a1', 'a2']))).toBe(0);
  });
  it('moves within and across rings and closes at the end', () => {
    expect(step(rings, { ring: 0, story: 0 }, 1)).toEqual({ ring: 1, story: 0 });
    expect(step(rings, { ring: 1, story: 0 }, 1)).toEqual({ ring: 1, story: 1 });
    expect(step(rings, { ring: 1, story: 0 }, -1)).toEqual({ ring: 0, story: 0 });
    expect(step(rings, { ring: 1, story: 1 }, 1)).toBe('close');
    expect(step(rings, { ring: 0, story: 0 }, -1)).toEqual({ ring: 0, story: 0 });
  });
});

describe('hoursLeft', () => {
  it('rounds up and never goes negative', () => {
    expect(hoursLeft(new Date(now + 90 * 60_000).toISOString(), now)).toBe(2);
    expect(hoursLeft(new Date(now - 1).toISOString(), now)).toBe(0);
  });
});
