// POST /api/auth/passkey/register/options — start creating a Kithwall 2 account.
// Body: { handle, altcha, mode: 'passkey' | 'passphrase' }.
// Checks: sign-ups enabled, per-client rate limit, ALTCHA proof-of-work (verified and spent here:
// admin user creation does not run the before-user-created hook), handle shape and availability.
// Allocates the account's user id now so the browser can bind its keys to it before the account
// exists. Returns WebAuthn creation options (passkey) or the synthetic auth address (passphrase).
import { randomBytes, randomUUID } from 'node:crypto';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { parsePayload, verifyPayload } from '@/lib/auth/altcha-server';
import { admin, json, readJson } from '@/lib/auth/server';
import {
  RP_NAME, fail, handleTaken, ipTag, rateLimited, relyingParty, signupsEnabled, storeChallenge,
} from '@/lib/auth/passkey-server';
import { handleShapeProblem, normalizeHandle, syntheticEmailFor, type RegisterOptionsReq, type RegisterOptionsRes } from '@/lib/auth/passkey-shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await readJson<RegisterOptionsReq>(req, 8192);
  if (!body || (body.mode !== 'passkey' && body.mode !== 'passphrase')) return fail('unknown', 400, 'Bad request.');
  const intent = body.mode === 'passkey' ? 'register' : 'register_passphrase';
  const rp = body.mode === 'passkey' ? relyingParty(req) : null;
  if (body.mode === 'passkey' && !rp) return fail('passkey_unsupported', 400, 'Passkeys are not configured for this address.');

  const handle = normalizeHandle(body.handle);
  const shape = handleShapeProblem(handle);
  if (shape) return fail(shape === 'reserved' ? 'handle_taken' : 'handle_invalid', 409, shape);

  try {
    if (!(await signupsEnabled())) return fail('signups_closed', 403, 'Kithwall isn\'t accepting new sign-ups right now.');
    const tag = ipTag(req);
    if (await rateLimited(tag, intent)) return fail('rate_limited', 429, 'Too many sign-up attempts. Please try again later.');

    const pow = parsePayload(body.altcha);
    if (!pow || !(await verifyPayload(pow))) return fail('proof_failed', 400, 'We couldn\'t confirm you\'re a person. Please try again.');
    const spent = await admin().from('altcha_spent').insert({ signature: pow.challenge.signature });
    if (spent.error) {
      if (spent.error.code === '23505') return fail('proof_failed', 400, 'This security check was already used. Please try again.');
      throw new Error(spent.error.message);
    }

    if (await handleTaken(handle)) return fail('handle_taken', 409, 'taken');

    const userId = randomUUID();
    if (body.mode === 'passphrase') {
      const challengeId = await storeChallenge({ intent, challenge: randomBytes(32).toString('base64url'), tag, newUserId: userId, handle });
      return json({ challengeId, userId, email: syntheticEmailFor(userId) } satisfies RegisterOptionsRes);
    }

    const webauthnUserId = new Uint8Array(randomBytes(32));
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp!.rpID,
      userName: handle,
      // The browser replaces displayName with the person's name locally; the server never sees it.
      userDisplayName: handle,
      userID: webauthnUserId,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      supportedAlgorithmIDs: [-8, -7, -257],
      timeout: 120_000,
    });
    const challengeId = await storeChallenge({
      intent, challenge: options.challenge, tag, newUserId: userId, handle, webauthnUserId: options.user.id,
    });
    return json({ challengeId, userId, options } satisfies RegisterOptionsRes);
  } catch (e) {
    console.error('register options', e);
    return fail('network', 503, 'Sign-up is temporarily unavailable.');
  }
}
