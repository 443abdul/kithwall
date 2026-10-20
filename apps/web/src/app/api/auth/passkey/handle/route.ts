// GET /api/auth/passkey/handle?h=<handle> — is this @handle free? { problem: null | 'invalid' | 'reserved' | 'taken' }
// Handles are public profile names, so availability is not secret; the endpoint is rate-limited
// per client anyway so it can't be used to bulk-download the directory.
import { json } from '@/lib/auth/server';
import { fail, ipTag } from '@/lib/auth/passkey-server';
import { handleShapeProblem, normalizeHandle } from '@/lib/auth/passkey-shared';
import { handleTaken } from '@/lib/auth/passkey-server';

export const dynamic = 'force-dynamic';

// In-memory per-instance limiter (cheap; the expensive ceremonies are limited in the database).
const hits = new Map<string, { n: number; reset: number }>();
const MAX = 120, WINDOW_MS = 60_000;

export async function GET(req: Request) {
  const tag = ipTag(req);
  const now = Date.now();
  const h = hits.get(tag);
  if (!h || h.reset < now) hits.set(tag, { n: 1, reset: now + WINDOW_MS });
  else if (++h.n > MAX) return fail('rate_limited', 429, 'Too many requests. Please wait a minute.');
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);

  const handle = normalizeHandle(new URL(req.url).searchParams.get('h') ?? '');
  const shape = handleShapeProblem(handle);
  if (shape) return json({ problem: shape });
  try {
    return json({ problem: (await handleTaken(handle)) ? 'taken' : null });
  } catch (e) {
    console.error('handle check', e);
    return fail('network', 503, 'Please try again.');
  }
}
