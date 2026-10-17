// POST /api/hooks/before-user-created — Supabase Auth "before user created" HTTP hook (spec §7).
// Supabase signs the request (Standard Webhooks). We allow the sign-up only if:
//   1. the signature is valid and fresh (AUTH_HOOK_SECRET),
//   2. sign-ups are enabled (app_settings.signups_enabled),
//   3. the user metadata carries a valid, unexpired, unused ALTCHA proof-of-work.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parsePayload, verifyPayload } from '@/lib/auth/altcha-server';
import { admin, json } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const TOLERANCE_S = 5 * 60;

function hookKey(): Buffer {
  const s = process.env.AUTH_HOOK_SECRET ?? '';
  // Supabase format: "v1,whsec_<base64>". A raw string is accepted only outside production (local dev).
  const m = /^v1,whsec_([A-Za-z0-9+/=]+)$/.exec(s);
  if (m) return Buffer.from(m[1]!, 'base64');
  if (process.env.NODE_ENV !== 'production' && s.length >= 16) return Buffer.from(s, 'utf8');
  throw new Error('AUTH_HOOK_SECRET must look like v1,whsec_<base64>');
}

/** Standard Webhooks: HMAC-SHA256(key, `${id}.${timestamp}.${body}`), base64, in "v1,<sig>" entries. */
function verifySignature(req: Request, body: string): boolean {
  const id = req.headers.get('webhook-id');
  const ts = req.headers.get('webhook-timestamp');
  const sigs = req.headers.get('webhook-signature');
  if (!id || !ts || !sigs || !/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_S) return false;
  const expected = createHmac('sha256', hookKey()).update(`${id}.${ts}.${body}`).digest();
  return sigs.split(' ').some((entry) => {
    const [ver, b64] = entry.split(',');
    if (ver !== 'v1' || !b64) return false;
    let got: Buffer;
    try { got = Buffer.from(b64, 'base64'); } catch { return false; }
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

const reject = (message: string, httpCode = 403) =>
  json({ decision: 'reject', message, error: { http_code: httpCode, message } });

interface HookBody {
  metadata?: { name?: string };
  user?: { email?: string; user_metadata?: Record<string, unknown>; raw_user_meta_data?: Record<string, unknown> };
}

export async function POST(req: Request) {
  const body = await req.text();
  if (body.length > 64 * 1024) return json({ error: 'too large' }, 413);
  let valid = false;
  try { valid = verifySignature(req, body); } catch (e) { console.error('auth hook config', e); }
  if (!valid) return json({ error: 'invalid signature' }, 401);

  let payload: HookBody;
  try { payload = JSON.parse(body) as HookBody; } catch { return json({ error: 'bad request' }, 400); }

  const db = admin();
  const { data: setting } = await db.from('app_settings').select('value').eq('key', 'signups_enabled').maybeSingle();
  if (setting?.value === false) return reject('Kithwall isn\'t accepting new sign-ups right now. Please try again later.');

  const meta = payload.user?.user_metadata ?? payload.user?.raw_user_meta_data ?? {};
  const pow = parsePayload(meta.altcha);
  if (!pow || !(await verifyPayload(pow))) {
    return reject('We couldn\'t confirm you\'re a person. Reload the page and try again.', 400);
  }
  // Single use: a solved challenge can create one account only.
  const spent = await db.from('altcha_spent').insert({ signature: pow.challenge.signature });
  if (spent.error) {
    if (spent.error.code === '23505') return reject('This sign-up form has already been used. Reload the page and try again.', 400);
    console.error('altcha_spent', spent.error.message);
    return reject('Sign-up is temporarily unavailable.', 503);
  }
  return json({});
}
