// POST /api/auth/passkey/register/verify — finish creating a Kithwall 2 account.
// Body (RegisterVerifyReq): { challengeId, bundle, passkey?: { response, label, prfSalt, amkWrap }, authKey? }.
// The challenge (single use, 5 min) carries the user id, handle and WebAuthn user handle chosen at
// /register/options. We verify the attestation, create the auth user (synthetic address, no
// password unless this is a passphrase account), then key bundle + profile + passkey + AMK wrap in
// one database transaction. A passkey account gets a one-time session token hash back.
import { admin, json, readJson } from '@/lib/auth/server';
import {
  consumeChallenge, createAuthUser, deleteAuthUser, fail, mintSessionToken, relyingParty, verifyNewPasskey,
} from '@/lib/auth/passkey-server';
import { bundleLooksValid, cleanLabel, isB64u, type RegisterVerifyReq, type RegisterVerifyRes } from '@/lib/auth/passkey-shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await readJson<RegisterVerifyReq>(req, 32_768);
  if (!body) return fail('unknown', 400, 'Bad request.');
  const passphrase = !body.passkey;
  if (passphrase && !isB64u(body.authKey, 43, 43)) return fail('unknown', 400, 'Bad request.');
  if (!passphrase && (!isB64u(body.passkey!.prfSalt, 43, 43) || !isB64u(body.passkey!.amkWrap, 90, 120))) {
    return fail('unknown', 400, 'Bad request.');
  }
  if (!bundleLooksValid(body.bundle, { password: passphrase })) return fail('unknown', 400, 'Malformed key bundle.');

  let createdUser: string | null = null;
  try {
    const ch = await consumeChallenge(body.challengeId, passphrase ? 'register_passphrase' : 'register');
    if (!ch || !ch.new_user_id || !ch.handle) return fail('unknown', 400, 'This sign-up expired. Please start again.');

    let cred = null;
    if (!passphrase) {
      const rp = relyingParty(req);
      if (!rp || !ch.webauthn_user_id) return fail('passkey_unsupported', 400, 'Passkeys are not configured for this address.');
      cred = await verifyNewPasskey(rp, ch.challenge, body.passkey!.response);
      if (!cred) return fail('passkey_cancelled', 400, 'The passkey could not be verified. Please try again.');
    }

    const email = await createAuthUser(ch.new_user_id, passphrase ? body.authKey : undefined);
    createdUser = ch.new_user_id;
    const { error } = await admin().rpc('create_passkey_account', {
      p_user: ch.new_user_id, p_handle: ch.handle, p_bundle: body.bundle,
      ...(cred ? {
        p_webauthn_user_id: ch.webauthn_user_id, p_credential_id: cred.credentialId, p_public_key: cred.publicKey,
        p_counter: cred.counter, p_transports: cred.transports, p_backed_up: cred.backedUp,
        p_label: cleanLabel(body.passkey!.label), p_prf_salt: body.passkey!.prfSalt, p_amk_wrap: body.passkey!.amkWrap,
      } : {}),
    });
    if (error) {
      await deleteAuthUser(ch.new_user_id);
      createdUser = null;
      if (error.code === '23505') {
        return /credential/i.test(error.message)
          ? fail('unknown', 409, 'This passkey is already registered.')
          : fail('handle_taken', 409, 'taken');
      }
      if (error.code === '23514') return fail('handle_invalid', 409, 'invalid');
      throw new Error(error.message);
    }
    const out: RegisterVerifyRes = { userId: ch.new_user_id, email };
    if (!passphrase) out.tokenHash = await mintSessionToken(ch.new_user_id);
    return json(out);
  } catch (e) {
    console.error('register verify', e);
    if (createdUser) await deleteAuthUser(createdUser);
    return fail('network', 503, 'Sign-up is temporarily unavailable.');
  }
}
