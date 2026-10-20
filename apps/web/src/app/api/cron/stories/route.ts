// GET /api/cron/stories — removes the encrypted storage objects of expired stories (photos). The
// database deletes expired story rows itself every 10 minutes (kw.story_maintenance); story media is
// unreadable to everyone but its owner from the moment the story expires, and this job then deletes
// the ciphertext from the bucket and forgets the media rows (supabase/migrations/20261022000300_stories.sql).
// Called by Vercel Cron with "Authorization: Bearer $CRON_SECRET" (see docs/deploy.md).
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
    const { data, error } = await db.rpc('expired_story_media', { max_rows: 500 });
    if (error) return json({ error: error.message }, 500);
    const paths = (data ?? []) as string[];
    if (!paths.length) break;
    for (let i = 0; i < paths.length; i += 100) {
      const part = paths.slice(i, i + 100);
      const rm = await db.storage.from('media').remove(part);
      if (rm.error) return json({ error: rm.error.message, removed }, 500);
      const fg = await db.rpc('forget_story_media', { paths: part });
      if (fg.error) return json({ error: fg.error.message, removed }, 500);
      removed += part.length;
    }
    if (paths.length < 500) break;
  }
  return json({ removed });
}
