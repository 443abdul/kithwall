// Link-preview proxy (spec §1, §7). Fetches a page server-side so that the poster's and readers'
// IP addresses are never sent to the linked site, extracts title/description/og:image (or, for the
// video providers in lib/embeds.ts, their oEmbed title + thumbnail), and returns the image inline so
// the client can downscale, re-encode, encrypt and upload it with the post.
//
// Security:
//  - Requires a valid Supabase access token (verified with auth.getUser) and is rate limited per
//    user (database quota + an in-memory burst limit).
//  - SSRF: http/https on the default ports only, no credentials in URLs. Every hostname is
//    resolved by our own lookup, and the connection is refused if ANY resolved address is
//    private, loopback, link-local, multicast, carrier-grade NAT, documentation, cloud metadata
//    or otherwise non-global (IPv4 and IPv6). The check runs at connect time for every hop, so
//    DNS rebinding and redirects to internal addresses are blocked. At most 4 redirects, 8 s total.
//  - Size caps apply to the DECOMPRESSED body (gzip/br/deflate are accepted and inflated as a
//    stream that is cut off at the cap): 1 MB of HTML (truncated), 256 KB of oEmbed JSON, 3 MB of
//    image. Images are identified by magic bytes; only JPEG/PNG/GIF/WebP are returned.
//  - Nothing is logged, nothing is cached (Cache-Control: no-store).
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { createClient } from '@supabase/supabase-js';
import { EMBED_PROVIDERS, needsResolve, oembedUrl, parseEmbed, type Embed } from '@/lib/embeds';
import { decodeHtml, parseHtmlMeta, parseOEmbed, sniffImage, type OEmbedInfo, type PageMeta } from '@/lib/feed/linkMeta';

export const runtime = 'nodejs';
export const maxDuration = 15;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

