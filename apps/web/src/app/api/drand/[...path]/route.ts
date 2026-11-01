// GET /api/drand/<chain hash>/(info | public/latest | public/<round>): a relay for drand's public randomness
// beacons, used by time capsules (lib/social/capsule.ts, tlock timelock encryption).
//
// - Beacons are public, and every one is verified on the device against the drand quicknet chain's pinned
//   public key, so this relay can't forge or alter anything; it can only fail to answer.
// - It exists so time capsules keep opening where api.drand.sh is blocked (the app's mirrors carry this
//   route too), and so people's devices don't contact a third party directly (their IP addresses stay here).
// - Only the one chain time capsules use, and only those three paths. Nothing is logged.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const UPSTREAMS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com'];

function reply(status: number, body: string, cache: string) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'x-content-type-options': 'nosniff' },
  });
}

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const parts = (await ctx.params).path ?? [];
  const [chain, ...rest] = parts;
  const path = rest.join('/');
  if (chain !== CHAIN || !/^(info|public\/latest|public\/\d{1,12})$/.test(path)) return reply(404, '{"error":"not found"}', 'no-store');
  // A past round never changes: cache it for good. "latest" and info change rarely or not at all.
  const cache = path === 'public/latest' ? 'public, max-age=2' : 'public, max-age=31536000, immutable';
  for (const base of UPSTREAMS) {
    try {
      const res = await fetch(`${base}/${CHAIN}/${path}`, { cache: path === 'public/latest' ? 'no-store' : 'force-cache', signal: AbortSignal.timeout(3500) });
      if (res.status === 404 || res.status === 425) return reply(404, '{"error":"round not reached yet"}', 'public, max-age=3');
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > 4096) continue;
      return reply(200, text, cache);
    } catch { /* next upstream */ }
  }
  return reply(502, '{"error":"drand unreachable"}', 'no-store');
}
