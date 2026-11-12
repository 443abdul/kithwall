// GET /api/cron/official — Kithwall's automated accounts post what is new in the public feeds the operator
// switched on (docs/v2/13-official-accounts.md, lib/official/run.ts). Once a day; the posts are spread over
// the day with publish_at. Does nothing until KITHWALL_OFFICIAL_SEED is set.
// Called by Vercel Cron with "Authorization: Bearer $CRON_SECRET" (see docs/deploy.md).
import { timingSafeEqual } from 'node:crypto';
import { json } from '@/lib/auth/server';
import { runOfficial } from '@/lib/official/run';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? '';
  if (secret.length < 16) return false;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request) {
  if (!authorised(req)) return json({ error: 'unauthorised' }, 401);
  try {
    return json(await runOfficial());
  } catch (e) {
    console.error('official accounts', e);
    return json({ error: 'failed' }, 500);
  }
}
