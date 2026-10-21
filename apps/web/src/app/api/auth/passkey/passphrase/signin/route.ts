// POST /api/auth/passkey/passphrase/signin — { email, authKey } → { tokenHash }.
// Passphrase sign-in (security re-review R-W3). The browser looks up the account's synthetic address
// (../lookup), derives authKey from the passphrase on the device (Argon2id) and sends only authKey here;
// the passphrase never leaves the device. Calling GoTrue's password grant directly told passphrase
// accounts apart by timing (bcrypt for them, an instant answer for passkey-only accounts and decoys), so
// the check runs in the database instead (public.passphrase_password_ok): exactly one bcrypt for every
// input, whether the address exists, has a password or not. Attempts are limited per client and per
// handle, then a one-time session token is minted exactly like a passkey sign-in.
import { admin, json, readJson } from '@/lib/auth/server';
import { fail, ipTag, mintSessionToken } from '@/lib/auth/passkey-server';
import { clientOverLimit, overLimit, rateKey } from '@/lib/auth/anon-limit';
import type { PassphraseSignInReq, PassphraseSignInRes } from '@/lib/auth/passkey-shared';

export const dynamic = 'force-dynamic';

const SYNTHETIC = /^u[0-9a-f]{32}@id\.kithwall\.invalid$/;
const AUTH_KEY = /^[A-Za-z0-9_-]{16,128}$/;

export async function POST(req: Request) {
  const body = await readJson<PassphraseSignInReq>(req, 2048);
  const email = String(body?.email ?? '').toLowerCase();
  const authKey = String(body?.authKey ?? '');
  // The address format is public (it's what the lookup returns for every handle), so refusing a malformed
  // one early reveals nothing.
  if (!SYNTHETIC.test(email) || !AUTH_KEY.test(authKey)) return fail('wrong_passphrase', 400, 'Invalid login credentials');
  try {
    // Per client, then per handle (from this client, and from everyone): both checked for every request,
    // real or decoy, so the limits cost the same either way.
    const overClient = await clientOverLimit(req, 'passphrase-signin', 30, 600);
    const overTargetClient = await overLimit(rateKey('passphrase-signin-target-client', email, ipTag(req)), 10, 900);
    const overTarget = await overLimit(rateKey('passphrase-signin-target', email), 100, 3600);
    if (overClient || overTargetClient || overTarget) return fail('rate_limited', 429, 'Too many attempts. Please wait a few minutes.');
    const { data, error } = await admin().rpc('passphrase_password_ok', { p_email: email, p_auth_key: authKey });
    if (error) throw new Error(error.message);
    if (typeof data !== 'string') return fail('wrong_passphrase', 401, 'Invalid login credentials');
    const out: PassphraseSignInRes = { tokenHash: await mintSessionToken(data) };
    return json(out);
  } catch (e) {
    console.error('passphrase signin', e);
    return fail('network', 503, 'Please try again.');
  }
}
