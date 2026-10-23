// Censorship resistance (docs/v2/08-censorship.md): build-time network configuration.
//
// Everything here is OFF until the owner sets it. With none of these variables set the app behaves
// exactly as before: the browser talks to NEXT_PUBLIC_SUPABASE_URL directly and nothing else changes
// (no extra requests, no extra CSP origins, no banner).
//
//   NEXT_PUBLIC_API_BASE            REST/Auth/Storage base instead of the Supabase URL. Absolute
//                                   (https://api.example.org) or a path on the page's own origin ("/sb":
//                                   every mirror domain proxies its own /sb, see infra/).
//   NEXT_PUBLIC_REALTIME_BASE       Realtime (WebSocket) base. Absolute (wss://rt.example.org) or a path
//                                   ("/sb"). Defaults to the Supabase URL: Vercel rewrites can't carry
//                                   WebSockets, so a path here needs the Cloudflare Worker / Caddy proxy.
//   NEXT_PUBLIC_API_ALTERNATES      Extra REST bases tried in order when the current one fails
//                                   (comma-separated; same syntax as NEXT_PUBLIC_API_BASE).
//   NEXT_PUBLIC_MIRROR_ORIGINS      Mirror origins known at build time (comma-separated https origins).
//                                   They are allowed in connect-src so the app can health-check them and
//                                   use their /sb proxy without leaving the page.
//   NEXT_PUBLIC_MIRROR_LIST_PUBKEY  Ed25519 public key (base64url, 32 bytes) the signed mirror list must
//                                   verify against (scripts/mirrors.mjs keygen).
//   NEXT_PUBLIC_MIRROR_LIST_URLS    Where to fetch the signed list (comma-separated). Default when the key
//                                   is set: this origin's /api/net/mirrors.
//   NEXT_PUBLIC_ONION_ORIGIN        http://<56 chars>.onion: sent as Onion-Location, shown in Help.
//   NEXT_PUBLIC_APK_URLS            Direct APK download pages (comma-separated https URLs).
//   NEXT_PUBLIC_APK_CERT_SHA256     The Android signing certificate fingerprint people can verify.
//
// NEXT_PUBLIC_* values are inlined at build time, so each one is read with a literal process.env.X.

export interface NetConfig {
  supabaseUrl: string;
  /** Raw NEXT_PUBLIC_API_BASE ('' = Supabase directly). */
  apiBase: string;
  /** Raw NEXT_PUBLIC_REALTIME_BASE ('' = Supabase directly). */
  realtimeBase: string;
  apiAlternates: string[];
  mirrorOrigins: string[];
  mirrorListPubkey: string;
  mirrorListUrls: string[];
  onionOrigin: string;
  apkUrls: string[];
  apkCertSha256: string;
}

export function list(v: string | undefined): string[] {
  return (v ?? '').split(/[,\s]+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

const trimSlash = (s: string | undefined) => (s ?? '').trim().replace(/\/+$/, '');

/** An https origin (or http for .onion / localhost), normalised; null when it isn't one. */
export function asOrigin(v: string): string | null {
  try {
    const u = new URL(v);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.onion');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function readNetConfig(env: Record<string, string | undefined>): NetConfig {
  const pubkey = (env.NEXT_PUBLIC_MIRROR_LIST_PUBKEY ?? '').trim();
  const urls = list(env.NEXT_PUBLIC_MIRROR_LIST_URLS);
  return {
    supabaseUrl: trimSlash(env.NEXT_PUBLIC_SUPABASE_URL),
    apiBase: trimSlash(env.NEXT_PUBLIC_API_BASE),
    realtimeBase: trimSlash(env.NEXT_PUBLIC_REALTIME_BASE),
    apiAlternates: list(env.NEXT_PUBLIC_API_ALTERNATES),
    mirrorOrigins: list(env.NEXT_PUBLIC_MIRROR_ORIGINS).map(asOrigin).filter((o): o is string => !!o),
    mirrorListPubkey: pubkey,
    mirrorListUrls: urls.length ? urls : pubkey ? ['/api/net/mirrors'] : [],
    onionOrigin: (() => {
      const o = asOrigin(trimSlash(env.NEXT_PUBLIC_ONION_ORIGIN));
      return o && new URL(o).hostname.endsWith('.onion') ? o : '';
    })(),
    apkUrls: list(env.NEXT_PUBLIC_APK_URLS).filter((u) => /^https:\/\//i.test(u)),
    apkCertSha256: (env.NEXT_PUBLIC_APK_CERT_SHA256 ?? '').trim(),
  };
}

/** Is any censorship-resistance routing configured? When false, lib/supabase.ts is untouched. */
export function routingEnabled(c: NetConfig): boolean {
  return !!(c.apiBase || c.realtimeBase || c.apiAlternates.length || c.mirrorOrigins.length || c.mirrorListPubkey);
}

export const NET: NetConfig = readNetConfig({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE,
  NEXT_PUBLIC_REALTIME_BASE: process.env.NEXT_PUBLIC_REALTIME_BASE,
  NEXT_PUBLIC_API_ALTERNATES: process.env.NEXT_PUBLIC_API_ALTERNATES,
  NEXT_PUBLIC_MIRROR_ORIGINS: process.env.NEXT_PUBLIC_MIRROR_ORIGINS,
  NEXT_PUBLIC_MIRROR_LIST_PUBKEY: process.env.NEXT_PUBLIC_MIRROR_LIST_PUBKEY,
  NEXT_PUBLIC_MIRROR_LIST_URLS: process.env.NEXT_PUBLIC_MIRROR_LIST_URLS,
  NEXT_PUBLIC_ONION_ORIGIN: process.env.NEXT_PUBLIC_ONION_ORIGIN,
  NEXT_PUBLIC_APK_URLS: process.env.NEXT_PUBLIC_APK_URLS,
  NEXT_PUBLIC_APK_CERT_SHA256: process.env.NEXT_PUBLIC_APK_CERT_SHA256,
});
