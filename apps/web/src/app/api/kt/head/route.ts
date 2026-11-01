// GET /api/kt/head[?size=N] — the key-transparency log's current tree head, or its head at size N
// (docs/v2/09-key-transparency.md). Public: devices, the GitHub witness and anyone auditing the log read it.
//   → { size, root, at }   root = base64url SHA-256 Merkle root (RFC 9162), at = time of the last entry
// No personal data; any origin may ask (CORS *). The latest head may be cached for a few seconds: devices
// accept an older head only with a proof that it is a prefix of the one they hold (lib/kt/client.ts).
import { ktReply, readHead, sizeParam } from '@/lib/kt/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const size = sizeParam(new URL(req.url).searchParams.get('size'));
  if (Number.isNaN(size)) return ktReply(400, { error: 'size must be a positive integer' }, 'no-store');
  try {
    const head = await readHead(size);
    if (!head) return ktReply(404, { error: 'no such tree size' }, 'no-store');
    // A past head never changes; the latest one moves with every sign-up and key change.
    return ktReply(200, head, size === null ? 'public, max-age=5' : 'public, max-age=31536000, immutable');
  } catch (e) {
    console.error('kt head', e instanceof Error ? e.message : e);
    return ktReply(503, { error: 'the key log is unavailable' }, 'no-store');
  }
}
