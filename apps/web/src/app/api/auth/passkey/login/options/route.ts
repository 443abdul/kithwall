// POST /api/auth/passkey/login/options — discoverable-credential sign-in ("Sign in with passkey").
// No username: allowCredentials is empty, so the authenticator offers the passkeys it holds for us.
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { json } from '@/lib/auth/server';
import { fail, ipTag, rateLimited, relyingParty, storeChallenge } from '@/lib/auth/passkey-server';
import type { LoginOptionsRes } from '@/lib/auth/passkey-shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const rp = relyingParty(req);
  if (!rp) return fail('passkey_unsupported', 400, 'Passkeys are not configured for this address.');
  try {
    const tag = ipTag(req);
    if (await rateLimited(tag, 'login')) return fail('rate_limited', 429, 'Too many sign-in attempts. Please wait a few minutes.');
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', timeout: 120_000 });
    const challengeId = await storeChallenge({ intent: 'login', challenge: options.challenge, tag });
    return json({ challengeId, options } satisfies LoginOptionsRes);
  } catch (e) {
    console.error('login options', e);
    return fail('network', 503, 'Sign-in is temporarily unavailable.');
  }
}
