# Kithwall mirror Worker

Ready to deploy, **not deployed**. Design and trade-offs: [docs/v2/08-censorship.md](../../docs/v2/08-censorship.md) §1–3.

1. Buy a mirror domain (any registrar), add it to Cloudflare (Free plan), switch to Cloudflare's nameservers.
2. DNS: add `AAAA @ → 100::` (a placeholder; the Worker answers), **Proxied** (orange cloud).
3. SSL/TLS → Edge Certificates: *Always Use HTTPS* on, minimum TLS 1.2, TLS 1.3 on. Check that
   *Encrypted ClientHello (ECH)* is enabled for the zone.
4. Edit `wrangler.toml` (`MIRROR_HOSTS`, `[[routes]]`), then `npx wrangler login && npx wrangler deploy`.
5. In Vercel (build environment), then redeploy:
   - list the mirror in `NEXT_PUBLIC_MIRROR_ORIGINS=https://mirror-one.example` (build-time mirror: allowed in
     CSP, health-checked, its `/sb` proxy used for failover), and/or publish it in the signed list
     (`apps/web/scripts/mirrors.mjs`);
   - only if www.kithwall.com itself is put behind this Worker: `NEXT_PUBLIC_API_BASE=/sb` and
     `NEXT_PUBLIC_REALTIME_BASE=/sb` (single origin).
6. Check: `curl https://mirror-one.example/api/net/health` → `{"ok":true,...}` and
   `curl -H "apikey: <publishable key>" https://mirror-one.example/sb/auth/v1/health`.

Free plan: 100,000 requests/day. Workers Paid: US$5/month for 10 M requests. A WebSocket counts as one request.
The Worker strips the visitor's IP before forwarding (Supabase sees Cloudflare's address), keeps no logs,
and never sees message content (end-to-end encrypted in the browser).
