// ICE server lists (shared by the TURN route and the client). Pure.

export interface IceServer { urls: string | string[]; username?: string; credential?: string }

/** Keep only well-formed stun:/turn:/turns: entries; drop port 53 (browsers block it). */
export function cleanIceServers(raw: unknown): IceServer[] {
  const list = (raw as { iceServers?: unknown } | null)?.iceServers;
  const arr = Array.isArray(list) ? list : list && typeof list === 'object' ? [list] : [];
  const out: IceServer[] = [];
  for (const s of arr as Record<string, unknown>[]) {
    const urls = (Array.isArray(s?.urls) ? s.urls : [s?.urls]).filter((u): u is string =>
      typeof u === 'string' && /^(stun|turns?):[a-z0-9.-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/i.test(u) && !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    // UDP first, then TCP, then TLS: browsers already prefer UDP relays when choosing a pair, and listing
    // them first gets their allocations started first (faster first relay candidate).
    urls.sort((a, b) => transportRank(a) - transportRank(b));
    const e: IceServer = { urls };
    if (typeof s.username === 'string' && typeof s.credential === 'string') { e.username = s.username; e.credential = s.credential; }
    out.push(e);
  }
  return out;
}

function transportRank(u: string): number {
  if (/^stun:/i.test(u)) return 0;
  if (/^turns:/i.test(u)) return 3;
  return /transport=tcp/i.test(u) ? 2 : 1;
}

/** Does this list contain a TURN server with credentials (so relay-only calls can work)? */
export function hasTurn(servers: IceServer[]): boolean {
  return servers.some((s) => !!s.username && (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(u)));
}
