// Run: npx vitest run src/lib/follow
import { describe, expect, it } from 'vitest';
import { rankSuggestions, type FollowEdge } from './suggest';

const edge = (followee: string, follower: string): FollowEdge => ({ followee_id: followee, username: `user-${followee}`, display_name: followee.toUpperCase(), follower_id: follower });

describe('rankSuggestions', () => {
  const edges = [edge('news', 'ali'), edge('art', 'ali'), edge('news', 'bea'), edge('news', 'cy'), edge('art', 'bea'), edge('zoo', 'cy')];

  it('orders by how many of my connections follow an account, then by handle', () => {
    const out = rankSuggestions(edges, { me: 'me', known: [] });
    expect(out.map((s) => [s.id, s.via.length])).toEqual([['news', 3], ['art', 2], ['zoo', 1]]);
    expect(out[0]).toMatchObject({ username: 'user-news', name: 'NEWS', via: ['ali', 'bea', 'cy'] });
  });

  it('leaves out me, the accounts I already follow or know, and the ones I dismissed', () => {
    const out = rankSuggestions([...edges, edge('me', 'ali')], { me: 'me', known: ['news'], hidden: ['zoo'] });
    expect(out.map((s) => s.id)).toEqual(['art']);
  });

  it('counts each connection once and ignores malformed rows', () => {
    const out = rankSuggestions([edge('art', 'ali'), edge('art', 'ali'), { followee_id: '', username: '', display_name: null, follower_id: 'x' }], { me: 'me', known: [] });
    expect(out).toHaveLength(1);
    expect(out[0]!.via).toEqual(['ali']);
  });

  it('respects the limit', () => {
    expect(rankSuggestions(edges, { me: 'me', known: [], limit: 2 }).map((s) => s.id)).toEqual(['news', 'art']);
    expect(rankSuggestions(edges, { me: 'me', known: [], limit: 0 })).toEqual([]);
  });
});