const TOTAL_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;
const MAX_HTML = 1024 * 1024;
const MAX_JSON = 256 * 1024;
const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_URL = 2048;
const UA = 'Mozilla/5.0 (compatible; KithwallLinkPreview/1.1; +https://kithwall.com)';
const ACCEPT_HTML = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1';
const ACCEPT_IMAGE = 'image/webp,image/jpeg,image/png,image/gif;q=0.9,*/*;q=0.1';

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
    let abort = () => { req.destroy(); };
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const req = lib.request({
      method: 'GET', hostname: host, port: u.port || undefined, path: `${u.pathname}${u.search}`,
      headers: { 'user-agent': UA, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en' },
      lookup: safeLookup as unknown as typeof dnsLookup, agent: false,
      ...(u.protocol === 'https:' ? { servername: net.isIP(host) ? undefined : host } : {}),
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return done(() => resolve({ redirect: res.headers.location }));
      }
      if (status < 200 || status >= 300) { res.resume(); return done(() => reject(new Error('status'))); }
      const ctype = String(res.headers['content-type'] ?? '').toLowerCase();
      const type = ctype.split(';')[0]!.trim();
      const charset = /charset=([^;]+)/.exec(ctype)?.[1]?.trim().replace(/"/g, '');
      const len = Number(res.headers['content-length'] ?? 0);
      if (!truncateOk && len > maxBytes) { res.destroy(); return done(() => reject(new Error('too large'))); }
      // Inflate compressed bodies as a stream; the size cap counts DECOMPRESSED bytes, so a small
      // compression bomb is cut off as soon as it expands past the cap.
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
      let body: NodeJS.ReadableStream & { destroy(): void } = res;
      let inflater: zlib.Gunzip | zlib.BrotliDecompress | zlib.Inflate | null = null;
      if (enc === 'gzip' || enc === 'x-gzip') inflater = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
      else if (enc === 'deflate') inflater = zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
      else if (enc === 'br') inflater = zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
      else if (enc !== '' && enc !== 'identity') { res.destroy(); return done(() => reject(new Error('encoding'))); }
      if (inflater) {
        res.on('error', () => { inflater!.destroy(); done(() => reject(new Error('read failed'))); });
        body = res.pipe(inflater);
      }
      const stop = () => { res.destroy(); inflater?.destroy(); };
      abort = () => { req.destroy(); stop(); };
      const parts: Buffer[] = [];
      let size = 0;
      const finish = () => done(() => resolve({ fetched: { url: u, type, charset, body: Buffer.concat(parts) } }));
      body.on('data', (c: Buffer) => {
        if (settled) return;
        size += c.length;
        if (size > maxBytes) {
          stop();
          if (truncateOk) {
            parts.push(c.subarray(0, c.length - (size - maxBytes)));
            finish();
          } else {
            done(() => reject(new Error('too large')));
          }
          return;
        }
        parts.push(c);
      });
      body.on('end', finish);
      body.on('error', () => {
        // A truncated compressed stream still yields a usable HTML prefix.
        if (truncateOk && size > 0) finish(); else done(() => reject(new Error('read failed')));
      });
    });
    const timer = setTimeout(() => { abort(); done(() => reject(new Error('timeout'))); }, remaining);
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
  let embed: Embed | null = parseEmbed(start);
  let meta: PageMeta = {};
  let pageUrl = start;
  let oembed: OEmbedInfo | null = null;

  // Known video providers: their oEmbed endpoint gives a reliable title + thumbnail without
  // downloading a megabyte of player HTML (or hitting a cookie wall).
  if (embed) oembed = await fetchOEmbed(embed, start.toString(), deadline);

  if (!embed || !oembed?.title) {
    // Ordinary page, a short link that needs resolving (vm.tiktok.com, dai.ly …), or an oEmbed miss.
    let page: Fetched | null = null;
    try {
      page = await safeFetch(start, ACCEPT_HTML, deadline, MAX_HTML, true);
    } catch (e) {
      if (!embed) return json({ error: e instanceof BlockedError ? 'That link can\'t be previewed.' : 'Couldn\'t load that page.' }, 422);
    }
    if (page) {
      if (page.type !== 'text/html' && page.type !== 'application/xhtml+xml') {
        if (!embed) return json({ error: 'That link isn\'t a web page.' }, 422);
      } else {
        pageUrl = page.url;
        meta = parseHtmlMeta(decodeHtml(page.body, page.charset));
        if (!embed) {
          // Redirect target (vm.tiktok.com → tiktok.com/@user/video/…), og:url or og:video.
          embed = parseEmbed(page.url) ?? parseEmbed(meta.canonical) ?? parseEmbed(meta.video);
          if (embed) oembed = await fetchOEmbed(embed, page.url.toString(), deadline);
        }
      }
    }
  }

  // A provider can report a portrait video (Vimeo/Dailymotion/Streamable verticals).
  if (embed && oembed?.width && oembed.height && embed.provider !== 'tiktok' && embed.provider !== 'youtube') {
    embed = { ...embed, aspect: oembed.height > oembed.width ? '9:16' : '16:9' };
  }

  // Image: provider thumbnail (YouTube: try the 1280-px one first), else og:image / twitter:image.
  const candidates: string[] = [];
  if (embed?.provider === 'youtube') candidates.push(`https://i.ytimg.com/vi/${embed.id}/maxresdefault.jpg`);
  if (oembed?.thumbnail) {
    if (embed?.provider === 'vimeo') candidates.push(oembed.thumbnail.replace(/-d_\d+(x\d+)?$/, '-d_1280'));
    candidates.push(oembed.thumbnail);
  }
  if (meta.image) candidates.push(meta.image);
  let image: { mime: string; data: string } | null = null;
  for (const c of [...new Set(candidates)]) {
    if (c.length > MAX_URL || Date.now() > deadline - 200) break;
    image = await fetchImage(c, embed && c !== meta.image ? new URL(oembedUrl(embed)) : pageUrl, deadline);
    if (image) break;
  }

  const host = start.hostname.replace(/^www\./, '');
  const site = embed ? EMBED_PROVIDERS[embed.provider].name : (meta.site ?? host);
  const title = oembed?.title ?? meta.title;
  const description = embed
    ? (meta.description && !oembed?.title ? meta.description : oembed?.author)
    : meta.description;
  return json({
    url: start.toString(), title: title ?? site, description, site, image,
    ...(embed ? { embed } : {}),
  });
}

async function fetchOEmbed(embed: Embed, pageUrl: string, deadline: number): Promise<OEmbedInfo | null> {
  try {
    const r = await safeFetch(checkUrl(oembedUrl(embed, pageUrl)), 'application/json', deadline, MAX_JSON, false);
    if (!/json|javascript|text\/plain|text\/html/.test(r.type)) return null;
    return parseOEmbed(r.body.toString('utf8'));
  } catch { return null; }
}

async function fetchImage(raw: string, base: URL, deadline: number): Promise<{ mime: string; data: string } | null> {
  try {
    const img = await safeFetch(checkUrl(raw.trim(), base), ACCEPT_IMAGE, deadline, MAX_IMAGE, false);
    const mime = sniffImage(img.body);
    // YouTube answers a missing maxresdefault with a 120×90 placeholder (~1 KB): skip it.
    if (!mime || img.body.length < 2000) return null;
    return { mime, data: img.body.toString('base64') };
  } catch { return null; }
}

export function GET() {
  return json({ error: 'Method not allowed.' }, 405);
}
