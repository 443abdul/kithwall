# 08 — Censorship and blocking resistance

Status: design + first implementation (everything that needs no new paid infrastructure is in the code,
**off until configured**). Owner decisions and purchases are listed in §10.

Kithwall's promise is that people can keep talking to the people they know. Governments and ISPs that want
to stop that block websites: Pakistan has blocked X (Feb 2024 – May 2025), Signal-style services and VPN
endpoints and throttles during protests; Iran, Russia and China use DNS poisoning, SNI filtering, IP
blocking, deep packet inspection (DPI), protocol whitelisting, throttling and full shutdowns. This document
is the threat model, the architecture that answers it, its costs, and what is already built.

End-to-end encryption is **not** affected by anything here: every route below only ever carries ciphertext
and routing metadata, exactly like today. What changes is *which hostnames and IPs* a censor has to block.

---

## 0. Where we are today (the problem)

The browser and the Android app need **all** of these to be reachable:

| Piece | Hostname / service | Transport |
|---|---|---|
| App pages, `/api/*` (sign-in, TURN credentials, link previews, push registration) | `www.kithwall.com` (+ `staging.kithwall.com`) on Vercel (anycast 76.76.21.x, no ECH) | HTTPS |
| Database REST, Auth, Storage (encrypted media) | `uvuojqziktbwxkjzeiar.supabase.co` (`NEXT_PUBLIC_SUPABASE_URL`, baked into the client) | HTTPS |
| Realtime (live updates, chat typing, call signalling) | same Supabase host | WebSocket (`wss://…/realtime/v1/websocket`) |
| Calls | Cloudflare TURN (`turn.cloudflare.com`), STUN | UDP/TCP 3478, TLS 5349/443 |
| Notifications | browser vendors' push services (FCM for Chrome/Android, Mozilla, Apple); FCM or UnifiedPush in the app | HTTPS / vendor sockets |
| Android app | loads the live site; bundled offline page only | — |

Blocking **either** `kithwall.com` **or** `*.supabase.co` breaks the app. Blocking `*.supabase.co` is
cheap for a censor and would also be collateral damage they may accept.

## 1. Threat model

| Adversary capability | Example | Effect on today's Kithwall | Answer (section) |
|---|---|---|---|
| DNS poisoning / NXDOMAIN at the ISP resolver | Pakistan, Iran, Russia, Indonesia | Site doesn't resolve | DoH/DoT in browsers and Android Private DNS (§3); mirrors (§2) |
| SNI filtering (DPI reads the TLS ClientHello hostname) | Pakistan WMS "firewall", Iran, China, Russia TSPU | Connections to `kithwall.com` / `supabase.co` reset | ECH behind Cloudflare (§3); many mirror domains (§2); Tor (§4) |
| IP blocking | All; Vercel and Supabase IP ranges are easy targets | Everything on those IPs dies | Cloudflare's shared IP space (§1, §3); VPS mirrors on fresh IPs (§2); Tor (§4) |
| Blocking a whole provider (`*.supabase.co`, Vercel ranges) | Plausible; Russia blocked large Cloudflare/Hetzner ranges during Telegram ban | Backend unreachable even when the site loads | Single origin: route all backend traffic through our own hostnames (§1) |
| Active probing / protocol fingerprinting | China, Iran, Russia | Proxies and VPNs found and blocked | Tor bridges (obfs4, Snowflake, WebTunnel) (§4); keep mirrors looking like ordinary HTTPS sites |
| Throttling | Pakistan during protests, Russia (Twitter 2021) | Slow, timeouts | Low-bandwidth mode exists (calls); failover timeouts tuned (6 s) |
| App store removal / site blocking of downloads | China, Russia (VPN apps) | No new installs or updates | APK on every mirror, GitHub Releases, F-Droid, signed fingerprints (§6) |
| Push provider blocked | FCM blocked in China, intermittently elsewhere | No notifications | UnifiedPush + self-hosted ntfy (§7) |
| Seizure / takedown of a domain | Registry or registrar pressure | Domain gone | Many domains at different registrars and TLDs; signed list rotates them (§2, §8) |
| Full shutdown (internet off, or national-intranet-only) | Pakistan (regional), Iran Nov 2019 / 2022, Myanmar | Nothing over the internet works | Honest UX; nothing already sent is lost (§5) |
| Malicious mirror / forged mirror list | Censor or scammer publishes fake "Kithwall mirror" | Phishing, malicious JS | Ed25519-signed list, rollback protection, CSP allow-list, published fingerprints (§2, §6) |
| Targeting individual users for using circumvention | Iran, Pakistan (VPN registration rules) | Legal risk to users | Calm, non-alarming UX; no telemetry; Tor option; operator guidance (§8) |

