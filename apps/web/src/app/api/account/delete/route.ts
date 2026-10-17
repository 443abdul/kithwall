// POST /api/account/delete — permanent account deletion (spec §3.9, §5).
//  { challengeId, signature }  proof-of-key: the browser signed a fresh server nonce with the identity key.
//  { mode: "scheduled" }       "I've lost everything": allowed only once the 72-hour waiting period
//                              of a scheduled deletion request has passed.
// The caller's access token is validated with Supabase Auth; MFA users need an aal2 session.
import { admin, callerFromRequest, deleteAccountNow, json, needsMfa, readJson, verifyProofOfKey } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

interface Body { challengeId?: string; signature?: string; mode?: 'scheduled' }

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return json({ error: 'Please log in again.' }, 401);
  const body = await readJson<Body>(req);
  if (!body) return json({ error: 'Bad request.' }, 400);
  const userId = caller.user.id;
  const db = admin();

  if (body.mode === 'scheduled') {
    const { data } = await db.from('account_deletion_requests').select('execute_after').eq('user_id', userId).maybeSingle();
    if (!data) return json({ error: 'There is no scheduled deletion for this account.' }, 404);
    if (new Date(data.execute_after as string).getTime() > Date.now()) {
      return json({ error: 'The waiting period isn\'t over yet.', executeAfter: data.execute_after }, 409);
    }
  } else {
    if (needsMfa(caller)) return json({ error: 'Enter your authenticator code first.' }, 403);
    const { data: prof } = await db.from('profiles').select('id').eq('id', userId).maybeSingle();
    if (prof) {
      const problem = await verifyProofOfKey(userId, String(body.challengeId ?? ''), String(body.signature ?? ''), 'delete_account');
      if (problem) return json({ error: problem }, 403);
    } else {
      // Never finished setup: there are no keys to prove and no content to protect.
      const { data: bundle } = await db.from('key_bundles').select('user_id').eq('user_id', userId).maybeSingle();
      if (bundle) return json({ error: 'Your identity key is required.' }, 403);
    }
  }

  try {
    await deleteAccountNow(userId);
  } catch (e) {
    console.error('account delete', userId, e);
    return json({ error: 'We couldn\'t finish deleting your account. Please try again.' }, 500);
  }
  return json({ deleted: true });
}
