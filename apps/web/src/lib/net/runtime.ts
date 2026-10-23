// Client runtime for censorship resistance (docs/v2/08-censorship.md). Holds the current route, rewrites
// Supabase requests onto it, health-checks and fails over, and keeps the last verified mirror list.
//
// Inert unless routing is configured (config.ts routingEnabled): then netFetch / netUrl / the WebSocket
// transport are never installed or are the identity, no request is ever made by this module, and the
// banner never shows.
//
// Privacy: probes only go to the configured routes and mirrors (all in connect-src); nothing about the
// person is sent (no ids, no tokens: only the public "apikey" Supabase already requires on every call).
// What is stored (localStorage, this device only): the last verified signed list, its version (rollback
// protection) and the id of the route that last worked.
import { NET, routingEnabled, type NetConfig } from './config';
import { netConnectSources } from './csp';
import { buildRoutes, endpointsFor, rewriteHttp, rewriteWs, type Endpoints, type NetStatus, type Route } from './endpoints';
import { HEALTH_START, nextCheckIn, nextHealth, probeOutcome, type HealthSample, type HealthTrack, type Probe } from './health';
import { verifyMirrorList, type MirrorList, type SignedMirrorList } from './mirrors';

export const NET_KEYS = {
  list: 'kw.net.list',
  minVersion: 'kw.net.minVersion',
  route: 'kw.net.route',
  dismissed: 'kw.net.dismissed',
} as const;


export interface NetState {
  enabled: boolean;
  status: NetStatus;
  routes: Route[];
  current: Route | null;
  list: MirrorList | null;
  signed: SignedMirrorList | null;
  checkedAt: number;
  checking: boolean;
}

const cfg: NetConfig = NET;
const enabled = routingEnabled(cfg);
const here = () => (typeof location === 'undefined' ? '' : location.origin);

/**
 * Only routes this page's CSP lets it reach (connect-src is fixed per build: proxy.ts adds exactly
 * netConnectSources). Mirrors that only appear in the signed list are shown as links instead.
 */
function reachable(routes: Route[]): Route[] {
  const allowed = new Set([here(), originOf(cfg.supabaseUrl), ...netConnectSources(cfg)]);
  return routes.filter((r) => allowed.has(originOf(r.apiBase)) && allowed.has(originOf(r.realtimeBase.replace(/^ws(s?):/, 'http$1:'))) || r.kind === 'direct');
}
function originOf(u: string): string {
  try { return new URL(u).origin; } catch { return ''; }
}
const routesFor = (list: MirrorList | null) => reachable(buildRoutes(cfg, here(), list));

function store(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function get(k: string): string | null { try { return store()?.getItem(k) ?? null; } catch { return null; } }
function set(k: string, v: string) { try { store()?.setItem(k, v); } catch { /* private mode: fine */ } }

function cachedList(): { list: MirrorList; signed: SignedMirrorList } | null {
  const raw = get(NET_KEYS.list);
  if (!raw || !cfg.mirrorListPubkey) return null;
  // Re-verified on every load: storage is not trusted more than the network.
  const r = verifyMirrorList(raw, cfg.mirrorListPubkey, { minVersion: Number(get(NET_KEYS.minVersion) ?? 0) || 0 });
  return r.ok ? { list: r.list, signed: r.signed } : null;
}

let state: NetState = { enabled, status: 'unknown', routes: [], current: null, list: null, signed: null, checkedAt: 0, checking: false };
let started = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function update(p: Partial<NetState>) { state = { ...state, ...p }; emit(); }

function init() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const c = enabled ? cachedList() : null;
  const routes = routesFor(c?.list ?? null);
  const prefer = get(NET_KEYS.route);
  const current = (prefer && routes.find((r) => r.id === prefer)) || routes[0] || null;
  state = { ...state, routes, current, list: c?.list ?? null, signed: c?.signed ?? null };
}

export function netState(): NetState { init(); return state; }
export function subscribeNet(fn: () => void): () => void { init(); listeners.add(fn); return () => { listeners.delete(fn); }; }
const SERVER_STATE: NetState = { enabled, status: 'unknown', routes: [], current: null, list: null, signed: null, checkedAt: 0, checking: false };
export function netServerState(): NetState { return SERVER_STATE; }

/** The current endpoints (see endpoints.ts). Without configuration: the Supabase URL for everything. */
export function endpoints(): Endpoints {
  init();
  const routes = state.routes.length ? state.routes : routesFor(null);
  return endpointsFor(routes, state.current ?? routes[0]!);
}

/** A Supabase URL rewritten onto the current route (identity when nothing is configured). */
export function netUrl(url: string): string {
  if (!enabled) return url;
  init();
  return state.current ? rewriteHttp(url, cfg.supabaseUrl, state.current) : url;
}

