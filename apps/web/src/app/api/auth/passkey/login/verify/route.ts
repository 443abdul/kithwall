// POST /api/auth/passkey/login/verify — { challengeId, response } → a one-time session token hash,
// plus this credential's AMK wrap (opaque: only the PRF output on the person's device opens it).
// The browser redeems the hash with verifyOtp({ token_hash, type: 'magiclink' }).
import { admin, json, readJson } from '@/lib/auth/server';
import {
  consumeChallenge, fail, mintSessionToken, relyingParty, verifyAssertion, type StoredPasskey,
} from '@/lib/auth/passkey-server';
import { isB64u, type LoginVerifyReq, type LoginVerifyRes } from '@/lib/auth/passkey-shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const rp = relyingParty(req);
  if (!rp) return fail('passkey_unsupported', 400, 'Passkeys are not configured for this address.');
  const body = await readJson<LoginVerifyReq>(req, 16_384);
  const credId = body?.response?.id;
  if (!body || !isB64u(credId, 16, 1400) || body.response.rawId !== credId) return fail('unknown', 400, 'Bad request.');
  try {
    const ch = await consumeChallenge(body.challengeId, 'login');
    if (!ch) return fail('unknown', 400, 'This sign-in expired. Please try again.');
    const db = admin();
    const { data: cred, error } = await db.from('passkeys')
      .select('id, user_id, credential_id, public_key, counter, transports').eq('credential_id', credId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!cred) return fail('no_account_for_passkey', 404, 'This passkey isn\'t linked to a Kithwall account.');
    const ok = await verifyAssertion(rp, ch.challenge, body.response, cred as StoredPasskey);
    if (!ok) return fail('passkey_cancelled', 401, 'The passkey could not be verified. Please try again.');
    const bumped = await db.rpc('passkey_used', { p_credential_id: credId, p_counter: ok.newCounter, p_backed_up: ok.backedUp });
    if (bumped.error) return fail('passkey_cancelled', 401, 'This passkey looks cloned. Sign in another way and remove it.');

    const { data: wrap } = await db.from('passkey_wraps').select('prf_salt, amk_wrap').eq('passkey_id', cred.id).maybeSingle();
    const out: LoginVerifyRes = {
      userId: cred.user_id as string,
      tokenHash: await mintSessionToken(cred.user_id as string),
      credentialId: credId,
      wrap: wrap ? { prfSalt: wrap.prf_salt as string, amkWrap: wrap.amk_wrap as string } : null,
    };
    return json(out);
  } catch (e) {
    console.error('login verify', e);
    return fail('network', 503, 'Sign-in is temporarily unavailable.');
  }
}
