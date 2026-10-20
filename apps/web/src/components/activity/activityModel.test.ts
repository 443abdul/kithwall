import { describe, expect, it } from 'vitest';
import { ACTIVITY_TYPES, activityHref, activityIcon, groupActivity, type ActivityRow } from './activityModel';

const P = '11111111-1111-4111-8111-111111111111';
const row = (id: string, actor: string, type: string, at: string, extra: Partial<ActivityRow> = {}): ActivityRow =>
  ({ id, actor_id: actor, type, object_kind: 'post', object_id: P, created_at: at, read_at: null, ...extra });

describe('groupActivity', () => {
  it('groups by day, then by type + object, with distinct actors newest first', () => {
    const days = groupActivity([
      row('1', 'dan', 'like', new Date(2026, 9, 20, 9).toISOString()),
      row('2', 'sara', 'like', new Date(2026, 9, 20, 10).toISOString(), { read_at: 'x' }),
      row('3', 'dan', 'like', new Date(2026, 9, 20, 11).toISOString()),
      row('4', 'ali', 'comment', new Date(2026, 9, 20, 12).toISOString()),
      row('5', 'ali', 'friend_request', new Date(2026, 9, 19, 8).toISOString(), { object_kind: 'profile', object_id: null }),
      row('6', 'bo', 'friend_request', new Date(2026, 9, 19, 9).toISOString(), { object_kind: 'profile', object_id: null }),
      row('7', 'eve', 'like', new Date(2026, 9, 19, 9).toISOString()),
    ]);
    expect(days).toHaveLength(2);
    const [today, yesterday] = days;
    expect(today!.groups.map((g) => [g.type, g.actors])).toEqual([['comment', ['ali']], ['like', ['dan', 'sara']]]);
    expect(today!.groups[1]!.ids).toEqual(['3', '2', '1']);
    expect(today!.groups[1]!.unread).toBe(true);
    expect(yesterday!.groups.map((g) => g.type)).toEqual(['friend_request', 'like', 'friend_request']);
  });
});

describe('activityHref', () => {
  it('points at Kithwall 2 routes', () => {
    expect(activityHref({ type: 'x', objectKind: 'conversation', objectId: P })).toBe(`/messages/${P}`);
    expect(activityHref({ type: 'group_invite', objectKind: 'group', objectId: P })).toBe(`/circles/${P}`);
    expect(activityHref({ type: 'like', objectKind: 'post', objectId: P })).toBe(`/post/${P}`);
    expect(activityHref({ type: 'comment', objectKind: 'post', objectId: 'nope' })).toBe('/home');
    expect(activityHref({ type: 'friend_request', objectKind: 'profile', objectId: P })).toBe('/activity?tab=requests');
    expect(activityHref({ type: 'recovery_request', objectKind: 'recovery_request', objectId: P })).toBe('/you/settings/security#trusted');
    expect(activityHref({ type: 'friend_accept', objectKind: 'profile', objectId: P })).toBeNull();
    expect(activityHref({ type: 'friend_accept', objectKind: 'profile', objectId: P }, 'dan')).toBe('/u/dan');
    expect(activityHref({ type: 'event_invite', objectKind: 'event', objectId: P })).toBe(`/events/${P}`);
    expect(activityHref({ type: 'x', objectKind: 'group', objectId: 'not-a-uuid' })).toBe('/circles');
  });
});

describe('scheduled posts (phase 3)', () => {
  it('knows "your scheduled post is now shared" and leads to the post', () => {
    expect(ACTIVITY_TYPES).toContain('post_published');
    expect(activityIcon('post_published')).toBe('clock');
    expect(activityHref({ type: 'post_published', objectKind: 'post', objectId: P })).toBe(`/post/${P}`);
  });
});
