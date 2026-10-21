// POST /api/push/dispatch  {kind: 'notification' | 'message' | 'call', id}
// Called by the database (pg_net, AFTER INSERT triggers in 20261020000100_push.sql) with the
// x-kw-push-secret header. The body carries only a row id; everything else is looked up here with the
// secret key. Sends a "who + what" Web Push to every subscribed device of every recipient.
import { admin, json } from '@/lib/auth/server';
import { CALL_TTL_SECONDS, describe, describeCall, dispatchSecretOk, pushConfigured, sendAll, UUID_RE, type Plan, type PushPayload, type StoredSub } from '../_lib/push-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Rows older than this are not pushed (e.g. a backlog after an outage): stale alerts are noise. */
const MAX_AGE_MS = 60 * 60_000;

export async function POST(req: Request) {
  if (!dispatchSecretOk(req.headers.get('x-kw-push-secret'))) return json({ error: 'Forbidden.' }, 403);
  if (!pushConfigured()) return json({ error: 'Push is not configured.' }, 503);

  const text = await req.text();
  if (text.length > 1024) return json({ error: 'Bad request.' }, 400);
  let body: { kind?: unknown; id?: unknown };
  try { body = JSON.parse(text) as typeof body; } catch { return json({ error: 'Bad request.' }, 400); }
  const kind = body.kind;
  const id = typeof body.id === 'string' ? body.id : '';
  if ((kind !== 'notification' && kind !== 'message' && kind !== 'call') || !UUID_RE.test(id)) return json({ error: 'Bad request.' }, 400);

  // A call (phase 4) is a server notice row in messages: same recipients as a message.
  const { data, error } = await admin().rpc('push_plan', { p_kind: kind === 'call' ? 'message' : kind, p_id: id });
  if (error) { console.error('push plan failed', error.code); return json({ error: 'Lookup failed.' }, 500); }
  const plan = data as Plan | null;
  if (!plan) return json({ ok: true, skipped: 'gone' });
  const age = Date.now() - new Date(plan.created_at).getTime();
  if (age > (kind === 'call' ? CALL_TTL_SECONDS * 1000 : MAX_AGE_MS)) return json({ ok: true, skipped: 'stale' });

  const d = kind === 'call' ? describeCall(plan, id) : describe(plan);
  if (!d) return json({ ok: true, skipped: 'silent' });
  const ttl = kind === 'call' ? CALL_TTL_SECONDS : undefined;

  const jobs: { sub: StoredSub; payload: PushPayload; urgency: 'high' | 'normal'; ttl?: number }[] = [];
  for (const t of plan.targets) {
    if (t.prefs && t.prefs[d.category] === false) continue;
    const payload: PushPayload = { ...d.payload, badge: Math.max(0, Math.min(999, Number(t.badge) || 0)) };
    for (const sub of t.subs ?? []) jobs.push({ sub, payload, urgency: d.urgency, ttl });
  }
  const r = await sendAll(jobs);
  return json({ ok: true, ...r });
}
