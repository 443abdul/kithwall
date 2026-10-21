// POST /api/recovery/friends/start — { handle, ephPub } → opens a trusted-friend recovery request for
// that account without a session (accounts without email can't prove email control). The recovering
// device keeps the ephemeral private key; friends seal their share to ephPub after the waiting period.
// Safeguards (docs/v2/01-accounts.md §5): the waiting period, at most 3 requests per account a day,
// the owner's signed-in devices show the request with a cancel button, the owner gets a notice email
// if they have a notice address, and each friend must hear the six-word phrase from the owner.
import { admin, claimNotice, json, readJson, siteOrigin } from '@/lib/auth/server';
import { mailConfigured, sendNotice } from '@/lib/auth/mailer';
import { fail, ipTag, noticeAddress } from '@/lib/auth/passkey-server';
import { isB64u } from '@/lib/auth/passkey-shared';
import { proofOfWorkOk, targetByHandle, tooMany } from '@/lib/auth/recovery-server';
import type { FriendsStartReq, FriendsStartRes } from '@/lib/auth/recovery-shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await readJson<FriendsStartReq>(req, 8192);
  if (!isB64u(body?.ephPub, 43, 43)) return fail('unknown', 400, 'Bad request.');
  try {
    if (await tooMany(req, 'recover-friends', 6, 60 * 60_000)) return fail('rate_limited', 429, 'Too many attempts. Please try again later.');
    // A fake request costs real CPU (security review W4).
    if (!(await proofOfWorkOk(body?.altcha))) return fail('unknown', 400, 'We couldn\'t confirm you\'re a person. Reload the page and try again.');
    const target = await targetByHandle(body?.handle);
    if (target === 'invalid') return fail('handle_invalid', 400, 'That isn\'t a valid handle.');
    if (!target) return fail('no_account', 404, 'No account has that handle.');
    const db = admin();
    const { data, error } = await db.rpc('start_handle_recovery', { p_owner: target.userId, p_eph_pub: body!.ephPub, p_requester: ipTag(req) });
    if (error) {
      if (error.code === 'P0002') return fail('no_trustees', 409, 'This account has no trusted friends.');
      if (error.code === 'P0429') return fail('rate_limited', 429, 'Too many recovery requests for this account today.');
      throw new Error(error.message);
    }
    const row = (data as { request_id: string; not_before: string; expires_at: string; threshold: number; trustees: number }[])[0];
    if (!row) throw new Error('no request row');
    const { data: u } = await db.auth.admin.getUserById(target.userId);
    const to = await noticeAddress(target.userId, u.user?.email);
    if (to && mailConfigured() && await claimNotice('recovery_started', row.request_id, target.userId)) {
      void sendNotice(to, 'Someone started recovering your Kithwall account',
        `A request to recover your Kithwall account with help from your trusted friends was started.\n\n` +
        `Your friends can't respond until ${new Date(row.not_before).toUTCString()}.\n\n` +
        `If this wasn't you, sign in at ${siteOrigin(req)} and cancel it from the warning at the top of the app,\n` +
        `and tell your trusted friends not to approve it.\n\n— Kithwall`).catch((e) => console.error('recovery notice', e));
    }
    const out: FriendsStartRes = {
      requestId: row.request_id, notBefore: row.not_before, expiresAt: row.expires_at, threshold: row.threshold, trustees: row.trustees,
    };
    return json(out);
  } catch (e) {
    console.error('recovery friends start', e);
    return fail('network', 503, 'Recovery is temporarily unavailable.');
  }
}
