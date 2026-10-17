// Link-preview proxy (spec §1, §7). Fetches a page server-side so that the poster's and readers'
// IP addresses are never sent to the linked site, extracts title/description/og:image, and
// returns the image inline so the client can encrypt and upload it with the post.
//
// Security:
//  - Requires a valid Supabase access token (verified with auth.getUser) and is rate limited per
//    user (database quota + an in-memory burst limit).
//  - SSRF: http/https on the default ports only, no credentials in URLs. Every hostname is
//    resolved by our own lookup, and the connection is refused if ANY resolved address is
//    private, loopback, link-local, multicast, carrier-grade NAT, documentation, cloud metadata
//    or otherwise non-global (IPv4 and IPv6). The check runs at connect time for every hop, so
//    DNS rebinding and redirects to internal addresses are blocked. At most 3 redirects, 5 s total,
//    1 MB of HTML, 300 KB of image, no compressed bodies.
//  - Nothing is logged, nothing is cached (Cache-Control: no-store).
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 15;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

const TOTAL_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
const MAX_HTML = 1024 * 1024;
const MAX_IMAGE = 300 * 1024;
const MAX_URL = 2048;
const UA = 'Mozilla/5.0 (compatible; KithwallLinkPreview/1.0)';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// ---------------------------------------------------------------------------------------
// Address filtering

const deny4 = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as [string, number][]) deny4.addSubnet(a, p, 'ipv4');

// IPv6: only global unicast (2000::/3) is allowed, minus special-purpose ranges. This also
// excludes ::1, ::, IPv4-mapped/-compatible (::ffff:0:0/96, ::/96), unique-local fc00::/7,
// link-local fe80::/10, multicast ff00::/8 and NAT64 64:ff9b::/96 (all outside 2000::/3).
const global6 = new net.BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const deny6 = new net.BlockList();
for (const [a, p] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as [string, number][]) deny6.addSubnet(a, p, 'ipv6');

function isPublicAddress(address: string, family?: number): boolean {
  const fam = family ?? net.isIP(address);
  if (fam === 4) return net.isIPv4(address) && !deny4.check(address, 'ipv4');
  if (fam === 6) return net.isIPv6(address) && global6.check(address, 'ipv6') && !deny6.check(address, 'ipv6');
  return false;
}

class BlockedError extends Error {}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup replacement used for every connection: refuses non-public destinations. */
function safeLookup(hostname: string, options: { all?: boolean } | number | undefined, cb: LookupCb) {
  const all = typeof options === 'object' && options !== null && !!options.all;
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err, all ? [] : '', undefined);
    const list = addrs as LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address, a.family))) {
      return cb(new BlockedError('blocked destination') as NodeJS.ErrnoException, all ? [] : '', undefined);
    }
    if (all) cb(null, list);
    else cb(null, list[0]!.address, list[0]!.family);
  });
}

function checkUrl(raw: string, base?: URL): URL {
  let u: URL;
  try { u = base ? new URL(raw, base) : new URL(raw); } catch { throw new BlockedError('invalid url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedError('scheme');
  if (u.username || u.password) throw new BlockedError('credentials');
  if (u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))) {
    throw new BlockedError('port');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost' || host.endsWith('.localhost')) {
    throw new BlockedError('host');
  }
  if (net.isIP(host) && !isPublicAddress(host)) throw new BlockedError('address');
  u.hash = '';
  return u;
}

// ---------------------------------------------------------------------------------------
// Fetching

interface Fetched { url: URL; type: string; charset?: string; body: Buffer }

function requestOnce(u: URL, accept: string, deadline: number, maxBytes: number, truncateOk: boolean):
  Promise<{ redirect?: string; fetched?: Fetched }> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Error('timeout'));
    const lib = u.protocol === 'https:' ? https : http;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const req = lib.request({
      method: 'GET', hostname: host, port: u.port || undefined, path: `${u.pathname}${u.search}`,
      headers: { 'user-agent': UA, accept, 'accept-encoding': 'identity', 'accept-language': 'en' },
      lookup: safeLookup as unknown as typeof dnsLookup, agent: false,
      ...(u.protocol === 'https:' ? { servername: net.isIP(host) ? undefined : host } : {}),
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return done(() => resolve({ redirect: res.headers.location }));
      }
      if (status < 200 || status >= 300) { res.resume(); return done(() => reject(new Error('status'))); }
      const enc = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
      if (enc !== 'identity' && enc !== '') { res.destroy(); return done(() => reject(new Error('encoding'))); }
      const ctype = String(res.headers['content-type'] ?? '').toLowerCase();
      const type = ctype.split(';')[0]!.trim();
      const charset = /charset=([^;]+)/.exec(ctype)?.[1]?.trim().replace(/"/g, '');
      const len = Number(res.headers['content-length'] ?? 0);
      if (!truncateOk && len > maxBytes) { res.destroy(); return done(() => reject(new Error('too large'))); }
      const parts: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          if (truncateOk) {
            parts.push(c.subarray(0, c.length - (size - maxBytes)));
            res.destroy();
            done(() => resolve({ fetched: { url: u, type, charset, body: Buffer.concat(parts) } }));
          } else {
            res.destroy();
            done(() => reject(new Error('too large')));
          }
          return;
        }
        parts.push(c);
      });
      res.on('end', () => done(() => resolve({ fetched: { url: u, type, charset, body: Buffer.concat(parts) } })));
      res.on('error', () => done(() => reject(new Error('read failed'))));
    });
    const timer = setTimeout(() => { req.destroy(); done(() => reject(new Error('timeout'))); }, remaining);
    req.on('error', (e) => done(() => reject(e instanceof BlockedError ? e : new Error('connect failed'))));
    req.end();
  });
}

