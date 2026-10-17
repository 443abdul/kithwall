// GET /api/cron/account-deletions — carries out scheduled deletions whose 72-hour wait is over
// (storage folder + auth user). Called by Vercel Cron with "Authorization: Bearer $CRON_SECRET"
// (see docs/deploy.md). A database job (kw.auth_maintenance) is the backstop if this never runs.
import { timingSafeEqual } from 'node:crypto';
import { admin, deleteAccountNow, json } from '@/lib/auth/server';

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
  const { data, error } = await admin().rpc('due_account_deletions', { max_rows: 25 });
  if (error) return json({ error: error.message }, 500);
  const ids = (data ?? []) as string[];
  let deleted = 0;
  const failed: string[] = [];
  for (const id of ids) {
    try { await deleteAccountNow(id); deleted++; } catch (e) { console.error('scheduled deletion', id, e); failed.push(id); }
  }
  return json({ due: ids.length, deleted, failed: failed.length });
}
