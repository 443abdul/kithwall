// POST /api/auth/passkey/notice-email (Bearer) — { email: string | null }.
// An optional real address for content-free account notices ("a recovery was started", "your
// account is scheduled for deletion"). It is NOT a sign-in identifier and never replaces the auth
// address. Setting it sends a verification link; the address is used only once confirmed.
// What is stored (docs/v2/01-accounts.md): account_security.notice_email + verified time, and while
// pending a SHA-256 of the link token with the address (deleted a day after it expires).
// null removes the address and any pending links.
import { admin, callerFromRequest, json, needsMfa, readJson, siteOrigin } from '@/lib/auth/server';
import { mailConfigured, sendNotice } from '@/lib/auth/mailer';
import { fail, randomToken, sha256Hex } from '@/lib/auth/passkey-server';
import { noticeEmailOk, type NoticeEmailReq, type NoticeEmailRes } from '@/lib/auth/passkey-shared';

export const dynamic = 'force-dynamic';

const MAX_PER_DAY = 5;

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return fail('unknown', 401, 'Please sign in again.');
  if (needsMfa(caller)) return fail('mfa_required', 403, 'Enter your authenticator code first.');
  const body = await readJson<NoticeEmailReq>(req, 2048);
  if (!body || (body.email !== null && typeof body.email !== 'string')) return fail('unknown', 400, 'Bad request.');
  const db = admin();
  const userId = caller.user.id;
  try {
    if (body.email === null) {
      await db.from('notice_email_verifications').delete().eq('user_id', userId);
      const { error } = await db.from('account_security').upsert(
        { user_id: userId, notice_email: null, notice_email_verified_at: null, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' });
      if (error) throw new Error(error.message);
      return json({ pending: false, sent: false } satisfies NoticeEmailRes);
    }
    const email = body.email.trim();
    if (!noticeEmailOk(email)) return fail('unknown', 400, 'Please enter a valid email address.');
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { count } = await db.from('notice_email_verifications').select('token_hash', { count: 'exact', head: true })
      .eq('user_id', userId).gt('created_at', since);
    if ((count ?? 0) >= MAX_PER_DAY) return fail('rate_limited', 429, 'Too many verification emails today. Try again tomorrow.');

    const token = randomToken();
    const { error } = await db.from('notice_email_verifications').insert({ token_hash: sha256Hex(token), user_id: userId, email });
    if (error) throw new Error(error.message);
    let sent = false;
    if (mailConfigured()) {
      const link = `${siteOrigin(req)}/api/auth/passkey/notice-email/verify?token=${encodeURIComponent(token)}`;
      sent = await sendNotice(email, 'Confirm your Kithwall notice address',
        `Someone asked Kithwall to send account notices (never your posts or messages) to this address.\n\n` +
        `To confirm, open this link within 24 hours:\n${link}\n\n` +
        `If this wasn't you, ignore this email and nothing will be sent here.\n\n— Kithwall`);
    } else {
      console.info('[mail] notice-email verification not sent: SMTP_URL/MAIL_FROM not set');
    }
    return json({ pending: true, sent } satisfies NoticeEmailRes);
  } catch (e) {
    console.error('notice email', e);
    return fail('network', 503, 'Please try again.');
  }
}
