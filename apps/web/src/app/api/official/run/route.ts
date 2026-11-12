// POST /api/official/run — an admin asks the automated accounts to post now (Admin → Official accounts →
// "Post now", for every source or for one). What is new goes out at once, whatever was posted earlier today;
// nothing is posted twice, and nothing runs without KITHWALL_OFFICIAL_SEED (lib/official/run.ts).
import { json, readJson } from '@/lib/auth/server';
import { adminCaller } from '@/lib/official/adminAuth';
import { runOfficial } from '@/lib/official/run';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const denied = await adminCaller(req);
  if (denied) return denied;
  // Optional: { "source": "<id>" } posts from that one source only.
  const body = await readJson<{ source?: unknown }>(req, 1024);
  const only = typeof body?.source === 'string' && /^[a-z0-9-]{2,40}$/.test(body.source) ? body.source : undefined;
  try {
    return json(await runOfficial({ manual: true, only }));
  } catch (e) {
    console.error('official accounts', e);
    return json({ error: 'failed' }, 500);
  }
}
