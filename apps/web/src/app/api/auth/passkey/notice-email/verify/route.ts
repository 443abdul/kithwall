// /api/auth/passkey/notice-email/verify?token=… — confirms a notice address.
// GET only shows a confirm button (mail scanners that pre-fetch links must not confirm anything);
// the POST from that button confirms. The token is single use and expires after 24 hours.
import { admin } from '@/lib/auth/server';
import { sha256Hex } from '@/lib/auth/passkey-server';

export const dynamic = 'force-dynamic';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function page(title: string, body: string, form = false, status = 200): Response {
  // Static strings only (no user input is ever interpolated).
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#222;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#151515}}button{font:inherit;padding:.6em 1.2em;border-radius:.6em;border:0;background:#3b6;color:#fff;cursor:pointer}</style>
</head><body><h1>${title}</h1><p>${body}</p>${form ? '<form method="post"><button type="submit">Confirm this address</button></form>' : ''}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

function tokenOf(req: Request): string | null {
  const t = new URL(req.url).searchParams.get('token') ?? '';
  return TOKEN_RE.test(t) ? t : null;
}

export async function GET(req: Request) {
  if (!tokenOf(req)) return page('Link not valid', 'This confirmation link is not valid.', false, 400);
  return page('Confirm notice address', 'Kithwall will send content-free account notices to this address. Confirm?', true);
}

export async function POST(req: Request) {
  const token = tokenOf(req);
  if (!token) return page('Link not valid', 'This confirmation link is not valid.', false, 400);
  const db = admin();
  const now = new Date().toISOString();
  const { data: rows, error } = await db.from('notice_email_verifications').update({ used_at: now })
    .eq('token_hash', sha256Hex(token)).is('used_at', null).gt('expires_at', now).select('user_id, email');
  const row = rows?.[0];
  if (error || !row) return page('Link expired', 'This link has expired or was already used. Ask for a new one in Kithwall.', false, 410);
  const up = await db.from('account_security').upsert(
    { user_id: row.user_id, notice_email: row.email, notice_email_verified_at: now, updated_at: now },
    { onConflict: 'user_id' });
  if (up.error) {
    console.error('notice email confirm', up.error.message);
    return page('Something went wrong', 'Please try the link again in a minute.', false, 503);
  }
  // Older pending links for this account are no longer needed.
  await db.from('notice_email_verifications').delete().eq('user_id', row.user_id).is('used_at', null);
  return page('Address confirmed', 'Kithwall will send account notices here. You can close this tab.');
}
