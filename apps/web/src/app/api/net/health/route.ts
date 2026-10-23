// GET /api/net/health: "this Kithwall origin answers" (docs/v2/08-censorship.md §2). Used by the web app
// (lib/net/runtime.ts) and the Android app (KithwallNet) to decide whether an origin is reachable before
// switching to a mirror. No database, no personal data, no cookies; any origin may ask (CORS *), since
// mirrors and the Android app check each other.
export const dynamic = 'force-dynamic';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
};

export function GET() {
  return new Response(JSON.stringify({ ok: true, app: 'kithwall', v: 1 }), { status: 200, headers: HEADERS });
}

export function HEAD() {
  return new Response(null, { status: 200, headers: HEADERS });
}
