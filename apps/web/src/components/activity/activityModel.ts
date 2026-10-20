// Pure helpers for Activity (Kithwall 2): group notifications by day, then by what they are about
// ("Dan and 3 others reacted to your post"), and decide where each group leads. Tested in activityModel.test.ts.
import { dayKey } from '../messages/chatModel';

export interface ActivityRow {
  id: string; actor_id: string; type: string; object_kind: string | null; object_id: string | null;
  created_at: string; read_at: string | null;
}

export interface ActivityGroup {
  key: string;
  type: string;
  objectKind: string | null;
  objectId: string | null;
  /** Distinct actors, most recent first. */
  actors: string[];
  ids: string[];
  latest: string;
  unread: boolean;
  /** Newest notification of the group (for its sealed preview). */
  head: ActivityRow;
}

export interface ActivityDay { day: string; at: string; groups: ActivityGroup[] }

/** Types where several people doing the same thing to the same object collapse into one line. */
const COLLAPSIBLE = new Set(['like', 'comment', 'share', 'mention', 'tag', 'question_vote', 'wall_post', 'reaction', 'story_reaction']);

export function groupActivity(rows: ActivityRow[]): ActivityDay[] {
  const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const days: ActivityDay[] = [];
  const byKey = new Map<string, ActivityGroup>();
  for (const r of sorted) {
    const day = dayKey(r.created_at);
    let d = days[days.length - 1];
    if (!d || d.day !== day) { d = { day, at: r.created_at, groups: [] }; days.push(d); }
    const key = COLLAPSIBLE.has(r.type) && r.object_id ? `${day}|${r.type}|${r.object_kind ?? ''}|${r.object_id}` : `${day}|${r.id}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, type: r.type, objectKind: r.object_kind, objectId: r.object_id, actors: [], ids: [], latest: r.created_at, unread: false, head: r };
      byKey.set(key, g);
      d.groups.push(g);
    }
    g.ids.push(r.id);
    if (!g.actors.includes(r.actor_id)) g.actors.push(r.actor_id);
    if (!r.read_at) g.unread = true;
  }
  return days;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a group leads in Kithwall 2. `circleOfPost` maps post ids to their circle (posts in a circle
 * open the circle; there is no post permalink yet). null = nowhere to go (the line is just text).
 */
export function activityHref(g: Pick<ActivityGroup, 'type' | 'objectKind' | 'objectId'>, circleOfPost: Map<string, string | null> = new Map(), actorHandle?: string | null): string | null {
  const id = g.objectId && UUID.test(g.objectId) ? g.objectId : null;
  switch (g.objectKind) {
    case 'conversation': return id ? `/messages/${id}` : '/messages';
    case 'group': return id ? `/circles/${id}` : '/circles';
    case 'event': return id ? `/circles/events/${id}` : '/circles/events';
    case 'photo': return '/albums';
    case 'recovery_request': return '/you/settings/security#trusted';
    case 'post': case 'comment': {
      const circle = id ? circleOfPost.get(id) : null;
      return circle ? `/circles/${circle}` : '/home';
    }
  }
  switch (g.type) {
    case 'friend_request': return '/activity?tab=requests';
    case 'recovery_request': case 'recovery_trustee': return '/you/settings/security#trusted';
    case 'group_invite': case 'group_request': return '/circles';
    case 'event_invite': return '/circles/events';
    case 'key_waiting': return '/home';
  }
  return actorHandle && /^[a-z0-9.]{1,30}$/.test(actorHandle) ? `/u/${actorHandle}` : null;
}

/** Icon shown on the avatar for each kind of activity. */
export function activityIcon(type: string): 'heart' | 'messages' | 'users' | 'circles' | 'calendar' | 'key' | 'image' | 'share' | 'lock' | 'activity' {
  switch (type) {
    case 'like': case 'reaction': case 'story_reaction': case 'relationship': return 'heart';
    case 'comment': case 'mention': case 'wall_post': return 'messages';
    case 'friend_request': case 'friend_accept': case 'poke': return 'users';
    case 'group_invite': case 'group_request': return 'circles';
    case 'event_invite': return 'calendar';
    case 'recovery_request': case 'recovery_trustee': return 'key';
    case 'tag': return 'image';
    case 'share': return 'share';
    case 'key_waiting': return 'lock';
    default: return 'activity';
  }
}

/** Known activity types (others fall back to a generic line). */
export const ACTIVITY_TYPES = [
  'friend_request', 'friend_accept', 'wall_post', 'comment', 'like', 'tag', 'poke', 'group_invite', 'group_request',
  'event_invite', 'mention', 'share', 'question_vote', 'checkin_tag', 'relationship', 'recovery_request', 'recovery_trustee',
  'game', 'key_waiting',
] as const;
