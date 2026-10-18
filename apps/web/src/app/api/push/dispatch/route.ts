// POST /api/push/dispatch  {kind: 'notification' | 'message', id}
// Called by the database (pg_net, AFTER INSERT triggers in 20261020000100_push.sql) with the
// x-kw-push-secret header. The body carries only a row id; everything else is looked up here with the
// secret key. Sends a "who + what" Web Push to every subscribed device of every recipient.
import { admin, json } from '@/lib/auth/server';
import { describe, dispatchSecretOk, pushConfigured, sendAll, UUID_RE, type Plan, type PushPayload, type StoredSub } from '../_lib/push-server';

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
  if ((kind !== 'notification' && kind !== 'message') || !UUID_RE.test(id)) return json({ error: 'Bad request.' }, 400);

  const { data, error } = await admin().rpc('push_plan', { p_kind: kind, p_id: id });
  if (error) { console.error('push plan failed', error.code); return json({ error: 'Lookup failed.' }, 500); }
  const plan = data as Plan | null;
  if (!plan) return json({ ok: true, skipped: 'gone' });
  if (Date.now() - new Date(plan.created_at).getTime() > MAX_AGE_MS) return json({ ok: true, skipped: 'stale' });

  const d = describe(plan);
  if (!d) return json({ ok: true, skipped: 'silent' });

  const jobs: { sub: StoredSub; payload: PushPayload; urgency: 'high' | 'normal' }[] = [];
  for (const t of plan.targets) {
    if (t.prefs && t.prefs[d.category] === false) continue;
    const payload: PushPayload = { ...d.payload, badge: Math.max(0, Math.min(999, Number(t.badge) || 0)) };
    for (const sub of t.subs ?? []) jobs.push({ sub, payload, urgency: d.urgency });
  }
  const r = await sendAll(jobs);
  return json({ ok: true, ...r });
}
