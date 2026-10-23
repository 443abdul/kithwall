// Endpoint resolution (docs/v2/08-censorship.md §1–2). Pure functions, unit-tested in endpoints.test.ts.
//
// A "route" is one way to reach the backend: where the REST/Auth/Storage requests go (apiBase), where
// the Realtime WebSocket goes (realtimeBase) and which app origin serves the Next.js API routes. The
// Supabase client is always created with the real NEXT_PUBLIC_SUPABASE_URL (so its session storage key,
// and everything derived from the URL, never changes); requests are rewritten from that URL to the
// current route's bases at the moment they are sent. With nothing configured there is exactly one route,
// "direct", whose bases ARE the Supabase URL, and the rewrite is the identity.
import { type NetConfig } from './config';
import type { MirrorList } from './mirrors';

export type RouteKind = 'direct' | 'proxy' | 'mirror' | 'onion';

export interface Route {
  /** Stable id (persisted as the last working route). */
  id: string;
  kind: RouteKind;
  /** The origin whose Next.js routes (/api/…) belong to this route. */
  appOrigin: string;
  /** Absolute base that replaces the Supabase URL for HTTP requests (…/rest/v1, …/auth/v1, …). */
  apiBase: string;
  /** Absolute ws(s) base that replaces the Supabase URL for the Realtime socket. */
  realtimeBase: string;
  /** apiBase + /storage/v1 (encrypted media up/downloads). */
  storageBase: string;
  /** Where call TURN credentials come from (same-origin Next.js route on appOrigin). */
  turnRoute: string;
  /** Probed to decide whether this route works. */
  health: string;
  label?: string;
}

export interface Endpoints {
  appOrigin: string;
  apiBase: string;
  realtimeBase: string;
  storageBase: string;
  turnRoute: string;
  current: Route;
  /** Every other route, in the order they are tried. */
  alternates: Route[];
}

const toWs = (u: string) => u.replace(/^http(s?):/i, 'ws$1:');

