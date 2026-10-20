// POST /api/recovery/notify { requestId } — after starting trusted-friend recovery, email the account
// owner a content-free notice (spec §3.5 step 2). Sent once per request; only for the owner's own
// pending request. Trustees are notified in-app by the client (notifications table).
import { admin, callerFromRequest, claimNotice, json, readJson, siteOrigin } from '@/lib/auth/server';
import { mailConfigured, sendNotice } from '@/lib/auth/mailer';
import { noticeAddress } from '@/lib/auth/passkey-server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return json({ error: 'Please log in again.' }, 401);
  const body = await readJson<{ requestId?: string }>(req);
  const id = String(body?.requestId ?? '');
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'Bad request.' }, 400);
  const { data: r } = await admin().from('recovery_requests').select('id, owner_id, status, not_before').eq('id', id).maybeSingle();
  if (!r || r.owner_id !== caller.user.id || r.status !== 'pending') return json({ error: 'Not found.' }, 404);
  const email = await noticeAddress(caller.user.id, caller.user.email); // verified notice address, never a synthetic one
  let sent = false;
  if (email && mailConfigured() && await claimNotice('recovery_started', id, caller.user.id)) {
    try {
      sent = await sendNotice(email, 'Someone started recovering your Kithwall account',
        `A request to recover your Kithwall account with help from your trusted friends was started.\n\n` +
        `Your friends can't respond until ${new Date(r.not_before as string).toUTCString()}.\n\n` +
        `If this wasn't you, log in at ${siteOrigin(req)} and cancel it under Settings > Security & Recovery,\n` +
        `and tell your trusted friends not to approve it.\n\n— Kithwall`);
    } catch (e) { console.error('recovery notice email', e); }
  }
  return json({ ok: true, emailed: sent });
}
