// POST /api/recovery/account — { handle } → what a recovering device needs for that account: its id,
// a fresh single-use nonce (purpose 'recover_account', 5 minutes), the recovery parts of the key
// bundle (never the passphrase wrap) and how many trusted friends it has. Works without a session,
// so accounts without an email can recover. See docs/v2/01-accounts.md §3 and §5.
import { json, readJson } from '@/lib/auth/server';
import { fail } from '@/lib/auth/passkey-server';
import { accountTooMany, issueRecoveryChallenge, proofOfWorkOk, targetByHandle, tooMany, trustedSummary } from '@/lib/auth/recovery-server';
import { recoveryBundleOf, type RecoverAccountReq, type RecoverAccountRes } from '@/lib/auth/recovery-shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await readJson<RecoverAccountReq>(req, 8192);
  try {
    if (await tooMany(req, 'recover-account', 20, 10 * 60_000)) return fail('rate_limited', 429, 'Too many attempts. Please wait a few minutes.');
    // Each lookup costs the caller a proof-of-work (security review W4), so hammering a handle is expensive.
    if (!(await proofOfWorkOk(body?.altcha))) return fail('unknown', 400, 'We couldn\'t confirm you\'re a person. Reload the page and try again.');
    const target = await targetByHandle(body?.handle);
    if (target === 'invalid') return fail('handle_invalid', 400, 'That isn\'t a valid handle.');
    if (!target) return fail('no_account', 404, 'No account has that handle.');
    if (await accountTooMany(req, target.userId)) return fail('rate_limited', 429, 'Too many attempts for this account. Please wait an hour.');
    const [challenge, trusted] = await Promise.all([issueRecoveryChallenge(target.userId), trustedSummary(target.userId)]);
    const out: RecoverAccountRes = {
      userId: target.userId, challengeId: challenge.id, nonce: challenge.nonce, bundle: recoveryBundleOf(target.bundle), trusted,
    };
    return json(out);
  } catch (e) {
    console.error('recovery account', e);
    return fail('network', 503, 'Recovery is temporarily unavailable.');
  }
}
