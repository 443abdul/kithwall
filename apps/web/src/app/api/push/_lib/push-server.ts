import 'server-only';
// Web Push sending (spec §12 "Push notifications"). Payloads are "who + what" only — the server has no
// message or post content — and are encrypted for the browser (RFC 8291) by `web-push`, so the
// browser vendor's push service (FCM, APNs, Mozilla autopush, WNS) can't read them either.
// Never log payloads or endpoints: an endpoint is a capability URL for someone's device.
import { createHash, timingSafeEqual } from 'node:crypto';
import webpush, { WebPushError, type PushSubscription } from 'web-push';
import { admin } from '@/lib/auth/server';

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:security@kithwall.com';
const DISPATCH_SECRET = process.env.PUSH_DISPATCH_SECRET ?? '';

export const TTL_SECONDS = 24 * 60 * 60;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Same allow-list as the database CHECK constraint on push_subscriptions.endpoint (defence in depth). */
const PUSH_HOST_RE = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com)\//;
export const isPushEndpoint = (u: unknown): u is string => typeof u === 'string' && u.length <= 1024 && PUSH_HOST_RE.test(u);
export const isP256dh = (k: unknown): k is string => typeof k === 'string' && /^[A-Za-z0-9_-]{86,88}={0,2}$/.test(k);
export const isAuthSecret = (k: unknown): k is string => typeof k === 'string' && /^[A-Za-z0-9_-]{21,24}={0,2}$/.test(k);

export function pushConfigured(): boolean { return !!(PUBLIC_KEY && PRIVATE_KEY); }