// ---- probing -----------------------------------------------------------------------------------------
// Each check is one sample for health.ts, which decides what (if anything) to show. A single failed
// check never shows a banner; see health.ts for the rules.

/** Long enough for a static file over 2G or a slow TLS handshake; a censor's drop never answers at all. */
const PROBE_TIMEOUT_MS = 8000;
/** Our own origin's health: a static file (public/kw-health.json), so no serverless cold start. */
export const APP_HEALTH = '/kw-health.json';

async function probeUrl(url: string, headers?: Record<string, string>): Promise<Probe> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers, signal: ctl.signal });
    await res.body?.cancel().catch(() => undefined);
    // Supabase Auth's health endpoint and our static file both answer JSON; a censor's middlebox usually
    // answers an HTML page (health.ts probeOutcome).
    return probeOutcome({ status: res.status, contentType: res.headers.get('content-type') ?? '' });
  } catch (error) {
    return probeOutcome({ error, timedOut });
  } finally {
    clearTimeout(timer);
  }
}

const apikey = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
const routeProbe = (r: Route) => probeUrl(r.health, { apikey: apikey() });
/** Does this route answer (ok, or a JSON error from a server that is clearly reachable)? */
export const probeRoute = async (r: Route) => { const p = await routeProbe(r); return p === 'ok' || p === 'neutral'; };
// Cache-busting query: the file is static (served from the CDN edge), the query only defeats caches.
const probeApp = () => probeUrl(`${APP_HEALTH}?t=${Date.now().toString(36)}`);

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const mirrorsKnown = () => state.routes.length > 1;

let track: HealthTrack = HEALTH_START;
let loopStarted = false;
let inflight: Promise<NetState> | null = null;

/** Probe every route in parallel; the first that answers in route order (preferring the last one used). */
async function probeRoutes(): Promise<{ best: Route | null; outcome: Probe }> {
  const prefer = state.current?.id;
  const ordered = prefer ? [...state.routes.filter((r) => r.id === prefer), ...state.routes.filter((r) => r.id !== prefer)] : state.routes;
  const results = await Promise.all(ordered.map((r) => routeProbe(r).catch((): Probe => 'fail')));
  const i = results.findIndex((p) => p === 'ok' || p === 'neutral');
  if (i >= 0) {
    // Back to the first route as soon as it works again.
    const first = state.routes[0];
    const firstAt = ordered.findIndex((r) => r.id === first?.id);
    const best = firstAt >= 0 && (results[firstAt] === 'ok' || results[firstAt] === 'neutral') ? first! : ordered[i]!;
    return { best, outcome: results[ordered.indexOf(best)]! };
  }
  return { best: null, outcome: results.some((p) => p === 'aborted') ? 'aborted' : 'fail' };
}

/** Health-check the app origin and every route; switch to the first route that works. */
export function recheck(): Promise<NetState> {
  init();
  if (!enabled) return Promise.resolve(state);
  inflight ??= (async () => {
    update({ checking: true });
    try {
      const at = Date.now();
      const wasHidden = hidden();
      const [app, routes] = await Promise.all([probeApp(), probeRoutes()]);
      if (routes.best) set(NET_KEYS.route, routes.best.id);
      const sample: HealthSample = {
        at, app, route: routes.outcome, hidden: wasHidden || hidden(),
        online: typeof navigator === 'undefined' || navigator.onLine !== false,
        rerouted: !!routes.best && routes.best.id !== state.routes[0]?.id && routes.best.kind !== 'direct',
      };
      track = nextHealth(track, sample, { mirrors: mirrorsKnown() });
      update({ current: routes.best ?? state.current, status: track.status, checkedAt: Date.now() });
    } finally {
      update({ checking: false });
      inflight = null;
      schedule();
    }
    return state;
  })();
  return inflight;
}

// Follow-up checks (health.ts nextCheckIn): soon while something looks wrong, backing off once shown.
let nextTimer: ReturnType<typeof setTimeout> | null = null;
function schedule(delay = nextCheckIn(track)) {
  if (!loopStarted) return;
  if (nextTimer) clearTimeout(nextTimer);
  nextTimer = delay === null ? null : setTimeout(() => { nextTimer = null; if (hidden()) return; void recheck(); }, delay);
}

let debounce: ReturnType<typeof setTimeout> | null = null;
let resumedAt = 0;
/**
 * A request failed at the network level: check soon (coalesced). Ignored while the page is hidden or
 * just after it came back (a phone waking up, the WebView resuming, a network switch: requests fail for a
 * moment and then work); aborted requests never get here.
 */
export function reportNetworkFailure() {
  if (!enabled || debounce || hidden() || Date.now() - resumedAt < 5_000) return;
  debounce = setTimeout(() => { debounce = null; if (!hidden()) void recheck(); }, 1_500);
}

