// POST /api/auth/passkey/passphrase/enable (Bearer) — after a passkey account set a passphrase (for
// example while recovering on a device without passkeys), mark it as a passphrase account so that
// sign-in with @handle + passphrase finds it (see ../lookup/route.ts). Only for accounts with a synthetic
// sign-in address whose key bundle really has a passphrase wrap.
// Security review W2: the caller proves possession of the identity key ({ challengeId, signature } over
// a fresh 'add_credential' nonce) and every device plus the notice address is told.
import { admin, callerFromRequest, json, needsMfa, readJson, verifyProofOfKey } from '@/lib/auth/server';
import { noticeSecurityChange } from '@/lib/auth/credentials-server';
import { fail } from '@/lib/auth/passkey-server';
import { isSyntheticEmail } from '@/lib/auth/passkey-shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return fail('unknown', 401, 'Please sign in again.');
  if (needsMfa(caller)) return fail('mfa_required', 403, 'Enter your authenticator code first.');
  const u = caller.user;
  if (!isSyntheticEmail(u.email)) return json({ ok: false });
  const body = await readJson<{ challengeId?: string; signature?: string }>(req, 4096);
  const problem = await verifyProofOfKey(u.id, String(body?.challengeId ?? ''), String(body?.signature ?? ''), 'add_credential');
  if (problem) return fail('unknown', 403, problem);
  try {
    const db = admin();
    const { data } = await db.from('key_bundles').select('bundle').eq('user_id', u.id).maybeSingle();
    const hasWrap = typeof (data?.bundle as { amkByPassword?: unknown } | undefined)?.amkByPassword === 'string';
    if (!hasWrap) return fail('unknown', 409, 'Set a passphrase first.');
    if (u.app_metadata?.kw_account !== 'passphrase') {
      const { error } = await db.auth.admin.updateUserById(u.id, { app_metadata: { ...u.app_metadata, kw_account: 'passphrase' } });
      if (error) throw new Error(error.message);
      await noticeSecurityChange(req, u.id, 'passphrase', String(body?.challengeId));
    }
    return json({ ok: true });
  } catch (e) {
    console.error('passphrase enable', e);
    return fail('network', 503, 'Please try again.');
  }
}
