// POST /api/auth/passkey/add/options (Authorization: Bearer <access token>) — add a passkey to the
// signed-in account (a second device, or a v1 account moving to passkeys). The browser wraps the
// account master key for the new credential before calling /add/verify.
import { randomBytes } from 'node:crypto';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { admin, callerFromRequest, json, needsMfa } from '@/lib/auth/server';
import { RP_NAME, fail, ipTag, rateLimited, relyingParty, storeChallenge } from '@/lib/auth/passkey-server';
import type { AddOptionsRes } from '@/lib/auth/passkey-shared';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const rp = relyingParty(req);
  if (!rp) return fail('passkey_unsupported', 400, 'Passkeys are not configured for this address.');
  const caller = await callerFromRequest(req);
  if (!caller) return fail('unknown', 401, 'Please sign in again.');
  if (needsMfa(caller)) return fail('mfa_required', 403, 'Enter your authenticator code first.');
  try {
    const tag = ipTag(req);
    if (await rateLimited(tag, 'add')) return fail('rate_limited', 429, 'Too many attempts. Please try again later.');
    const db = admin();
    const userId = caller.user.id;
    const [{ data: prof }, { data: pu }, { data: existing }] = await Promise.all([
      db.from('profiles').select('username').eq('id', userId).maybeSingle(),
      db.from('passkey_users').select('webauthn_user_id').eq('user_id', userId).maybeSingle(),
      db.from('passkeys').select('credential_id, transports').eq('user_id', userId),
    ]);
    if (!prof) return fail('unknown', 409, 'Finish setting up your account first.');
    if ((existing?.length ?? 0) >= 20) return fail('rate_limited', 409, 'You have the maximum number of passkeys.');
    const userID = pu?.webauthn_user_id
      ? new Uint8Array(Buffer.from(pu.webauthn_user_id as string, 'base64url'))
      : new Uint8Array(randomBytes(32));
    const handle = String(prof.username);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: rp.rpID, userName: handle, userDisplayName: handle, userID,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: (existing ?? []).map((c) => ({
        id: c.credential_id as string, transports: (c.transports ?? []) as AuthenticatorTransportFuture[],
      })),
      supportedAlgorithmIDs: [-8, -7, -257],
      timeout: 120_000,
    });
    const challengeId = await storeChallenge({
      intent: 'add', challenge: options.challenge, tag, userId, webauthnUserId: options.user.id,
    });
    return json({ challengeId, options } satisfies AddOptionsRes);
  } catch (e) {
    console.error('add passkey options', e);
    return fail('network', 503, 'Please try again.');
  }
}