Out of scope: an adversary controlling the user's device, or compelling Vercel/Supabase/Cloudflare (that
is covered by end-to-end encryption, docs/03-spec.md); mesh networking; SMS gateways.

## 2. Architecture overview

```
                       ┌────────────── signed mirror list (Ed25519, offline key) ──────────────┐
                       │  served from every mirror /api/net/mirrors, GitHub raw, IPFS, QR/text  │
                       └────────────────────────────────────────────────────────────────────────┘
 browser / app ──► www.kithwall.com  (Vercel; later behind Cloudflare)           ──► Vercel (Next.js)
     │         ──► mirror-1.example  (Cloudflare Worker, ECH, shared IPs)  /sb/* ──► Supabase (REST/Auth/Storage/Realtime)
     │         ──► mirror-2.example  (VPS + Caddy, fresh IP)               /*    ──► Vercel
     │         ──► xxxxx.onion       (VPS + tor + Caddy)
     └─ "Use Tor (Orbot)" in the Android app, Tor Browser on desktop
```

### 2.1 Single origin (route ALL client traffic through our own hostnames)

Goal: one reachable hostname is enough. The browser should never need `*.supabase.co` directly.

| Option | REST/Auth/Storage | Realtime WebSocket | Cost | Pros | Cons |
|---|---|---|---|---|---|
| **A. Vercel rewrite** `/sb/* → supabase` (built: `KITHWALL_SB_REWRITE=1`) | ✔ | ✘ (Vercel rewrites can't proxy WebSockets) | Vercel bandwidth only | No new infra; works today | Realtime still needs supabase.co (app works without live updates, slower); large uploads count toward Vercel bandwidth; Vercel IPs still blockable |
| **B. Cloudflare Worker** (built: `infra/cloudflare-worker/`) | ✔ | ✔ (Workers proxy the 101 upgrade) | Free ≤100k req/day; $5/mo paid | Cloudflare's huge shared IP space, ECH, one Worker serves many domains, near-zero ops | Cloudflare terminates TLS (sees metadata, not content); Cloudflare IP ranges are sometimes blocked wholesale (Russia 2024–25 throttled them) |
| **C. Small VPS with Caddy/nginx** (built: `infra/proxy/`) | ✔ | ✔ | €4–6/mo | Independent of Cloudflare; can be moved to fresh IPs; same box can run onion + ntfy + coturn | Ops burden (updates); single IP easy to block once found |
| **D. Supabase custom domain add-on** (`api.kithwall.com`) | ✔ | ✔ | $10/mo (needs a paid Supabase plan) | Official, no proxy code | Only one hostname, still Supabase's IPs, no ECH, removes `supabase.co` from the client but not the IP-block risk |

**Recommendation:** B on every mirror domain (cheap, ECH, shared IPs), C on one VPS as the
Cloudflare-independent fallback (also hosting the onion service). A is a free stop-gap. D only if the owner
wants `api.kithwall.com` for neatness — it doesn't add censorship resistance beyond B.

How the client uses it (implemented, `apps/web/src/lib/net/`): the Supabase client is still created with the
real `NEXT_PUBLIC_SUPABASE_URL` (so the session storage key never changes and nobody is signed out), and a
custom `fetch` + Realtime `transport` rewrite `https://<project>.supabase.co/…` onto the current route's
`apiBase` / `realtimeBase` at send time. `NEXT_PUBLIC_API_BASE=/sb` means "this page's own origin + /sb",
so one build serves every mirror. Direct `fetch`es to Supabase (media up/download, Realtime HTTP broadcast)
go through `netUrl()`. With no configuration the rewrite is not installed at all.

Caveat: through a proxy, Supabase sees the proxy's IP, not the user's, so Supabase Auth's per-IP rate limits
apply to the proxy. Kithwall's sign-in runs through its own `/api/auth/*` routes (server-to-server), so the
impact is small; watch Auth rate-limit errors after switching.

### 2.2 Mirror domains and rotation

* **Mirrors** are extra registrable domains (different TLDs and registrars: e.g. a `.org`, a `.net`, a
  ccTLD that isn't the censor's) that serve the same app via the Worker (B) or a VPS (C). A subdomain of
  `kithwall.com` doesn't help: SNI/DNS filters block the whole registrable domain.
* **Signed mirror list** (implemented): JSON `{ "kithwall-mirrors": 1, "body": "<payload>", "sig": "…" }`,
  Ed25519 over `"kithwall/mirror-list/v1\n" + body` (`packages/crypto/src/signed.ts`). Payload: `format`,
  monotonically increasing `version`, `issued`, `expires`, `mirrors[] {origin, api, realtime, kind, label}`,
  `apk[] {url, sha256}`, `apkCert`, `note`. The public key is built into the app
  (`NEXT_PUBLIC_MIRROR_LIST_PUBKEY`); the private key stays **offline** with the owner
  (`apps/web/scripts/mirrors.mjs keygen|sign|verify`). Clients reject bad signatures, expired lists, lists
  "issued" in the future (>24 h skew) and **rollback** to a version older than the newest they have seen
  (a censor replaying an old list full of seized domains). Bad entries (plain http, credentials, junk) are
  dropped. The verified list is cached in `localStorage` and re-verified on every load.
* **Where the list lives:** `KITHWALL_MIRROR_LIST` env on every deployment → `/api/net/mirrors` (CORS `*`),
  GitHub raw (`raw.githubusercontent.com` is itself often reachable), an IPFS CID pinned on a free pinning
  service, and optionally a DNS TXT record (`_kwm.kithwall.com` with the `kwm1.` token split into 255-byte
  strings; browsers can't read TXT records directly, so this is for the Android app / tooling later).
  Fetch locations are `NEXT_PUBLIC_MIRROR_LIST_URLS` (must be in CSP, which the code does automatically).
* **Failover** (implemented, web): routes are ordered (onion's own `/sb` on an onion page → configured
  primary → `NEXT_PUBLIC_API_ALTERNATES` → build-time mirrors' `/sb` → signed-list mirrors with a proxy →
  Supabase direct). A network error on a Supabase request, the `online` event, and a 5-minute timer while
  rerouted trigger a parallel health check (`<apiBase>/auth/v1/health`, JSON required — a censor's block
  page answers 200 HTML); the first working route wins, GETs are retried once, other methods are not
  (they may have reached the server). The page origin is checked through `/api/net/health`. Banner:
  "Connected through a mirror" or "Kithwall seems blocked here — try these options" → `/help/blocked`.
  The web app never silently navigates to another origin: sign-in, keys and storage are per-origin, so the
  person chooses ("Open" in the mirror list).
* **Failover** (implemented, Android): `KwNet.java` keeps built-in fallback origins
  (`KITHWALL_FALLBACK_ORIGINS` at `cap sync`) plus mirrors learned from the verified list. On a
  connection error it health-checks `/api/net/health` on each (primary first), switches the start URL
  and recreates the activity; the next launch returns to the primary once it answers.
* **How people learn new mirrors:** in-app (Settings → Connection, `/help/blocked`, the banner), as text
  (`shareText`: addresses one per line + the `kwm1.` token, fits a few SMS), as a QR code of the token, and
  by pasting a token someone sent ("Add a list someone sent you", verified before use). Owner channels: the
  project's GitHub README, social accounts, a mailing list (operator-side, out of band).
* **Same-origin caveat — passkeys:** a passkey is bound to its RP ID (`kithwall.com`). On a mirror domain
  (or the onion) it cannot be used; WebAuthn *Related Origin Requests* would need the browser to fetch
  `https://kithwall.com/.well-known/webauthn`, which is exactly what's blocked. People sign in on mirrors
  with **passphrase or recovery key** (the UI says so). Each origin also has its own local session and
  unlocked keys.

## 3. SNI and DNS evasion

* **DoH / DoT:** Chrome, Edge, Firefox and Safari use encrypted DNS when the system/provider supports it;
  Android 9+ has Private DNS (DoT). Defeats DNS poisoning only — the hostname is still visible in SNI and
  the IP can be blocked. Help text recommends it implicitly via "trusted VPN / Tor"; we don't ship a DoH
  resolver (no third party should see users' lookups by our choice).
* **Encrypted Client Hello (ECH):** hides the real SNI behind a public name (`cloudflare-ech.com`). Needs
  the server side to support it: **Cloudflare** enables ECH for proxied zones (Free plan included) and
  Chrome/Firefox use it when DNS returns the HTTPS record (requires DoH in the browser). **Vercel does not
  offer ECH**, so `www.kithwall.com` directly on Vercel always exposes its SNI; putting mirrors (and
  eventually the main domain) behind Cloudflare is the only no-code way to get ECH. Limits: Russia blocks
  ECH-to-Cloudflare connections outright (Nov 2024), Iran and China also interfere; ECH buys time in
  countries that filter by SNI but don't block Cloudflare wholesale (Pakistan's current posture).
* **Domain fronting:** effectively dead — Google, AWS CloudFront, Azure and Fastly reject Host/SNI
  mismatches; Cloudflare refuses cross-account fronting. Not pursued. (ECH is its modern, legitimate
  successor; meek-style fronting survives only inside Tor's bridge ecosystem.)

## 4. Tor

* **Onion service** (config ready in `infra/onion/`): a €4–6/month VPS runs `tor` + Caddy; Caddy proxies
  `/sb/*` to Supabase and everything else to Vercel, adding `X-Kithwall-Onion: 1`. With
  `NEXT_PUBLIC_ONION_ORIGIN` set, every page sends `Onion-Location` (Tor Browser offers the onion), Help and
  Settings show the address, and on the onion the app routes Supabase through the onion's own `/sb`, so
  traffic never leaves Tor. The onion is served over plain http (Tor provides the encryption); the CSP
  drops `upgrade-insecure-requests` there. Passkeys don't work on the onion (different RP ID): passphrase
  sign-in. An HTTPS onion certificate (HARICA, ~€30/yr) is optional.
* **Tor Browser guidance** (in `/help/blocked`): Tor Browser on desktop/Android, Onion Browser on iOS.
* **Android "Use Tor (Orbot)"** (implemented): Settings → Connection shows a switch in the app. It uses
  `androidx.webkit.ProxyController` to send the WebView through Orbot's HTTP proxy `127.0.0.1:8118`
  (hostnames resolved by Tor: no DNS leak), detects whether Orbot is installed (`<queries>`) and running,
  and can ask Orbot to start. The proxy is applied **before** the first page load. Limits: WebRTC media
  (calls) does not use the proxy, so calls reveal the IP to the TURN server/peer (the UI says calls don't go
  through Tor); native push (FCM/UnifiedPush) is outside the WebView.
* **Embedded tor (tor-android / Arti):** adds ~10–25 MB per ABI, needs regular security updates, and
  makes the app itself a circumvention tool (store-policy and legal exposure). Deferred; Orbot keeps that
  maintenance with the Tor Project.
* **When Tor is blocked:** bridges — Snowflake (WebRTC, works in Iran/Russia most of the time), obfs4,
  WebTunnel; built into Tor Browser and Orbot. Help text tells people where to switch them on.

## 5. Full shutdowns

When the internet (or international links) are cut, **no** internet service works — Kithwall, Signal or a
VPN. Honest UX (implemented in `/help/blocked`): nothing already sent is lost (it waits, encrypted, on the
server); agree on another way to reach people beforehand. Proposed, not built:

* an **offline app shell**: the service worker currently caches nothing by design (`public/sw.js`). A
  shell cache limited to `/_next/static/*` + an offline route (never user data) would let the app open and
  show what's in memory/IndexedDB. Needs a careful privacy review.
* a **queued outbox**: drafts sealed with the user's keys in IndexedDB, clearly labelled "will send when
  you're back online", sent on reconnect.
* Mesh (Briar-style Bluetooth/Wi-Fi Direct) and SMS fallbacks are out of scope; national-intranet-only
  shutdowns (Iran's NIN) can only be served from servers inside that country, which we won't run.

## 6. App distribution when stores and sites are blocked

* **APK on every mirror** (`NEXT_PUBLIC_APK_URLS`, and `apk[]` in the signed list) + **GitHub Releases**
  (linked automatically) + **F-Droid** (the `foss` flavour already has no Google libraries;
  `dependenciesInfo` is off for reproducibility).
* **Reproducible builds:** pin the toolchain (JDK 21 Temurin, Gradle wrapper, Android SDK build-tools) in
  CI, `SOURCE_DATE_EPOCH`, no build timestamps; F-Droid verifies reproducibility for the foss flavour.
* **Signature fingerprint:** publish the release certificate's SHA-256 (`NEXT_PUBLIC_APK_CERT_SHA256` and
  `apkCert` in the signed list); Settings and Help show it. Users check with *AppVerifier* or
  `apksigner verify --print-certs`. The same fingerprint is already in `ANDROID_CERT_SHA256` for passkeys.

## 7. Calls and push under censorship

* **TURN:** Cloudflare TURN offers TLS on 443 (`turns:turn.cloudflare.com:443`), which survives most
  port-based filtering and benefits from Cloudflare's shared IPs. If it's blocked: a coturn on the VPS with
  `turns:` on 443 under a mirror domain (needs its own IP or an SNI multiplexer, since Caddy also wants 443).
  `turnRoute` in `endpoints()` is the hook to choose per route.
* **Push:** FCM (`fcm.googleapis.com`) and browser push services may be blocked (China always). The
  **foss** Android flavour already uses **UnifiedPush**: people pick a distributor (ntfy). Recommended: a
  self-hosted **ntfy** on the VPS under a mirror domain (no extra cost), so push survives an FCM block.
  Web Push in browsers can't change provider (the browser picks it).

## 8. Operations, legal and safety

* **Monitoring:** OONI Explorer (`explorer.ooni.org`) — search each domain for PK/IR/RU/CN/TR measurements
  monthly and after incidents; ask trusted users to run OONI Probe's Web Connectivity test with the
  mirror URLs. Optionally a free external checker (e.g. a GitHub Action calling OONI's API for the domains).
  Never add analytics to "detect" blocking: the app reports nothing.
* **Rotation:** keep 2–3 mirrors live and 1–2 *unpublished* spares (registered, configured, not yet in the
  list). When one is blocked: remove it, publish a spare, bump `version`, sign, update
  `KITHWALL_MIRROR_LIST` everywhere, post the new `kwm1.` token. Lists expire (90 days suggested) so stale
  ones fade out; re-sign before expiry.
* **Key custody:** the mirror-list private key and the onion key are as sensitive as the app signing key:
  offline, backed up on paper, never in CI/Vercel. Losing the mirror key = shipping a new build with a new
  public key; leaking it = an attacker can redirect clients (they still can't read messages, but could serve
  a malicious app on their "mirror": that's why CSP only allows build-time configured origins for fetches,
  and why mirrors are opened by the person, not silently).
* **Legal/safety for the operator:** running mirrors and onion services is legal in most jurisdictions where
  the operator lives, but registrars/hosters in some countries comply with takedowns: prefer registrars and
  hosts outside the censoring countries, use privacy/whois protection, and don't use the operator's
  personal identity on mirror domains. Don't publish user-identifying information to "prove" reach. For
  users: some countries penalise VPN/Tor use; the app's wording is calm and never encourages illegal acts.

## 9. Implemented now (no new infrastructure; all off until configured)

| Piece | Where |
|---|---|
| Config (env vars, all optional) | `apps/web/src/lib/net/config.ts` |
| Endpoint resolver `endpoints()` → `{appOrigin, apiBase, realtimeBase, storageBase, turnRoute, alternates}` | `lib/net/endpoints.ts`, `lib/net/runtime.ts` |
| Supabase client wiring (identical when unconfigured) | `lib/supabase.ts` (+ `netUrl()` in `media.ts`, `calls/engine.ts`, `chat/signals.ts`) |
| Signed mirror list (Ed25519 via `@kithwall/crypto`), cache, rollback protection | `lib/net/mirrors.ts`, `packages/crypto/src/signed.ts` |
| Key/sign/verify tool | `apps/web/scripts/mirrors.mjs` |
| Health + list endpoints | `/api/net/health`, `/api/net/mirrors` |
| Failover + banner | `lib/net/runtime.ts`, `components/net/NetRuntime.tsx`, `NetBanner.tsx` |
| Help page + Settings → Connection | `/help/blocked`, `/you/settings/connection` (`components/net/*`), `net.*` i18n keys in 12 locales |
| CSP: configured origins only; Onion-Location; onion without upgrade-insecure-requests | `src/proxy.ts`, `lib/net/csp.ts` |
| Optional Vercel `/sb` rewrite | `next.config.ts` (`KITHWALL_SB_REWRITE=1`) |
| Cloudflare Worker, Caddy/nginx mirror, onion (torrc + Caddy) | `infra/` |
| Android: Orbot proxy, fallback origins, `KithwallNet` plugin | `apps/mobile/android/.../KwNet.java`, `KithwallNetPlugin.java`, `capacitor.config.ts` |
| Tests | `lib/net/*.test.ts`, `packages/crypto/test/signed.test.ts` |

Environment variables (Vercel, build-time unless noted):

```
NEXT_PUBLIC_API_BASE=/sb                         # single origin for REST/Auth/Storage (needs a proxy at /sb)
NEXT_PUBLIC_REALTIME_BASE=/sb                    # or wss://rt.example.org — needs Worker/VPS (not Vercel)
NEXT_PUBLIC_API_ALTERNATES=https://api2.example  # extra REST bases to try
NEXT_PUBLIC_MIRROR_ORIGINS=https://m1.example,https://m2.example
NEXT_PUBLIC_MIRROR_LIST_PUBKEY=<base64url>       # from scripts/mirrors.mjs keygen
NEXT_PUBLIC_MIRROR_LIST_URLS=https://raw.githubusercontent.com/…/mirrors.json   # default /api/net/mirrors
KITHWALL_MIRROR_LIST=<signed JSON>               # runtime; served at /api/net/mirrors
NEXT_PUBLIC_ONION_ORIGIN=http://<56>.onion
NEXT_PUBLIC_APK_URLS=https://m1.example/kithwall.apk
NEXT_PUBLIC_APK_CERT_SHA256=AB:CD:…
KITHWALL_SB_REWRITE=1                            # Vercel forwards /sb/* to Supabase (HTTP only)
KITHWALL_FALLBACK_ORIGINS=https://m1.example     # Android, at `npx cap sync`
```

## 10. Recommended phased plan, costs, and owner actions

| Phase | What | Monthly cost | Owner must |
|---|---|---|---|
| **0 — now (free)** | Generate the mirror-list key; publish an (empty-ish) signed list; turn on `KITHWALL_SB_REWRITE=1` + `NEXT_PUBLIC_API_BASE=/sb` so REST/Auth/Storage stop needing `supabase.co`; publish the APK fingerprint; enable GitHub Releases for APKs | $0 | Run `node apps/web/scripts/mirrors.mjs keygen --out <offline path>`; set `NEXT_PUBLIC_MIRROR_LIST_PUBKEY`, `KITHWALL_MIRROR_LIST`, `KITHWALL_SB_REWRITE`, `NEXT_PUBLIC_API_BASE`, `NEXT_PUBLIC_APK_CERT_SHA256` in Vercel; decide on the realtime trade-off (live updates still direct until phase 1) |
| **1 — Cloudflare mirrors** | Buy 2–3 domains (different TLDs/registrars), put them on Cloudflare Free, deploy the Worker (all traffic incl. Realtime), list them in `NEXT_PUBLIC_MIRROR_ORIGINS` + the signed list; build the Android app with `KITHWALL_FALLBACK_ORIGINS` | domains ≈ $3–4 (≈$12–15/yr each); Worker $0 (≤100k req/day) or $5 | Buy domains; create Cloudflare account; `wrangler deploy`; keep 1 spare domain unpublished |
| **2 — independent VPS** | One €4–6 VPS (Hetzner/OVH/etc., outside censoring countries): onion service (`infra/onion`), Caddy mirror on a fresh IP (`infra/proxy`), self-hosted ntfy for UnifiedPush, optional coturn on 443 | €4–6 | Rent VPS; install tor + Caddy; back up the onion key offline; set `NEXT_PUBLIC_ONION_ORIGIN`; monthly `apt upgrade` |
| **3 — main domain behind Cloudflare** | Move `kithwall.com` DNS to Cloudflare (proxied, ECH) in front of Vercel, so even the main domain gets ECH/shared IPs; set `NEXT_PUBLIC_REALTIME_BASE=/sb` | $0–5 | Change nameservers; configure Vercel ↔ Cloudflare (Full (strict) TLS) |
| **4 — distribution** | F-Droid submission (foss flavour), reproducible-build CI check, IPFS copy of list + APK | $0 | Submit F-Droid metadata; pin an IPFS CID |
| Optional | Supabase custom domain (`api.kithwall.com`) | +$10 (paid Supabase plan) | Only if wanted; not needed for resistance |

**Typical total:** ≈ **€10–15/month** (3 domains + one VPS, Cloudflare Free, Worker free tier) — under
€20 with Workers Paid.

## 11. Known gaps

* Realtime cannot go through Vercel; until the Worker/VPS exists, live updates still need `supabase.co`
  (the app keeps working, just without instant updates).
* The web app doesn't auto-move to another origin (by design: per-origin sign-in/keys); people choose.
* Mirrors learned only from the signed list (not build-time) can't be health-checked from the page,
  because CSP `connect-src` is fixed per build; they're shown as links. The Android app checks them natively.
* No offline shell or outbox yet (§5); no embedded tor (§4); TURN fallback (coturn) not configured (§7).
* iOS: no Orbot equivalent integration (Onion Browser / Orbot iOS VPN mode works system-wide).
