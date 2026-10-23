// POST /api/auth/passkey/passphrase/lookup — { handle } → { email }.
// Passphrase accounts sign in with handle + passphrase. The browser needs the account's synthetic
// auth address: it is the Argon2id salt and the Supabase sign-in identifier (the passphrase itself
// never leaves the device; Supabase receives only the derived authKey).
//
// The answer must not reveal which kind of account a handle has (security review W3), so it is
// computed WITHOUT looking at the account type:
//  * a handle that exists → the synthetic address derived from its profile id, whatever kind of account
//    it is (for passkey accounts the passphrase sign-in then simply fails);
//  * a handle that doesn't → a deterministic decoy of exactly the same shape (a version-4 UUID derived
//    from an HMAC of the handle under a server secret), so repeated lookups agree.
// Both paths make the same single query. With no server secret configured the route fails closed.
import { admin, json, readJson } from '@/lib/auth/server';
import { fail } from '@/lib/auth/passkey-server';
import { clientOverLimit } from '@/lib/auth/anon-limit';
import { decoyId, decoySecret } from '@/lib/auth/passphrase-decoy';
import { HANDLE_RE, normalizeHandle, syntheticEmailFor, type LookupReq, type LookupRes } from '@/lib/auth/passkey-shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const secret = decoySecret();
  if (!secret) return fail('network', 503, 'Please try again.');
  const body = await readJson<LookupReq>(req, 1024);
  const handle = normalizeHandle(body?.handle ?? '');
  if (!HANDLE_RE.test(handle)) return fail('handle_invalid', 400, 'invalid');
  try {
    if (await clientOverLimit(req, 'passphrase-lookup', 30, 600)) return fail('rate_limited', 429, 'Too many attempts. Please wait a few minutes.');
    const { data: prof, error } = await admin().from('profiles').select('id').eq('username', handle).maybeSingle();
    if (error) throw new Error(error.message);
    const id = (prof?.id as string | undefined) ?? decoyId(handle, secret);
    return json({ email: syntheticEmailFor(id) } satisfies LookupRes);
  } catch (e) {
    console.error('passphrase lookup', e);
    return fail('network', 503, 'Please try again.');
  }
}
