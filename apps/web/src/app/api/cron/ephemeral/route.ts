// GET /api/cron/ephemeral — removes the encrypted storage objects of messages and posts that disappeared
// (expired, unsent or deleted). The database does the rest by itself every minute (kw.ephemeral_tick:
// expired rows, unsend tombstones, publishing scheduled posts); when a media row goes, its path waits in a
// private trash list and nobody can read the object any more (kw.can_read_media). This job deletes the
// ciphertext from the bucket and forgets the paths (supabase/migrations/20261024000100_ephemeral.sql).
// Called by Vercel Cron with "Authorization: Bearer $CRON_SECRET" (see docs/deploy.md), like /api/cron/stories.
import { timingSafeEqual } from 'node:crypto';
import { admin, json } from '@/lib/auth/server';

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
  const db = admin();
  let removed = 0;
  // A few rounds of up to 500 objects keep each run well inside maxDuration.
  for (let round = 0; round < 10; round++) {
    const { data, error } = await db.rpc('trashed_media', { max_rows: 500 });
    if (error) return json({ error: error.message }, 500);
    const paths = (data ?? []) as string[];
    if (!paths.length) break;
    for (let i = 0; i < paths.length; i += 100) {
      const part = paths.slice(i, i + 100);
      // Removing an object that is already gone (e.g. the sender's device removed it) is not an error.
      const rm = await db.storage.from('media').remove(part);
      if (rm.error) return json({ error: rm.error.message, removed }, 500);
      const fg = await db.rpc('forget_trashed_media', { paths: part });
      if (fg.error) return json({ error: fg.error.message, removed }, 500);
      removed += part.length;
    }
    if (paths.length < 500) break;
  }
  return json({ removed });
}
