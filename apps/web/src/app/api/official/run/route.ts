// POST /api/official/run — an admin starts the automated accounts' job now instead of waiting for the daily
// run (Admin → Official accounts → "Post now"). Same job, same rules (lib/official/run.ts): nothing is
// posted twice, and nothing runs without KITHWALL_OFFICIAL_SEED.
import { admin, callerFromRequest, json, needsMfa } from '@/lib/auth/server';
import { runOfficial } from '@/lib/official/run';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return json({ error: 'unauthorised' }, 401);
  if (needsMfa(caller)) return json({ error: 'mfa_required' }, 403);
  const { data } = await admin().from('staff_roles').select('role').eq('user_id', caller.user.id).maybeSingle();
  if (data?.role !== 'admin') return json({ error: 'forbidden' }, 403);
  try {
    return json(await runOfficial());
  } catch (e) {
    console.error('official accounts', e);
    return json({ error: 'failed' }, 500);
  }
}
