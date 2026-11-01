// GET /api/kt/consistency?from=A&to=B — RFC 9162 consistency proof that the key log's tree of A entries is
// a prefix of its tree of B entries (A ≤ B), i.e. nothing was changed or removed in between, only appended
// (docs/v2/09-key-transparency.md). Public, like the head; any origin may ask.
//   → { from: head, to: head, proof: [base64url hash, …] }
// Verifiers check the proof against the roots THEY hold; the heads are included for convenience.
import { publicClient } from '@/lib/auth/server';
import { ktReply, readHead, sizeParam } from '@/lib/kt/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const from = sizeParam(q.get('from'));
  const to = sizeParam(q.get('to'));
  if (from === null || to === null || Number.isNaN(from) || Number.isNaN(to) || from > to) {
    return ktReply(400, { error: 'from and to must be positive integers with from <= to' }, 'no-store');
  }
  try {
    const [a, b, proof] = await Promise.all([
      readHead(from),
      readHead(to),
      publicClient().rpc('kt_consistency', { p_from: from, p_to: to }),
    ]);
    if (!a || !b || proof.error?.code === '22023') return ktReply(400, { error: 'no such tree size' }, 'no-store');
    if (proof.error) throw new Error(proof.error.message);
    // Both trees exist and never change, so neither does the proof.
    return ktReply(200, { from: a, to: b, proof: (proof.data ?? []) as string[] }, 'public, max-age=31536000, immutable');
  } catch (e) {
    console.error('kt consistency', e instanceof Error ? e.message : e);
    return ktReply(503, { error: 'the key log is unavailable' }, 'no-store');
  }
}
