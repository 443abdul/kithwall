// POST /api/auth/passkey/add/verify (Bearer) — { challengeId, response, label, prfSalt, amkWrap }.
// Verifies the new credential against a challenge issued to this same account and stores it with
// the AMK wrap the browser made for it.
import { admin, callerFromRequest, json, needsMfa, readJson } from '@/lib/auth/server';
import { consumeChallenge, fail, relyingParty, verifyNewPasskey } from '@/lib/auth/passkey-server';
import { cleanLabel, isB64u, type AddVerifyReq, type AddVerifyRes } from '@/lib/auth/passkey-shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const rp = relyingParty(req);
  if (!rp) return fail('passkey_unsupported', 400, 'Passkeys are not configured for this address.');
  const caller = await callerFromRequest(req);
  if (!caller) return fail('unknown', 401, 'Please sign in again.');
  if (needsMfa(caller)) return fail('mfa_required', 403, 'Enter your authenticator code first.');
  const body = await readJson<AddVerifyReq>(req, 32_768);
  if (!body || !isB64u(body.prfSalt, 43, 43) || !isB64u(body.amkWrap, 90, 120)) return fail('unknown', 400, 'Bad request.');
  try {
    const ch = await consumeChallenge(body.challengeId, 'add');
    if (!ch || ch.user_id !== caller.user.id || !ch.webauthn_user_id) return fail('unknown', 400, 'This request expired. Please try again.');
    const cred = await verifyNewPasskey(rp, ch.challenge, body.response);
    if (!cred) return fail('passkey_cancelled', 400, 'The passkey could not be verified. Please try again.');
    const { data, error } = await admin().rpc('add_passkey', {
      p_user: caller.user.id, p_webauthn_user_id: ch.webauthn_user_id, p_credential_id: cred.credentialId,
      p_public_key: cred.publicKey, p_counter: cred.counter, p_transports: cred.transports, p_backed_up: cred.backedUp,
      p_label: cleanLabel(body.label), p_prf_salt: body.prfSalt, p_amk_wrap: body.amkWrap,
    });
    if (error) {
      if (error.code === '23505') return fail('unknown', 409, 'This passkey is already registered.');
      if (error.code === 'P0429') return fail('rate_limited', 409, 'You have the maximum number of passkeys.');
      throw new Error(error.message);
    }
    return json({ id: data as string } satisfies AddVerifyRes);
  } catch (e) {
    console.error('add passkey verify', e);
    return fail('network', 503, 'Please try again.');
  }
}
