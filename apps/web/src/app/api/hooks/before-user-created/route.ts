// POST /api/hooks/before-user-created — Supabase Auth "before user created" HTTP hook (spec §7).
// Supabase signs the request (Standard Webhooks). Every Kithwall account is created by the passkey and
// passphrase routes (/api/auth/passkey/register/*) with the admin API, which doesn't run this hook; they
// check the sign-up switch and the ALTCHA proof themselves (docs/v2/01-accounts.md §2). So this hook only
// ever sees GoTrue's public /signup (email + password), which Kithwall doesn't offer: it refuses those. Should
// a newer GoTrue also run it for admin creation, those users carry app_metadata.kw_account, which only the
// admin API can set, and are let through.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { json } from '@/lib/auth/server';

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

export async function POST(req: Request) {
  const body = await req.text();
  if (body.length > 64 * 1024) return json({ error: 'too large' }, 413);
  let valid = false;
  try { valid = verifySignature(req, body); } catch (e) { console.error('auth hook config', e); }
  if (!valid) return json({ error: 'invalid signature' }, 401);
  let payload: { user?: { app_metadata?: Record<string, unknown> } };
  try { payload = JSON.parse(body) as typeof payload; } catch { return json({ error: 'bad request' }, 400); }
  const kind = payload.user?.app_metadata?.kw_account;
  if (kind === 'passkey' || kind === 'passphrase') return json({});
  return reject('Kithwall accounts are made with a passkey or a passphrase. Open the app and choose "Join".');
}
