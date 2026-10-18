// Video embeds (click-to-play). Pure functions shared by the browser and the link-preview route:
//
//   parseEmbed(url)  → { provider, id, aspect, start?, hash? } | null   (recognises the URL shapes below)
//   validEmbed(x)    → the same object if it is well formed, else null   (use on decrypted payloads)
//   embedSrc(e)      → the most private player URL for that provider       (only built from validated ids)
//
// Only these providers ever play inside Kithwall, and only after the viewer presses play. Their
// player origins are the only entries in the CSP frame-src (src/proxy.ts).

export type EmbedProvider = 'youtube' | 'vimeo' | 'dailymotion' | 'streamable' | 'tiktok';
export type EmbedAspect = '16:9' | '9:16';

export interface Embed {
  provider: EmbedProvider;
  id: string;
  aspect: EmbedAspect;
  /** Start offset in seconds (YouTube / Vimeo timestamps). */
  start?: number;
  /** Vimeo unlisted-video hash (vimeo.com/123/abcdef). */
  hash?: string;
}

export const EMBED_PROVIDERS: Record<EmbedProvider, { name: string; host: string }> = {
  youtube: { name: 'YouTube', host: 'youtube.com' },
  vimeo: { name: 'Vimeo', host: 'vimeo.com' },
  dailymotion: { name: 'Dailymotion', host: 'dailymotion.com' },
  streamable: { name: 'Streamable', host: 'streamable.com' },
  tiktok: { name: 'TikTok', host: 'tiktok.com' },
};

/** Player origins allowed in CSP frame-src (keep in sync with embedSrc). */
export const EMBED_FRAME_ORIGINS = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://www.dailymotion.com',
  'https://geo.dailymotion.com',
  'https://streamable.com',
  'https://www.tiktok.com',
] as const;

const ID_RE: Record<EmbedProvider, RegExp> = {
  youtube: /^[A-Za-z0-9_-]{11}$/,
  vimeo: /^\d{1,12}$/,
  dailymotion: /^[a-zA-Z0-9]{5,20}$/,
  streamable: /^[a-zA-Z0-9]{3,16}$/,
  tiktok: /^\d{8,25}$/,
};
const HASH_RE = /^[0-9a-f]{6,24}$/;

function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/\.$/, '');
}
const isHost = (h: string, domain: string) => h === domain || h.endsWith(`.${domain}`);

