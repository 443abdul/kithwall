// POST /api/calls/turn → { iceServers, relay, ttl }
// Mints short-lived Cloudflare TURN credentials for one person (docs/v2/04-calls.md §2).
//
// - Requires the caller's Supabase access token (verified with Auth, so revoked sessions fail) and is
//   rate limited per person: an in-memory burst limit plus a database quota (public.turn_quota).
// - Calls https://rtc.live.cloudflare.com/v1/turn/keys/<key id>/credentials/generate-ice-servers with
//   the API token. The token never leaves the server; the browser only gets credentials that expire.
// - TURN only relays packets that are already encrypted end to end (DTLS-SRTP, plus frame encryption
//   where the browser supports it), so Cloudflare sees ciphertext and the two relay addresses.
// - Without CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN (local dev, previews) this returns
//   Cloudflare's public STUN server only and `relay: false`; calls still work on most networks but can't
//   hide IP addresses.
// - Nothing about the request or the credentials is logged.
import { createClient } from '@supabase/supabase-js';
import { cleanIceServers, hasTurn } from '@/lib/calls/ice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
const KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID ?? '';
const API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN ?? '';

/** Credential lifetime: longer than any sensible call, short enough to be worthless when leaked. */
const TTL = 3600;
const STUN_ONLY = [{ urls: ['stun:stun.cloudflare.com:3478'] }];

const burst = new Map<string, number[]>();
const BURST_MAX = 20;
const BURST_WINDOW = 60_000;
function burstOk(user: string): boolean {
  const now = Date.now();
  const list = (burst.get(user) ?? []).filter((t) => now - t < BURST_WINDOW);
  if (list.length >= BURST_MAX) { burst.set(user, list); return false; }
  list.push(now);
  burst.set(user, list);
  if (burst.size > 10_000) for (const [k, v] of burst) if (!v.some((t) => now - t < BURST_WINDOW)) burst.delete(k);
  return true;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

let warned = false;

export async function POST(request: Request) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return json({ error: 'Calls are not available.' }, 503);
  const token = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return json({ error: 'Please sign in.' }, 401);
  const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await client.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: 'Please sign in.' }, 401);
  if (!burstOk(userData.user.id)) return json({ error: 'Too many requests. Try again in a minute.' }, 429);
  const quota = await client.rpc('turn_quota');
  if (quota.error) return quota.error.code === 'P0429' ? json({ error: 'Too many calls. Try again later.' }, 429) : json({ error: 'Please sign in.' }, 403);

  if (!KEY_ID || !API_TOKEN) {
    if (!warned) { warned = true; console.info('[calls] Cloudflare TURN is not configured (CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN): STUN only, no relay.'); }
    return json({ iceServers: STUN_ONLY, relay: false, ttl: TTL });
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(KEY_ID)) return json({ iceServers: STUN_ONLY, relay: false, ttl: TTL });

  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL }),
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      console.warn(`[calls] TURN credentials request failed (status ${res.status})`);
      return json({ iceServers: STUN_ONLY, relay: false, ttl: TTL });
    }
    const iceServers = cleanIceServers(await res.json());
    const relay = hasTurn(iceServers);
    return json({ iceServers: iceServers.length ? iceServers : STUN_ONLY, relay, ttl: TTL });
  } catch {
    console.warn('[calls] TURN credentials request failed (network)');
    return json({ iceServers: STUN_ONLY, relay: false, ttl: TTL });
  }
}
