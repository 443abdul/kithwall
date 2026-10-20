// POST /api/recovery/friends/cancel — { requestId } → cancels a pending trusted-friend recovery request
// from the device that started it (the request id is the capability). The owner's signed-in devices
// cancel through RLS instead (lib/recovery.ts cancelRequest).
import { admin, json, readJson } from '@/lib/auth/server';
import { fail } from '@/lib/auth/passkey-server';
import { tooMany } from '@/lib/auth/recovery-server';
import { UUID_RE, type FriendsStatusReq } from '@/lib/auth/recovery-shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (tooMany(req, 'recover-cancel', 30, 60 * 60_000)) return fail('rate_limited', 429, 'Too many requests.');
  const body = await readJson<FriendsStatusReq>(req, 512);
  const id = String(body?.requestId ?? '');
  if (!UUID_RE.test(id)) return fail('unknown', 400, 'Bad request.');
  try {
    const { error } = await admin().from('recovery_requests').update({ status: 'cancelled' }).eq('id', id).eq('status', 'pending');
    if (error) throw new Error(error.message);
    return json({ ok: true });
  } catch (e) {
    console.error('recovery friends cancel', e);
    return fail('network', 503, 'Please try again.');
  }
}
