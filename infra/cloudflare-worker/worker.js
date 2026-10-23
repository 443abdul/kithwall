// Kithwall mirror / single-origin proxy for Cloudflare Workers (docs/v2/08-censorship.md §1–3).
// NOT deployed by anything in this repository: the owner deploys it with `npx wrangler deploy` after
// filling in wrangler.toml (see README.md next to this file).
//
// One Worker serves any number of mirror domains:
//   https://<mirror>/sb/*        → SUPABASE_URL/*  (REST, Auth, Storage, Realtime HTTP + WebSocket)
//   https://<mirror>/*           → APP_ORIGIN/*    (the Next.js app on Vercel)
// so a browser only ever needs to reach the mirror's hostname, which sits on Cloudflare's shared IP space
// (with Encrypted Client Hello on Cloudflare's side, the SNI a censor sees is cloudflare-ech.com).
//
// What this Worker can see: it terminates TLS, so Cloudflare (and anyone with the Worker's account) sees
// request metadata (paths, timing, sizes, IPs) like Vercel and Supabase already do. Message and media
// CONTENT is end-to-end encrypted in the browser and stays unreadable here. Nothing is logged by this code;
// leave Workers Logs / Logpush OFF for this Worker.
//
// Environment (wrangler.toml [vars]):
//   SUPABASE_URL   https://<project>.supabase.co
//   APP_ORIGIN     https://www.kithwall.com          (where the Next.js app really runs)
//   MIRROR_HOSTS   comma-separated hostnames this Worker answers for (anything else → 404)

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding'];
// Never forwarded upstream: the visitor's IP and Cloudflare's tracing headers.
const STRIP_UP = ['cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-real-ip', 'true-client-ip', 'cookie'];

function cleanHeaders(h, extraStrip = []) {
  const out = new Headers(h);
  for (const k of [...HOP_BY_HOP, ...STRIP_UP, ...extraStrip]) out.delete(k);
  return out;
}

export default {
  /** @param {Request} request @param {{SUPABASE_URL:string, APP_ORIGIN:string, MIRROR_HOSTS:string}} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    const hosts = (env.MIRROR_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!hosts.includes(url.hostname.toLowerCase())) return new Response('Not found', { status: 404 });

    // ---- Supabase: /sb/... → <project>.supabase.co/...
    if (url.pathname === '/sb' || url.pathname.startsWith('/sb/')) {
      const target = new URL(env.SUPABASE_URL);
      target.pathname = url.pathname.slice(3) || '/';
      target.search = url.search;
      const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
      const headers = cleanHeaders(request.headers, upgrade ? [] : ['upgrade']);
      if (upgrade) headers.set('upgrade', 'websocket');
      headers.set('host', target.host);
      // Realtime WebSocket: Workers proxy the upgrade when the 101 response is returned as is.
      const res = await fetch(target.toString(), {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual',
      });
      if (upgrade) return res;
      const out = new Response(res.body, res);
      out.headers.delete('set-cookie');
      return out;
    }

    // ---- the app itself
    const target = new URL(env.APP_ORIGIN);
    target.pathname = url.pathname;
    target.search = url.search;
    const headers = cleanHeaders(request.headers);
    headers.set('host', target.host);
    // Tells the app which public hostname the visitor used (for absolute links); not trusted for anything.
    headers.set('x-forwarded-host', url.host);
    const res = await fetch(target.toString(), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
    const out = new Response(res.body, res);
    // Redirects from the app point at APP_ORIGIN: keep the visitor on the mirror.
    const loc = out.headers.get('location');
    if (loc && loc.startsWith(env.APP_ORIGIN)) out.headers.set('location', `https://${url.host}${loc.slice(env.APP_ORIGIN.length)}`);
    // Mirrors must not pin HSTS for subdomains they don't control, and don't advertise the main site.
    out.headers.set('strict-transport-security', 'max-age=31536000');
    return out;
  },
};