/** An absolute base from config: "/sb" is a path on `origin`; absolute URLs are kept (trailing / trimmed). */
export function resolveBase(raw: string, origin: string): string {
  if (!raw) return '';
  if (raw.startsWith('/') && !raw.startsWith('//')) return `${origin}${raw}`.replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    if (u.username || u.password || !/^(https?|wss?):$/.test(u.protocol)) return '';
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function route(kind: RouteKind, id: string, appOrigin: string, apiBase: string, realtimeBase: string, label?: string): Route {
  return {
    id, kind, appOrigin, apiBase, realtimeBase,
    storageBase: `${apiBase}/storage/v1`,
    turnRoute: `${appOrigin}/api/calls/turn`,
    health: `${apiBase}/auth/v1/health`,
    ...(label ? { label } : {}),
  };
}

const isOnion = (origin: string) => {
  try { return new URL(origin).hostname.endsWith('.onion'); } catch { return false; }
};

/**
 * Every route, best first:
 *  1. on an .onion page: the onion's own /sb proxy (traffic never leaves Tor);
 *  2. the configured primary (NEXT_PUBLIC_API_BASE / NEXT_PUBLIC_REALTIME_BASE), else direct;
 *  3. NEXT_PUBLIC_API_ALTERNATES;
 *  4. build-time mirrors (NEXT_PUBLIC_MIRROR_ORIGINS) when the API base is a path ("/sb"), since every
 *     mirror then proxies the same path;
 *  5. mirrors from the verified signed list that have their own proxy;
 *  6. Supabase directly (if not already first).
 */
export function buildRoutes(cfg: NetConfig, here: string, list: MirrorList | null = null): Route[] {
  const sbUrl = cfg.supabaseUrl;
  const direct = route('direct', 'direct', here, sbUrl, toWs(sbUrl));
  const out: Route[] = [];
  const onionHere = isOnion(here);

  if (onionHere) out.push(route('onion', 'onion', here, `${here}/sb`, toWs(`${here}/sb`)));

  const api = resolveBase(cfg.apiBase, here);
  const rt = resolveBase(cfg.realtimeBase, here);
  const primaryRt = rt ? toWs(rt) : toWs(sbUrl);
  out.push(api || rt ? route('proxy', 'primary', here, api || sbUrl, primaryRt) : direct);

  for (const alt of cfg.apiAlternates) {
    const base = resolveBase(alt, here);
    if (base) out.push(route('proxy', `alt:${base}`, here, base, primaryRt));
  }

  const relApi = cfg.apiBase.startsWith('/') && !cfg.apiBase.startsWith('//') ? cfg.apiBase : '';
  const relRt = cfg.realtimeBase.startsWith('/') && !cfg.realtimeBase.startsWith('//') ? cfg.realtimeBase : '';
  if (relApi) {
    for (const m of cfg.mirrorOrigins) {
      if (m === here) continue;
      out.push(route('mirror', `mirror:${m}`, m, `${m}${relApi}`, relRt ? toWs(`${m}${relRt}`) : primaryRt));
    }
  }

  for (const m of list?.mirrors ?? []) {
    if (!m.api || m.origin === here) continue;
    if (m.kind === 'onion' && !onionHere) continue;   // a normal browser can't reach .onion
    out.push(route(m.kind === 'onion' ? 'onion' : 'mirror', `mirror:${m.origin}`, m.origin, m.api, m.realtime ?? primaryRt, m.label));
  }

  out.push(direct);
  // First occurrence wins (same bases = same route).
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.apiBase}|${r.realtimeBase}`;
    if (!r.apiBase || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function endpointsFor(routes: Route[], current: Route): Endpoints {
  return {
    appOrigin: current.appOrigin,
    apiBase: current.apiBase,
    realtimeBase: current.realtimeBase,
    storageBase: current.storageBase,
    turnRoute: current.turnRoute,
    current,
    alternates: routes.filter((r) => r.id !== current.id),
  };
}

/** Rewrite an http(s) URL on the Supabase URL to the route's API base; anything else is unchanged. */
export function rewriteHttp(url: string, supabaseUrl: string, r: Route): string {
  if (!supabaseUrl || r.apiBase === supabaseUrl) return url;
  if (url === supabaseUrl || url.startsWith(`${supabaseUrl}/`) || url.startsWith(`${supabaseUrl}?`)) return r.apiBase + url.slice(supabaseUrl.length);
  return url;
}

/** Rewrite the Realtime socket URL (wss://<project>.supabase.co/realtime/v1/websocket?…) to the route. */
export function rewriteWs(url: string, supabaseUrl: string, r: Route): string {
  const ws = toWs(supabaseUrl);
  if (!supabaseUrl || r.realtimeBase === ws) return url;
  if (url.startsWith(`${ws}/`) || url.startsWith(`${ws}?`)) return r.realtimeBase + url.slice(ws.length);
  return url;
}

/**
 * The first working route, preferring `preferId` (the last one that worked), then routes in order.
 * Probes run in parallel, so one dead route costs one timeout, not one per route.
 */
export async function pickRoute(routes: Route[], probe: (r: Route) => Promise<boolean>, preferId?: string): Promise<Route | null> {
  const ordered = preferId ? [...routes.filter((r) => r.id === preferId), ...routes.filter((r) => r.id !== preferId)] : routes;
  const results = ordered.map((r) => probe(r).catch(() => false));
  for (let i = 0; i < ordered.length; i++) {
    if (await results[i]) return ordered[i]!;
  }
  return null;
}

export type NetStatus = 'unknown' | 'direct' | 'rerouted' | 'blocked' | 'offline' | 'unreachable';

/** What the banner says: rerouted = working through something other than the first route. */
export function statusOf(routes: Route[], current: Route | null, appOk: boolean, online: boolean): NetStatus {
  if (!online) return 'offline';
  if (!current || !appOk) return 'blocked';
  // Falling back to Supabase directly is not "through a mirror": nothing to tell.
  return current.id === routes[0]?.id || current.kind === 'direct' ? 'direct' : 'rerouted';
}
