// POST /api/account/deletion-request — "I've lost everything": schedule deletion in 72 hours.
// Runs the RPC as the caller (rate-limited, idempotent) and sends ONE content-free notice email.
// Logging in normally cancels it (public.cancel_account_deletion), so a hijacked email account
// can't quietly destroy someone's account.
import { createHash } from 'node:crypto';
import { asUser, callerFromRequest, claimNotice, json, siteOrigin } from '@/lib/auth/server';
import { mailConfigured, sendNotice } from '@/lib/auth/mailer';
import { noticeAddress } from '@/lib/auth/passkey-server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return json({ error: 'Open the password reset link from your email first.' }, 401);
  const { data, error } = await asUser(caller.jwt).rpc('request_account_deletion');
  if (error) {
    const limited = error.code === 'P0429';
    return json({ error: limited ? 'Too many requests. Try again tomorrow.' : 'We couldn\'t schedule the deletion.' }, limited ? 429 : 500);
  }
  const executeAfter = String(data);
  const email = await noticeAddress(caller.user.id, caller.user.email); // verified notice address, never a synthetic one
  if (email && mailConfigured()) {
    try {
      // One email per scheduled deletion: re-requesting the same schedule doesn't re-send.
      const { data: row } = await asUser(caller.jwt).from('account_deletion_requests').select('requested_at').maybeSingle();
      const h = createHash('sha256').update(`${caller.user.id}/${row?.requested_at ?? executeAfter}`).digest('hex');
      const ref = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      if (await claimNotice('deletion_scheduled', ref, caller.user.id)) {
        const when = new Date(executeAfter).toUTCString();
        await sendNotice(email, 'Your Kithwall account is scheduled for deletion',
          `Someone with access to this email address asked to delete the Kithwall account registered to it,\n` +
          `because the password and recovery key were lost.\n\n` +
          `The account will be permanently deleted after ${when}.\n\n` +
          `If this wasn't you, or you remember your password, just log in at ${siteOrigin(req)} before then:\n` +
          `logging in cancels the deletion.\n\n— Kithwall`);
      }
    } catch (e) { console.error('deletion notice email', e); }
  }
  return json({ executeAfter });
}

// DELETE cancels (used by the "Cancel deletion" button; logging in also cancels automatically).
export async function DELETE(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return json({ error: 'Please log in again.' }, 401);
  const { data, error } = await asUser(caller.jwt).rpc('cancel_account_deletion');
  if (error) return json({ error: 'We couldn\'t cancel the deletion.' }, 500);
  return json({ cancelled: data === true });
}
