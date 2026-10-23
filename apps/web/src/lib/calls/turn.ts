'use client';
// ICE servers for a call: short-lived Cloudflare TURN credentials from /api/calls/turn, or public STUN only
// when the server has no TURN configured (docs/v2/04-calls.md §2).
//
// Speed (§12): the credentials are fetched BEFORE anyone taps "Call" — when a chat with call buttons
// opens (prefetchIceConfig) and when a call rings on this device — and kept until a few minutes before
// they expire (ttl 3600 s), refreshed in the background. So placing or answering a call never waits for
// the route (a serverless function: a cold start plus a Supabase auth check plus Cloudflare's API).
// A request is given ICE_TIMEOUT_MS; a failure is reported as such (`ok: false`), so a call that must be
// relayed can fail fast with a clear message instead of hanging or quietly connecting directly.
import { sb } from '../supabase';
import type { IceServer } from './ice';

export interface IceConfig {
  iceServers: IceServer[];
  /** A TURN relay with credentials is in the list (relay-only calls can work). */
  relay: boolean;
  /** false: the credentials couldn't be fetched (network, timeout, server error). true + relay false: the server has no TURN. */
  ok: boolean;
}

const STUN = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
const FAILED: IceConfig = { iceServers: STUN, relay: false, ok: false };
const ICE_TIMEOUT_MS = 6_000;
/** Refresh in the background when less than this is left. */
const REFRESH_MS = 15 * 60_000;

let cache: { cfg: IceConfig; until: number } | null = null;
let inflight: Promise<IceConfig> | null = null;

async function fetchIce(): Promise<IceConfig> {
  const token = (await sb().auth.getSession()).data.session?.access_token;
  if (!token) return FAILED;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ICE_TIMEOUT_MS);
  try {
    const res = await fetch('/api/calls/turn', { method: 'POST', cache: 'no-store', headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    if (!res.ok) return FAILED;
    const j = (await res.json()) as { iceServers?: IceServer[]; relay?: boolean; ttl?: number };
    const cfg: IceConfig = { iceServers: Array.isArray(j.iceServers) && j.iceServers.length ? j.iceServers : STUN, relay: !!j.relay, ok: true };
    const ttl = typeof j.ttl === 'number' && j.ttl > 600 ? j.ttl : 3600;
    cache = { cfg, until: Date.now() + (ttl - 300) * 1000 };
    return cfg;
  } catch {
    return FAILED;
  } finally {
    clearTimeout(timer);
  }
}

function load(): Promise<IceConfig> {
  inflight ??= fetchIce().finally(() => { inflight = null; });
  return inflight;
}

/** The ICE configuration: from the cache when fresh (refreshed in the background when getting old). */
export async function getIceConfig(opts: { fresh?: boolean } = {}): Promise<IceConfig> {
  const now = Date.now();
  if (!opts.fresh && cache && cache.until > now) {
    if (cache.until - now < REFRESH_MS) void load();
    return cache.cfg;
  }
  return load();
}

/** Warm the cache (a chat with call buttons opened, a call is ringing here). Never throws, never waits. */
export function prefetchIceConfig(): void {
  if (cache && cache.until - Date.now() > REFRESH_MS) return;
  void load().catch(() => undefined);
}

export function forgetIceConfig() { cache = null; }

