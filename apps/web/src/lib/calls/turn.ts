'use client';
// ICE servers for a call: short-lived Cloudflare TURN credentials from /api/calls/turn (cached until a few
// minutes before they expire), or public STUN only when the server has no TURN configured.
import { sb } from '../supabase';
import type { IceServer } from './ice';

export interface IceConfig { iceServers: IceServer[]; relay: boolean }

const STUN_ONLY: IceConfig = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], relay: false };
let cache: { cfg: IceConfig; until: number } | null = null;

export async function getIceConfig(): Promise<IceConfig> {
  if (cache && cache.until > Date.now()) return cache.cfg;
  try {
    const token = (await sb().auth.getSession()).data.session?.access_token;
    if (!token) return STUN_ONLY;
    const res = await fetch('/api/calls/turn', { method: 'POST', cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return STUN_ONLY;
    const j = (await res.json()) as { iceServers?: IceServer[]; relay?: boolean; ttl?: number };
    const cfg: IceConfig = { iceServers: Array.isArray(j.iceServers) && j.iceServers.length ? j.iceServers : STUN_ONLY.iceServers, relay: !!j.relay };
    const ttl = typeof j.ttl === 'number' && j.ttl > 600 ? j.ttl : 3600;
    cache = { cfg, until: Date.now() + (ttl - 300) * 1000 };
    return cfg;
  } catch {
    return STUN_ONLY;
  }
}

export function forgetIceConfig() { cache = null; }
