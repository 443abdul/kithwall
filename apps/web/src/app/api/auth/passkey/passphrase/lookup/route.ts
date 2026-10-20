// POST /api/auth/passkey/passphrase/lookup — { handle } → { email }.
// Passphrase accounts sign in with handle + passphrase. The browser needs the account's synthetic
// auth address: it is the Argon2id salt and the Supabase sign-in identifier (the passphrase itself
// never leaves the device; Supabase receives only the derived authKey). For handles that don't
// belong to a passphrase account we return a deterministic decoy address of the same shape, so the
// answer doesn't reveal which kind of account a handle has; the sign-in then simply fails.
import { createHmac } from 'node:crypto';
import { admin, json, readJson } from '@/lib/auth/server';
import { fail, ipTag } from '@/lib/auth/passkey-server';
import { HANDLE_RE, SYNTHETIC_EMAIL_DOMAIN, isSyntheticEmail, normalizeHandle, type LookupReq, type LookupRes } from '@/lib/auth/passkey-shared';

export const dynamic = 'force-dynamic';

const hits = new Map<string, { n: number; reset: number }>();
const MAX = 30, WINDOW_MS = 10 * 60_000;

function decoy(handle: string): string {
  const key = process.env.ALTCHA_HMAC_KEY ?? process.env.SUPABASE_SECRET_KEY ?? 'kithwall';
  const hex = createHmac('sha256', key).update(`kithwall/passphrase-decoy\n${handle}`).digest('hex').slice(0, 32);
  return `u${hex}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

export async function POST(req: Request) {
  const tag = ipTag(req);
  const now = Date.now();
  const h = hits.get(tag);
  if (!h || h.reset < now) hits.set(tag, { n: 1, reset: now + WINDOW_MS });
  else if (++h.n > MAX) return fail('rate_limited', 429, 'Too many attempts. Please wait a few minutes.');
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);

  const body = await readJson<LookupReq>(req, 1024);
  const handle = normalizeHandle(body?.handle ?? '');
  if (!HANDLE_RE.test(handle)) return fail('handle_invalid', 400, 'invalid');
  try {
    const db = admin();
    const { data: prof } = await db.from('profiles').select('id').eq('username', handle).maybeSingle();
    if (prof) {
      const { data } = await db.auth.admin.getUserById(prof.id as string);
      const u = data.user;
      if (u?.email && isSyntheticEmail(u.email) && u.app_metadata?.kw_account === 'passphrase') {
        return json({ email: u.email } satisfies LookupRes);
      }
    }
    return json({ email: decoy(handle) } satisfies LookupRes);
  } catch (e) {
    console.error('passphrase lookup', e);
    return fail('network', 503, 'Please try again.');
  }
}
