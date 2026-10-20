// POST /api/recovery/finish — { userId, challengeId, signature, requestId? } → a one-time session token.
// The device unlocked the account's identity key with the recovery key (typed, or rebuilt from trusted
// friends' shares) and signed the nonce from /api/recovery/account. We verify the signature against the
// published identity key, spend the challenge, close the trusted-friend request (if any), send a
// content-free notice to the account's notice address, and mint a session exactly like a passkey
// sign-in (lib/auth/passkey-server.ts mintSessionToken). Accounts with an authenticator app still
// need the 6-digit code afterwards: the session starts at aal1.
import { admin, claimNotice, json, readJson, siteOrigin, verifyProofOfKey } from '@/lib/auth/server';
import { mailConfigured, sendNotice } from '@/lib/auth/mailer';
import { fail, mintSessionToken, noticeAddress } from '@/lib/auth/passkey-server';
import { tooMany } from '@/lib/auth/recovery-server';
import { UUID_RE, type RecoverFinishReq, type RecoverFinishRes } from '@/lib/auth/recovery-shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (tooMany(req, 'recover-finish', 20, 10 * 60_000)) return fail('rate_limited', 429, 'Too many attempts. Please wait a few minutes.');
  const body = await readJson<RecoverFinishReq>(req, 4096);
  const userId = String(body?.userId ?? '');
  const requestId = body?.requestId ? String(body.requestId) : null;
  if (!UUID_RE.test(userId) || (requestId && !UUID_RE.test(requestId))) return fail('unknown', 400, 'Bad request.');
  try {
    const problem = await verifyProofOfKey(userId, String(body?.challengeId ?? ''), String(body?.signature ?? ''), 'recover_account');
    if (problem) return fail('bad_recovery_key', 403, problem);
    const db = admin();
    if (requestId) {
      await db.from('recovery_requests').update({ status: 'completed' })
        .eq('id', requestId).eq('owner_id', userId).eq('status', 'pending');
    }
    const out: RecoverFinishRes = { tokenHash: await mintSessionToken(userId) };
    const { data: u } = await db.auth.admin.getUserById(userId);
    const to = await noticeAddress(userId, u.user?.email);
    if (to && mailConfigured() && await claimNotice('account_recovered', String(body?.challengeId), userId)) {
      void sendNotice(to, 'Your Kithwall account was recovered',
        `Someone just got back into your Kithwall account with ${requestId ? 'help from your trusted friends' : 'your recovery key'}.\n\n` +
        `If this was you, there's nothing to do. If it wasn't, sign in at ${siteOrigin(req)}, make a new recovery key ` +
        `under You > Settings > Security, and remove any passkeys you don't recognise.\n\n— Kithwall`).catch((e) => console.error('recovery notice', e));
    }
    return json(out);
  } catch (e) {
    console.error('recovery finish', e);
    return fail('network', 503, 'Recovery is temporarily unavailable.');
  }
}