/** Constant-time check of the x-kw-push-secret header (hash both sides so lengths always match). */
export function dispatchSecretOk(given: string | null): boolean {
  if (!DISPATCH_SECRET || DISPATCH_SECRET.length < 32 || !given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(DISPATCH_SECRET).digest();
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------------------
// Text. "who + what" in the owner's words: "dan sent you a message", "jessica commented on your post".
// Kept in step with NOTIF text in lib/notifications.ts (that file is client-only).
const WHAT: Record<string, string> = {
  friend_request: 'sent you a friend request', friend_accept: 'accepted your friend request',
  wall_post: 'wrote on your Wall', comment: 'commented on your post', like: 'likes your post',
  tag: 'tagged you in a photo', poke: 'poked you', group_invite: 'added you to a group',
  group_request: 'asked to join your group', event_invite: 'invited you to an event', mention: 'mentioned you in a comment',
  share: 'shared your post', question_vote: 'answered your question', checkin_tag: 'checked in with you',
  relationship: 'listed you in a relationship', recovery_request: 'is asking for your help to recover their account',
  recovery_trustee: 'chose you as a trusted friend for account recovery', game: 'sent you a Kithville request',
  key_waiting: 'is waiting for your device to share your posts with them',
  post_published: '',   // own words below: "Your scheduled post is now shared"
};

/** Preference switch that controls each kind of push (push_preferences columns). */
export type PushCategory = 'messages' | 'activity' | 'friend_requests' | 'pokes' | 'invites' | 'security';
const CATEGORY: Record<string, PushCategory> = {
  friend_request: 'friend_requests', friend_accept: 'friend_requests',
  wall_post: 'activity', comment: 'activity', like: 'activity', tag: 'activity', mention: 'activity', share: 'activity',
  question_vote: 'activity', checkin_tag: 'activity', relationship: 'activity',
  poke: 'pokes',
  group_invite: 'invites', group_request: 'invites', event_invite: 'invites', game: 'invites',
  recovery_request: 'security', recovery_trustee: 'security', key_waiting: 'security',
  post_published: 'activity',
};

export interface Plan {
  kind: 'notification' | 'message';
  type: string | null;
  object_kind: string | null;
  object_id: string | null;
  conversation_id: string | null;
  group: boolean;
  created_at: string;
  actor: { username: string | null; display: string | null };
  targets: { user_id: string; badge: number; prefs: Partial<Record<PushCategory, boolean>> | null; subs: StoredSub[] | null }[];
}
export interface StoredSub { id: string; endpoint: string; p256dh: string; auth: string }

export interface PushPayload {
  v: 1;
  title: string;
  body: string;
  tag: string;
  url: string;
  kind: 'message' | 'notification' | 'test' | 'call';
  conversation?: string;
  badge?: number;
}

/** Where a notification push opens (Kithwall 2 routes; mirrors components/activity/activityModel.ts). */
export function notifUrl(p: Pick<Plan, 'type' | 'object_kind' | 'object_id'>): string {
  const id = p.object_id && UUID_RE.test(p.object_id) ? p.object_id : null;
  if (id) {
    switch (p.object_kind) {
      case 'conversation': return `/messages/${id}`;
      case 'group': return `/circles/${id}`;
      case 'event': return `/events/${id}`;
      case 'post': case 'comment': return `/post/${id}`;
    }
  }
  if (p.object_kind === 'recovery_request' || p.type === 'recovery_request' || p.type === 'recovery_trustee') return '/you/settings/security#trusted';
  if (p.object_kind === 'photo') return '/albums';
  if (p.type === 'friend_request') return '/activity?tab=requests';
  return '/activity';
}

/** Build the push for a plan, or null when there's nothing to say. */
export function describe(p: Plan): { category: PushCategory; payload: Omit<PushPayload, 'badge'>; urgency: 'high' | 'normal' } | null {
  const who = (p.actor.display?.trim() || p.actor.username || 'Someone').slice(0, 80);
  if (p.kind === 'message') {
    if (!p.conversation_id) return null;
    return {
      category: 'messages', urgency: 'high',
      payload: {
        v: 1, title: 'Kithwall', kind: 'message', conversation: p.conversation_id,
        body: p.group ? `${who} sent a message to a group conversation` : `${who} sent you a message`,
        tag: `conv:${p.conversation_id}`, url: `/messages/${p.conversation_id}`,
      },
    };
  }
  if (p.type === 'post_published') {
    // Sent to the author by the scheduler (migration 20261024000100) when a scheduled post goes out.
    return {
      category: 'activity', urgency: 'normal',
      payload: { v: 1, title: 'Kithwall', kind: 'notification', body: 'Your scheduled post is now shared', tag: `n:post_published:${p.object_id ?? ''}`, url: notifUrl(p) },
    };
  }
  const what = p.type ? WHAT[p.type] : undefined;
  const category = p.type ? CATEGORY[p.type] : undefined;
  if (!what || !category) return null;
  return {
    category, urgency: category === 'security' ? 'high' : 'normal',
    payload: {
      v: 1, title: 'Kithwall', kind: 'notification', body: `${who} ${what}`,
      tag: `n:${p.type}:${p.object_id ?? who}`, url: notifUrl(p),
    },
  };
}

/** A ringing call is only worth a push while it can still be answered. */
export const CALL_TTL_SECONDS = 45;

/**
 * Phase 4 calls: "Dan is calling" (who + what only; voice or video is not said). Opens the chat with
 * ?call=<id>, which asks the caller's device whether it is still ringing (docs/v2/04-calls.md §6).
 */
export function describeCall(p: Plan, callId: string): { category: PushCategory; payload: Omit<PushPayload, 'badge'>; urgency: 'high' } | null {
  if (!p.conversation_id || !UUID_RE.test(callId)) return null;
  const who = (p.actor.display?.trim() || p.actor.username || 'Someone').slice(0, 80);
  return {
    category: 'messages', urgency: 'high',
    payload: {
      v: 1, title: 'Kithwall', kind: 'call', conversation: p.conversation_id,
      body: p.group ? `${who} is calling a group conversation` : `${who} is calling`,
      tag: `call:${p.conversation_id}`, url: `/messages/${p.conversation_id}?call=${callId}`,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Sending.
export interface SendResult { sent: number; removed: number; failed: number }

/**
 * Send one payload per subscription, in parallel. Subscriptions the push service reports as gone
 * (404/410) are deleted; successful ones get last_success_at. Errors are logged by status only.
 */
export async function sendAll(jobs: { sub: StoredSub; payload: PushPayload; urgency: 'high' | 'normal'; ttl?: number }[]): Promise<SendResult> {
  if (!jobs.length) return { sent: 0, removed: 0, failed: 0 };
  const ok: string[] = [];
  const gone: string[] = [];
  let failed = 0;
  await Promise.all(jobs.map(async ({ sub, payload, urgency, ttl }) => {
    if (!isPushEndpoint(sub.endpoint)) { gone.push(sub.id); return; }
    const target: PushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(target, JSON.stringify(payload), {
        TTL: ttl ?? TTL_SECONDS, urgency, timeout: 8000,
        vapidDetails: { subject: SUBJECT, publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY },
      });
      ok.push(sub.id);
    } catch (e) {
      const status = e instanceof WebPushError ? e.statusCode : 0;
      if (status === 404 || status === 410) gone.push(sub.id);
      else { failed++; console.warn(`push send failed (status ${status || 'network'})`); }
    }
  }));
  const db = admin();
  await Promise.all([
    gone.length ? db.from('push_subscriptions').delete().in('id', gone) : null,
    ok.length ? db.from('push_subscriptions').update({ last_success_at: new Date().toISOString() }).in('id', ok) : null,
  ]);
  return { sent: ok.length, removed: gone.length, failed };
}
