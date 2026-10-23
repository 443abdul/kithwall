// GET /api/net/mirrors: the signed mirror list (docs/v2/08-censorship.md §2), exactly as produced by
// `node scripts/mirrors.mjs sign` and stored in the KITHWALL_MIRROR_LIST environment variable. It is
// public by design (it lists public addresses) and is only trusted by clients after its Ed25519 signature
// verifies against NEXT_PUBLIC_MIRROR_LIST_PUBKEY, so serving it from anywhere (every mirror, GitHub,
// IPFS) is safe. 404 when no list is configured.
export const dynamic = 'force-dynamic';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
};

export function GET() {
  const list = process.env.KITHWALL_MIRROR_LIST?.trim();
  if (!list) return new Response(JSON.stringify({ error: 'No mirror list is published here.' }), { status: 404, headers: { ...HEADERS, 'cache-control': 'no-store' } });
  return new Response(list, { status: 200, headers: HEADERS });
}
