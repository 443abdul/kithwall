// POST /api/recovery/friends/status — { requestId } → the request's state and the friends' sealed
// responses with each friend's public signing key. The request id (random, 122 bits) is the
// capability: only the device that started the request knows it. The responses are sealed to the
// request's ephemeral key, whose private half never leaves that device.
import { admin, json, readJson } from '@/lib/auth/server';
import { fail } from '@/lib/auth/passkey-server';
import { tooMany } from '@/lib/auth/recovery-server';
import { UUID_RE, type FriendsStatusReq, type FriendsStatusRes } from '@/lib/auth/recovery-shared';
import type { Sealed } from '@kithwall/crypto';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (await tooMany(req, 'recover-status', 240, 60 * 60_000)) return fail('rate_limited', 429, 'Too many requests. Please slow down.');
  const body = await readJson<FriendsStatusReq>(req, 512);
  const id = String(body?.requestId ?? '');
  if (!UUID_RE.test(id)) return fail('unknown', 400, 'Bad request.');
  try {
    const db = admin();
    const { data: r, error } = await db.from('recovery_requests').select('id, owner_id, eph_pub, status, not_before, expires_at').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!r) return fail('unknown', 404, 'This recovery request no longer exists.');
    const [{ data: shares }, { data: resp }] = await Promise.all([
      db.from('recovery_shares').select('threshold').eq('owner_id', r.owner_id),
      db.from('recovery_responses').select('trustee_id, sealed').eq('request_id', id),
    ]);
    const trustees = (resp ?? []).map((x) => x.trustee_id as string);
    const { data: keys } = trustees.length ? await db.from('profiles').select('id, sign_pub').in('id', trustees) : { data: [] };
    const signPub = new Map((keys ?? []).map((k) => [k.id as string, k.sign_pub as string]));
    const out: FriendsStatusRes = {
      status: r.status as FriendsStatusRes['status'],
      notBefore: r.not_before as string,
      expiresAt: r.expires_at as string,
      ephPub: r.eph_pub as string,
      threshold: shares?.length ? Math.min(...shares.map((s) => Number(s.threshold))) : 0,
      responses: (resp ?? []).filter((x) => signPub.has(x.trustee_id as string)).map((x) => ({
        trusteeId: x.trustee_id as string, signPub: signPub.get(x.trustee_id as string)!, sealed: x.sealed as Sealed,
      })),
    };
    return json(out);
  } catch (e) {
    console.error('recovery friends status', e);
    return fail('network', 503, 'Recovery is temporarily unavailable.');
  }
}
