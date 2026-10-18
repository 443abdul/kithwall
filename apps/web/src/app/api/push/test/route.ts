// POST /api/push/test  {endpoint?}  (Authorization: Bearer <user JWT>)
// "Send a test notification" from Settings → Account. Sends to the caller's own devices only — to
// the given endpoint when it is one of theirs, otherwise to all of them. Rate-limited in the database.
import { admin, asUser, callerFromRequest, json, needsMfa, readJson } from '@/lib/auth/server';
import { isPushEndpoint, pushConfigured, sendAll, type StoredSub } from '../_lib/push-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return json({ error: 'Please log in again.' }, 401);
  if (needsMfa(caller)) return json({ error: 'Please finish two-step verification first.' }, 403);
  if (!pushConfigured()) return json({ error: 'Push notifications aren’t set up on this server yet.' }, 503);
  const body = await readJson<{ endpoint?: unknown }>(req, 4096);

  const rl = await asUser(caller.jwt).rpc('push_test_allowed');
  if (rl.error) {
    return rl.error.code === 'P0429'
      ? json({ error: 'You’ve sent a lot of test notifications. Try again in an hour.' }, 429)
      : json({ error: 'Not allowed.' }, 403);
  }

  let q = admin().from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', caller.user.id);
  if (isPushEndpoint(body?.endpoint)) q = q.eq('endpoint', body.endpoint);
  const { data, error } = await q;
  if (error) return json({ error: 'Lookup failed.' }, 500);
  const subs = (data ?? []) as StoredSub[];
  if (!subs.length) return json({ error: 'Push notifications aren’t turned on for this device.' }, 404);

  const r = await sendAll(subs.map((sub) => ({
    sub, urgency: 'high' as const,
    payload: { v: 1 as const, title: 'Kithwall', kind: 'test' as const, body: 'Push notifications are working on this device.', tag: 'kw-test', url: '/settings/account#push' },
  })));
  return json({ ok: true, ...r });
}
