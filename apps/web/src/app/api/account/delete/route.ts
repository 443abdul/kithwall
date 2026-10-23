// POST /api/account/delete — permanent account deletion (spec §3.9, §5).
//  { challengeId, signature }  proof-of-key: the browser signed a fresh server nonce with the identity key.
// The caller's access token is validated with Supabase Auth; MFA users need an aal2 session.
import { callerFromRequest, deleteAccountNow, json, needsMfa, readJson, verifyProofOfKey } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

interface Body { challengeId?: string; signature?: string }

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return json({ error: 'Please log in again.' }, 401);
  const body = await readJson<Body>(req);
  if (!body) return json({ error: 'Bad request.' }, 400);
  const userId = caller.user.id;

  if (needsMfa(caller)) return json({ error: 'Enter your authenticator code first.' }, 403);
  const problem = await verifyProofOfKey(userId, String(body.challengeId ?? ''), String(body.signature ?? ''), 'delete_account');
  if (problem) return json({ error: problem }, 403);

  try {
    await deleteAccountNow(userId);
  } catch (e) {
    console.error('account delete', userId, e);
    return json({ error: 'We couldn\'t finish deleting your account. Please try again.' }, 500);
  }
  return json({ deleted: true });
}