async function safeFetch(start: URL, accept: string, deadline: number, maxBytes: number, truncateOk: boolean): Promise<Fetched> {
  let u = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await requestOnce(u, accept, deadline, maxBytes, truncateOk);
    if (r.fetched) return r.fetched;
    if (hop === MAX_REDIRECTS) break;
    u = checkUrl(r.redirect!, u);
  }
  throw new Error('too many redirects');
}

// ---------------------------------------------------------------------------------------
// HTML parsing (head metadata only; nothing is executed or rendered server-side)

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) { const n = parseInt(k.slice(2), 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    if (k.startsWith('#')) { const n = parseInt(k.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ENT[k] ?? m;
  });
}
const clean = (s: string | undefined, n: number) => {
  if (!s) return undefined;
  const t = decodeEntities(s).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : undefined;
};

function parseHtml(html: string) {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : html.slice(0, 200_000);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
    }
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content');
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const title = /<title[^>]*>([\s\S]{0,2000}?)<\/title>/i.exec(head)?.[1];
  return {
    title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? title, 200),
    description: clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 400),
    site: clean(meta.get('og:site_name'), 100),
    image: meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image'),
  };
}

function decodeBody(f: Fetched): string {
  try { return new TextDecoder(f.charset || 'utf-8', { fatal: false }).decode(f.body); }
  catch { return new TextDecoder('utf-8').decode(f.body); }
}

// ---------------------------------------------------------------------------------------
// Auth + rate limiting

const burst = new Map<string, number[]>();
const BURST_MAX = 10;
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

export async function POST(request: Request) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return json({ error: 'Link previews are not available.' }, 503);
  const auth = request.headers.get('authorization') ?? '';
  const token = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(auth)?.[1];
  if (!token) return json({ error: 'Please sign in.' }, 401);

  const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await client.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: 'Please sign in.' }, 401);
  if (!burstOk(userData.user.id)) return json({ error: 'Too many link previews. Try again in a minute.' }, 429);
  const quota = await client.rpc('link_preview_quota');
  if (quota.error) {
    return quota.error.code === 'P0429'
      ? json({ error: 'You\'ve fetched a lot of link previews. Try again later.' }, 429)
      : json({ error: 'Please sign in.' }, 403);
  }

  let raw: string;
  try {
    const text = await request.text();
    if (text.length > 4096) return json({ error: 'Bad request.' }, 400);
    const parsed = JSON.parse(text) as { url?: unknown };
    if (typeof parsed.url !== 'string' || !parsed.url || parsed.url.length > MAX_URL) return json({ error: 'Please enter a valid link.' }, 400);
    raw = parsed.url;
  } catch { return json({ error: 'Bad request.' }, 400); }

  let start: URL;
  try { start = checkUrl(raw); } catch { return json({ error: 'That link can\'t be previewed.' }, 400); }

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let page: Fetched;
  try {
    page = await safeFetch(start, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', deadline, MAX_HTML, true);
  } catch (e) {
    return json({ error: e instanceof BlockedError ? 'That link can\'t be previewed.' : 'Couldn\'t load that page.' }, 422);
  }
  if (page.type !== 'text/html' && page.type !== 'application/xhtml+xml') {
    return json({ error: 'That link isn\'t a web page.' }, 422);
  }
  const meta = parseHtml(decodeBody(page));

  let image: { mime: string; data: string } | null = null;
  if (meta.image && meta.image.length <= MAX_URL) {
    try {
      const imgUrl = checkUrl(decodeEntities(meta.image.trim()), page.url);
      const img = await safeFetch(imgUrl, 'image/jpeg,image/png,image/gif,image/webp', deadline, MAX_IMAGE, false);
      if (IMAGE_TYPES.has(img.type) && img.body.length > 0) image = { mime: img.type, data: img.body.toString('base64') };
    } catch { /* preview without an image */ }
  }

  const site = meta.site ?? start.hostname.replace(/^www\./, '');
  return json({ url: start.toString(), title: meta.title ?? site, description: meta.description, site, image });
}

export function GET() {
  return json({ error: 'Method not allowed.' }, 405);
}
