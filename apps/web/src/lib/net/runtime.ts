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
import { buildRoutes, endpointsFor, pickRoute, rewriteHttp, rewriteWs, statusOf, type Endpoints, type NetStatus, type Route } from './endpoints';
import { verifyMirrorList, type MirrorList, type SignedMirrorList } from './mirrors';

export const NET_KEYS = {
  list: 'kw.net.list',
  minVersion: 'kw.net.minVersion',
  route: 'kw.net.route',
  dismissed: 'kw.net.dismissed',
} as const;

const PROBE_TIMEOUT_MS = 6000;
const RECHECK_MS = 5 * 60_000;

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

async function probeUrl(url: string, headers?: Record<string, string>): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers, signal: ctl.signal });
    // Any HTTP answer from Supabase Auth's health endpoint proves the path works; a blocking page from a
    // censor's middlebox usually answers 200/403 HTML, so require JSON.
    return res.ok && (res.headers.get('content-type') ?? '').includes('json');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const apikey = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
export const probeRoute = (r: Route) => probeUrl(r.health, { apikey: apikey() });
const probeApp = () => probeUrl('/api/net/health');

let inflight: Promise<NetState> | null = null;

/** Health-check the app origin and every route; switch to the first route that works. */
export function recheck(): Promise<NetState> {
  init();
  if (!enabled) return Promise.resolve(state);
  inflight ??= (async () => {
    update({ checking: true });
    try {
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      const [appOk, picked] = await Promise.all([probeApp(), pickRoute(state.routes, probeRoute, state.current?.id)]);
      // Back to the first route as soon as it works again.
      const best = picked && picked.id !== state.routes[0]?.id && (await probeRoute(state.routes[0]!)) ? state.routes[0]! : picked;
      if (best) set(NET_KEYS.route, best.id);
      update({ current: best ?? state.current, status: statusOf(state.routes, best, appOk, online), checkedAt: Date.now() });
    } finally {
      update({ checking: false });
      inflight = null;
    }
    return state;
  })();
  return inflight;
}

let debounce: ReturnType<typeof setTimeout> | null = null;
/** A request failed at the network level: re-check soon (coalesced). */
export function reportNetworkFailure() {
  if (!enabled || debounce) return;
  debounce = setTimeout(() => { debounce = null; void recheck(); }, 500);
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

let loopStarted = false;
/** Started once by the NetRuntime component. */
export function startNetLoop(): () => void {
  init();
  if (!enabled || loopStarted) return () => undefined;
  loopStarted = true;
  const first = setTimeout(() => { void refreshMirrorList().finally(() => { void recheck(); }); }, 3000);
  const every = setInterval(() => { if (state.status !== 'direct' && state.status !== 'unknown') void recheck(); }, RECHECK_MS);
  const daily = setInterval(() => { void refreshMirrorList(); }, 24 * 3600_000);
  const online = () => { void recheck(); };
  addEventListener('online', online);
  return () => { loopStarted = false; clearTimeout(first); clearInterval(every); clearInterval(daily); removeEventListener('online', online); };
}

/** Tests only. */
export function __resetNetForTests() { started = false; loopStarted = false; inflight = null; state = { ...SERVER_STATE }; listeners.clear(); }