// ---- the signed mirror list --------------------------------------------------------------------------

/** Verify and keep a signed list (from the network, a QR code or a pasted message). */
export function acceptMirrorList(input: unknown): ReturnType<typeof verifyMirrorList> {
  init();
  const minVersion = Number(get(NET_KEYS.minVersion) ?? 0) || 0;
  const r = verifyMirrorList(input, cfg.mirrorListPubkey, { minVersion });
  if (!r.ok) return r;
  // An equal version is a re-fetch of the list we have; only newer ones replace it.
  if (state.list && r.list.version <= state.list.version) return r;
  set(NET_KEYS.list, JSON.stringify(r.signed));
  set(NET_KEYS.minVersion, String(r.list.version));
  const routes = routesFor(r.list);
  update({ list: r.list, signed: r.signed, routes, current: routes.find((x) => x.id === state.current?.id) ?? routes[0] ?? null });
  return r;
}

/** Fetch the list from every configured location; the newest valid one wins. */
export async function refreshMirrorList(): Promise<void> {
  if (!cfg.mirrorListPubkey) return;
  await Promise.all(cfg.mirrorListUrls.map(async (u) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS * 2);
    try {
      const res = await fetch(u, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
      if (res.ok) acceptMirrorList(await res.text());
    } catch { /* this location is blocked or down: the others may work */ } finally { clearTimeout(timer); }
  }));
}

// ---- fetch / WebSocket wrappers for the Supabase client ----------------------------------------------

const realFetch: typeof fetch = (...a) => fetch(...a);

/**
 * fetch for supabase-js: rewrites the Supabase URL onto the current route. A network failure triggers a
 * re-check; GET/HEAD requests are retried once on the new route (other methods are not: the request may
 * have reached the server).
 */
export const netFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const routed = netUrl(url);
  const send = (u: string) => (typeof input === 'string' || input instanceof URL ? realFetch(u, init) : realFetch(new Request(u, input), init));
  try {
    return await send(routed);
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'AbortError') throw e;
    reportNetworkFailure();
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') throw e;
    const before = state.current?.id;
    await recheck();
    if (state.current?.id === before) throw e;
    return send(netUrl(url));
  }
};

/** The Realtime transport: a WebSocket whose URL is rewritten onto the current route at connect time. */
export function routedWebSocket(): typeof WebSocket {
  const Base = WebSocket;
  return class RoutedWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      init();
      const u = String(url);
      super(state.current ? rewriteWs(u, cfg.supabaseUrl, state.current) : u, protocols);
      this.addEventListener('error', () => reportNetworkFailure());
    }
  };
}

/** Options merged into createClient() in lib/supabase.ts; empty (= unchanged client) when not configured. */
export function supabaseNetOptions(): { global?: { fetch: typeof fetch }; realtime?: { transport: typeof WebSocket } } {
  if (!enabled || typeof window === 'undefined') return {};
  return { global: { fetch: netFetch }, realtime: { transport: routedWebSocket() } };
}

// ---- background loop ---------------------------------------------------------------------------------

/** Started once by the NetRuntime component. */
export function startNetLoop(): () => void {
  init();
  if (!enabled || loopStarted) return () => undefined;
  loopStarted = true;
  const first = setTimeout(() => { void refreshMirrorList().finally(() => { void recheck(); }); }, 3000);
  const daily = setInterval(() => { void refreshMirrorList(); }, 24 * 3600_000);
  // Back online: check now, so a shown "offline"/"blocked" clears at once. Offline: confirm in a moment
  // (OFFLINE_SAMPLES over OFFLINE_SPAN_MS) rather than on a blip during a network switch.
  const online = () => { resumedAt = Date.now(); schedule(1_500); };
  const offline = () => schedule(2_000);
  // Coming back to the page: failures right after a resume don't count; re-check only to clear a shown state.
  const visible = () => {
    if (hidden()) return;
    resumedAt = Date.now();
    if (track.pending || track.status === 'offline' || track.status === 'unreachable' || track.status === 'blocked') schedule(3_000);
  };
  addEventListener('online', online);
  addEventListener('offline', offline);
  document.addEventListener('visibilitychange', visible);
  return () => {
    loopStarted = false;
    clearTimeout(first); clearInterval(daily);
    if (nextTimer) clearTimeout(nextTimer);
    nextTimer = null;
    removeEventListener('online', online); removeEventListener('offline', offline);
    document.removeEventListener('visibilitychange', visible);
  };
}

/** Tests only. */
export function __resetNetForTests() { started = false; loopStarted = false; inflight = null; track = HEALTH_START; resumedAt = 0; state = { ...SERVER_STATE }; listeners.clear(); }