/** "90", "1m30s", "1h2m3s", "90s" → seconds (0 if unparsable). */
export function parseTime(raw: string | null | undefined): number {
  if (!raw) return 0;
  const s = raw.trim().toLowerCase();
  if (/^\d{1,6}$/.test(s)) return Number(s);
  const m = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function withStart(e: Embed, t: number): Embed {
  return t > 0 && t < 86_400 ? { ...e, start: Math.floor(t) } : e;
}

function youtube(u: URL, h: string): Embed | null {
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  let aspect: EmbedAspect = '16:9';
  if (h === 'youtu.be') id = parts[0];
  else if (isHost(h, 'youtube.com') || isHost(h, 'youtube-nocookie.com')) {
    if (parts[0] === 'watch' || u.pathname === '/') id = u.searchParams.get('v') ?? undefined;
    else if (parts[0] === 'shorts') { id = parts[1]; aspect = '9:16'; }
    else if (['embed', 'v', 'e', 'live'].includes(parts[0] ?? '')) id = parts[1];
    else if (parts[0] === 'attribution_link') {
      const inner = u.searchParams.get('u');
      if (inner?.startsWith('/')) return youtube(new URL(inner, 'https://www.youtube.com'), 'www.youtube.com');
    }
  } else return null;
  if (!id || !ID_RE.youtube.test(id)) return null;
  const hashT = /(?:^|&)t=([^&]+)/.exec(u.hash.slice(1))?.[1];
  return withStart({ provider: 'youtube', id, aspect }, parseTime(u.searchParams.get('t') ?? u.searchParams.get('start') ?? hashT));
}

function vimeo(u: URL, h: string): Embed | null {
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  let hash: string | undefined;
  if (h === 'player.vimeo.com') {
    if (parts[0] !== 'video') return null;
    id = parts[1];
    hash = u.searchParams.get('h') ?? undefined;
  } else if (h === 'vimeo.com' || h === 'www.vimeo.com') {
    // vimeo.com/123, /123/abcdef (unlisted), /channels/x/123, /groups/x/videos/123, /album/x/video/123, /showcase/x/video/123
    let i = -1;
    if (ID_RE.vimeo.test(parts[0] ?? '')) i = 0;
    else if (parts[0] === 'channels' && parts.length >= 3) i = 2;
    else if (parts[0] === 'groups' && parts[2] === 'videos') i = 3;
    else if ((parts[0] === 'album' || parts[0] === 'showcase') && parts[2] === 'video') i = 3;
    if (i < 0) return null;
    id = parts[i];
    const next = parts[i + 1];
    if (next && HASH_RE.test(next) && parts.length === i + 2) hash = next;
    else if (parts.length > i + 1) return null;
  } else return null;
  if (!id || !ID_RE.vimeo.test(id)) return null;
  const e: Embed = { provider: 'vimeo', id, aspect: '16:9', ...(hash && HASH_RE.test(hash) ? { hash } : {}) };
  const t = /(?:^|&)t=([^&]+)/.exec(u.hash.slice(1))?.[1];
  return withStart(e, parseTime(t));
}

function dailymotion(u: URL, h: string): Embed | null {
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  if (h === 'dai.ly') id = parts[0];
  else if (h === 'geo.dailymotion.com') id = u.searchParams.get('video') ?? undefined;
  else if (isHost(h, 'dailymotion.com')) {
    if (parts[0] === 'video') id = parts[1];
    else if (parts[0] === 'embed' && parts[1] === 'video') id = parts[2];
  } else return null;
  id = id?.split('_')[0];
  if (!id || !ID_RE.dailymotion.test(id)) return null;
  return { provider: 'dailymotion', id, aspect: '16:9' };
}

const STREAMABLE_RESERVED = new Set([
  'login', 'signup', 'settings', 'pricing', 'about', 'blog', 'terms', 'privacy', 'support', 'documentation',
  'upload', 'videos', 'clipper', 'tools', 'enterprise', 'careers', 'contact', 'help', 'logout', 'recover',
]);

function streamable(u: URL, h: string): Embed | null {
  if (h !== 'streamable.com' && h !== 'www.streamable.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  if (parts.length === 1) id = parts[0];
  else if (parts.length === 2 && ['e', 'o', 's'].includes(parts[0]!)) id = parts[1];
  if (!id || STREAMABLE_RESERVED.has(id.toLowerCase()) || !ID_RE.streamable.test(id)) return null;
  return { provider: 'streamable', id, aspect: '16:9' };
}

function tiktok(u: URL, h: string): Embed | null {
  if (!isHost(h, 'tiktok.com')) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  if (parts[0]?.startsWith('@') && parts[1] === 'video') id = parts[2];
  else if (parts[0] === 'embed' && parts[1] === 'v2') id = parts[2];
  else if (parts[0] === 'embed') id = parts[1];
  else if (parts[0] === 'player' && parts[1] === 'v1') id = parts[2];
  else if (parts[0] === 'v' && parts[1]) id = parts[1].replace(/\.html$/, '');
  else if (parts[0] === 'video') id = parts[1];
  if (!id || !ID_RE.tiktok.test(id)) return null;
  return { provider: 'tiktok', id, aspect: '9:16' };
}

/** Recognise a playable video URL. Short links that need a redirect (vm.tiktok.com) return null. */
export function parseEmbed(raw: string | URL | null | undefined): Embed | null {
  if (!raw) return null;
  let u: URL;
  try { u = typeof raw === 'string' ? new URL(raw.trim()) : raw; } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const h = hostOf(u);
  if (h === 'youtu.be' || isHost(h, 'youtube.com') || isHost(h, 'youtube-nocookie.com')) return youtube(u, h);
  if (isHost(h, 'vimeo.com')) return vimeo(u, h);
  if (h === 'dai.ly' || isHost(h, 'dailymotion.com')) return dailymotion(u, h);
  if (isHost(h, 'streamable.com')) return streamable(u, h);
  if (isHost(h, 'tiktok.com')) return tiktok(u, h);
  return null;
}

/** Short-link hosts whose target must be resolved (through the preview proxy) before parseEmbed works. */
export function needsResolve(raw: string): boolean {
  try {
    const h = hostOf(new URL(raw));
    return h === 'vm.tiktok.com' || h === 'vt.tiktok.com' || (isHost(h, 'tiktok.com') && new URL(raw).pathname.startsWith('/t/'));
  } catch { return false; }
}

/** Validate an embed object from untrusted input (a decrypted payload or the proxy's response). */
export function validEmbed(x: unknown): Embed | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const provider = o.provider as EmbedProvider;
  if (typeof provider !== 'string' || !Object.prototype.hasOwnProperty.call(ID_RE, provider)) return null;
  if (typeof o.id !== 'string' || !ID_RE[provider].test(o.id)) return null;
  const aspect: EmbedAspect = o.aspect === '9:16' ? '9:16' : '16:9';
  const e: Embed = { provider, id: o.id, aspect };
  if (typeof o.start === 'number' && Number.isInteger(o.start) && o.start > 0 && o.start < 86_400) e.start = o.start;
  if (provider === 'vimeo' && typeof o.hash === 'string' && HASH_RE.test(o.hash)) e.hash = o.hash;
  return e;
}

/** Player URL in the most private mode each provider offers. Autoplays because it loads on a tap. */
export function embedSrc(e: Embed): string | null {
  const v = validEmbed(e);
  if (!v) return null;
  const id = encodeURIComponent(v.id);
  switch (v.provider) {
    case 'youtube':
      return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1${v.start ? `&start=${v.start}` : ''}`;
    case 'vimeo':
      return `https://player.vimeo.com/video/${id}?dnt=1&autoplay=1${v.hash ? `&h=${v.hash}` : ''}${v.start ? `#t=${v.start}s` : ''}`;
    case 'dailymotion':
      return `https://www.dailymotion.com/embed/video/${id}?autoplay=1`;
    case 'streamable':
      return `https://streamable.com/e/${id}?autoplay=1`;
    case 'tiktok':
      return `https://www.tiktok.com/player/v1/${id}?autoplay=1`;
  }
}

/** Canonical page URL on the provider (used for oEmbed lookups and "Open on …" links). */
export function embedPageUrl(e: Embed): string {
  const id = encodeURIComponent(e.id);
  switch (e.provider) {
    case 'youtube': return e.aspect === '9:16' ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;
    case 'vimeo': return `https://vimeo.com/${id}${e.hash ? `/${e.hash}` : ''}`;
    case 'dailymotion': return `https://www.dailymotion.com/video/${id}`;
    case 'streamable': return `https://streamable.com/${id}`;
    case 'tiktok': return `https://www.tiktok.com/@/video/${id}`;
  }
}

/** oEmbed endpoint (JSON) for the provider; only these fixed hosts are queried by the proxy. */
export function oembedUrl(e: Embed, pageUrl?: string): string {
  const page = encodeURIComponent(pageUrl ?? embedPageUrl(e));
  switch (e.provider) {
    case 'youtube': return `https://www.youtube.com/oembed?format=json&url=${page}`;
    case 'vimeo': return `https://vimeo.com/api/oembed.json?width=1280&url=${page}`;
    case 'dailymotion': return `https://www.dailymotion.com/services/oembed?format=json&url=${page}`;
    case 'streamable': return `https://api.streamable.com/oembed.json?url=${page}`;
    case 'tiktok': return `https://www.tiktok.com/oembed?url=${page}`;
  }
}
