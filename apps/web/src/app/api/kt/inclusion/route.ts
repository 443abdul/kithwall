// POST /api/kt/inclusion (Bearer) — are these people's CURRENT identity keys in the key-transparency log?
//   { size?: N, keys: [{ user, signPub, kxPub }, … up to 50] }
//   → { head, results: [{ user, status: 'ok', index, version, salt, proof } | { user, status: 'missing' | 'hidden' | 'later' }] }
// (docs/v2/09-key-transparency.md). The opening (salt, version, index) is what links a leaf of the public log
// to a person, so public.kt_inclusion runs AS THE CALLER and hands it out only for profiles the caller may
// see (kw.can_see_profile); everyone else is 'hidden'. POST so that who looks up whom never sits in a URL
// (request logs). Proofs are for the head returned here: `size` (a head the device already verified) or
// the latest.
import { asUser } from '@/lib/auth/server';
import { KT_MAX_BATCH } from '@/lib/kt/core';
import { ktReply, readHead } from '@/lib/kt/server';

export const dynamic = 'force-dynamic';

interface Body { size?: unknown; keys?: unknown }
interface Row { user_id: string; status: string; leaf_index: number | null; key_version: number | null; salt: string | null; proof: string[] | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;

export async function POST(req: Request) {
  const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(req.headers.get('authorization') ?? '');
  if (!m) return ktReply(401, { error: 'Please sign in again.' }, 'no-store', false);
  const text = await req.text();
  if (text.length > 16_384) return ktReply(413, { error: 'Too large.' }, 'no-store', false);
  let body: Body;
  try { body = JSON.parse(text) as Body; } catch { return ktReply(400, { error: 'Bad request.' }, 'no-store', false); }
  const size = body.size === undefined || body.size === null ? null : body.size;
  if (size !== null && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1)) {
    return ktReply(400, { error: 'Bad request.' }, 'no-store', false);
  }
  const keys = Array.isArray(body.keys) ? body.keys as { user?: unknown; signPub?: unknown; kxPub?: unknown }[] : null;
  if (!keys || !keys.length || keys.length > KT_MAX_BATCH
      || !keys.every((k) => k && typeof k === 'object' && typeof k.user === 'string' && UUID.test(k.user)
        && typeof k.signPub === 'string' && KEY.test(k.signPub) && typeof k.kxPub === 'string' && KEY.test(k.kxPub))) {
    return ktReply(400, { error: 'Bad request.' }, 'no-store', false);
  }
  try {
    const head = await readHead(size);
    if (!head || head.size === 0) return ktReply(400, { error: 'No such tree size.' }, 'no-store', false);
    const { data, error } = await asUser(m[1]!).rpc('kt_inclusion', {
      p_size: head.size,
      p_keys: keys.map((k) => ({ user: k.user, signPub: k.signPub, kxPub: k.kxPub })),
    });
    if (error) {
      if (error.code === '42501' || error.code === 'PGRST301' || error.code === 'PGRST303') return ktReply(401, { error: 'Please sign in again.' }, 'no-store', false);
      if (error.code === 'P0429') return ktReply(429, { error: 'Too many lookups. Try again later.' }, 'no-store', false);
      if (error.code === '22023') return ktReply(400, { error: 'Bad request.' }, 'no-store', false);
      throw new Error(error.message);
    }
    const results = ((data ?? []) as Row[]).map((r) => (r.status === 'ok'
      ? { user: r.user_id, status: 'ok', index: Number(r.leaf_index), version: Number(r.key_version), salt: r.salt, proof: r.proof ?? [] }
      : { user: r.user_id, status: r.status, ...(r.leaf_index !== null ? { index: Number(r.leaf_index) } : {}) }));
    return ktReply(200, { head, results }, 'private, no-store', false);
  } catch (e) {
    console.error('kt inclusion', e instanceof Error ? e.message : e);
    return ktReply(503, { error: 'The key log is unavailable.' }, 'no-store', false);
  }
}
