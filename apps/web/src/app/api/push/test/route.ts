// POST /api/push/test  {endpoint?, nativeToken?}  (Authorization: Bearer <user JWT>)
// "Send a test notification" from Settings → Account. Sends to the caller's own devices only — to
// the given browser endpoint or native app token when it is one of theirs, otherwise to all of them
// (browsers and app installs). Rate-limited in the database.
import { admin, asUser, callerFromRequest, json, needsMfa, readJson } from '@/lib/auth/server';
import { nativePushConfigured, sendNative, type NativeDevice } from '@/lib/push/native-server';
import { isPushEndpoint, pushConfigured, sendAll, TTL_SECONDS, type StoredSub } from '../_lib/push-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return json({ error: 'Please log in again.' }, 401);
  if (needsMfa(caller)) return json({ error: 'Please finish two-step verification first.' }, 403);
  const native = nativePushConfigured();
  if (!pushConfigured() && !native.fcm && !native.apns) return json({ error: 'Push notifications aren’t set up on this server yet.' }, 503);
  const body = await readJson<{ endpoint?: unknown; nativeToken?: unknown }>(req, 4096);
  const nativeToken = typeof body?.nativeToken === 'string' && body.nativeToken.length <= 1024 ? body.nativeToken : null;

  const rl = await asUser(caller.jwt).rpc('push_test_allowed');
  if (rl.error) {
    return rl.error.code === 'P0429'
      ? json({ error: 'You’ve sent a lot of test notifications. Try again in an hour.' }, 429)
      : json({ error: 'Not allowed.' }, 403);
  }

  const db = admin();
  let subs: StoredSub[] = [];
  let devs: NativeDevice[] = [];
  if (!nativeToken) {
    let q = db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', caller.user.id);
    if (isPushEndpoint(body?.endpoint)) q = q.eq('endpoint', body.endpoint);
    const { data, error } = await q;
    if (error) return json({ error: 'Lookup failed.' }, 500);
    subs = (data ?? []) as StoredSub[];
  }
  if (nativeToken || !isPushEndpoint(body?.endpoint)) {
    let q = db.from('native_push_devices').select('id, provider, token, p256dh, auth, apns_env').eq('user_id', caller.user.id);
    if (nativeToken) q = q.eq('token', nativeToken);
    const { data, error } = await q;
    if (error) return json({ error: 'Lookup failed.' }, 500);
    devs = (data ?? []) as NativeDevice[];
  }
  if (!subs.length && !devs.length) return json({ error: 'Push notifications aren’t turned on for this device.' }, 404);

  const payload = { v: 1 as const, title: 'Kithwall', kind: 'test' as const, body: 'Push notifications are working on this device.', tag: 'kw-test', url: '/you/settings/notifications#push' };
  const [r, n] = await Promise.all([
    pushConfigured() ? sendAll(subs.map((sub) => ({ sub, urgency: 'high' as const, payload }))) : { sent: 0, removed: 0, failed: 0 },
    sendNative(devs.map((dev) => ({ dev, payload, urgency: 'high' as const, ttl: TTL_SECONDS, kind: 'test' }))),
  ]);
  return json({ ok: true, sent: r.sent + n.sent, removed: r.removed + n.removed, failed: r.failed + n.failed });
}
