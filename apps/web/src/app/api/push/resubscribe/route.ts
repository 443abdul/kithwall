// POST /api/push/resubscribe  {old: {endpoint, auth}, sub: {endpoint, keys: {p256dh, auth}}}
// Called by the service worker on `pushsubscriptionchange` (the browser rotated the subscription).
// A service worker has no user session, so the caller proves it owns the old subscription by
// presenting its endpoint *and* its auth secret — values only that browser and our database know.
// The row keeps its owner; only the endpoint and keys change.
import { admin, json } from '@/lib/auth/server';
import { isAuthSecret, isP256dh, isPushEndpoint } from '../_lib/push-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  old?: { endpoint?: unknown; auth?: unknown };
  sub?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
}

export async function POST(req: Request) {
  const text = await req.text();
  if (text.length > 4096) return json({ error: 'Bad request.' }, 400);
  let b: Body;
  try { b = JSON.parse(text) as Body; } catch { return json({ error: 'Bad request.' }, 400); }
  const oldEndpoint = b.old?.endpoint, oldAuth = b.old?.auth;
  const endpoint = b.sub?.endpoint, p256dh = b.sub?.keys?.p256dh, auth = b.sub?.keys?.auth;
  if (!isPushEndpoint(oldEndpoint) || !isAuthSecret(oldAuth) || !isPushEndpoint(endpoint) || !isP256dh(p256dh) || !isAuthSecret(auth)) {
    return json({ error: 'Bad request.' }, 400);
  }
  const db = admin();
  const { data: row } = await db.from('push_subscriptions').select('id, user_id').eq('endpoint', oldEndpoint).eq('auth', oldAuth).maybeSingle();
  if (!row) return json({ error: 'Not found.' }, 404);
  if (endpoint !== oldEndpoint) await db.from('push_subscriptions').delete().eq('endpoint', endpoint).neq('id', row.id);
  const { error } = await db.from('push_subscriptions').update({ endpoint, p256dh, auth, last_success_at: null }).eq('id', row.id);
  if (error) return json({ error: 'Could not update.' }, 500);
  return json({ ok: true });
}
