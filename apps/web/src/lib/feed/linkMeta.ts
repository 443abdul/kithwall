// Pure helpers for link previews (no DOM, no Node APIs), shared by the /api/link-preview route
// and the publisher, and unit-tested in linkMeta.test.ts. Nothing here executes or renders HTML:
// it only pulls a handful of <meta> values out of the page's <head> as plain strings.

export interface PageMeta {
  title?: string;
  description?: string;
  site?: string;
  image?: string;          // raw (possibly relative, entity-decoded) image URL
  imageWidth?: number;
  imageHeight?: number;
  canonical?: string;      // og:url
  video?: string;          // og:video / twitter:player (used only to recognise known providers)
}

const ENT: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', middot: '·',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) { const n = parseInt(k.slice(2), 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    if (k.startsWith('#')) { const n = parseInt(k.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ENT[k] ?? m;
  });
}

/** Decode entities, drop tags and control characters, collapse whitespace, cap length. */
export function cleanText(s: string | undefined | null, n: number): string | undefined {
  if (!s) return undefined;
  const t = decodeEntities(s).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return t ? (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t) : undefined;
}

function attrsOf(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const k = m[1]!.toLowerCase();
    if (!attrs.has(k)) attrs.set(k, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const posInt = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 100_000 ? Math.round(n) : undefined;
};

/** Extract preview metadata from an HTML document (only its <head> is examined). */
export function parseHtmlMeta(html: string): PageMeta {
  // Skip comments and script/style bodies so their contents can't masquerade as tags.
  const stripped = html.slice(0, 1_500_000)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const headEnd = stripped.search(/<\/head\s*>|<body[\s>]/i);
  const head = headEnd > 0 ? stripped.slice(0, headEnd) : stripped.slice(0, 300_000);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\s[^>]*>/gi) ?? []) {
    const a = attrsOf(tag);
    const key = (a.get('property') ?? a.get('name') ?? a.get('itemprop') ?? '').toLowerCase().trim();
    const content = a.get('content');
    if (key && content !== undefined && content.trim() && !meta.has(key)) meta.set(key, content);
  }
  let canonicalLink: string | undefined;
  for (const tag of head.match(/<link\s[^>]*>/gi) ?? []) {
    const a = attrsOf(tag);
    if ((a.get('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical') && a.get('href')) { canonicalLink = a.get('href'); break; }
  }
  const titleTag = /<title[^>]*>([\s\S]{0,4000}?)<\/title>/i.exec(head)?.[1];
  const g = (...keys: string[]) => { for (const k of keys) { const v = meta.get(k); if (v) return v; } return undefined; };
  const image = g('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image', 'thumbnailurl');
  const video = g('og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player');
  const canonical = g('og:url') ?? canonicalLink;
  return {
    title: cleanText(g('og:title', 'twitter:title') ?? titleTag ?? g('title', 'name'), 200),
    description: cleanText(g('og:description', 'twitter:description', 'description'), 400),
    site: cleanText(g('og:site_name', 'application-name', 'apple-mobile-web-app-title'), 100),
    image: image ? decodeEntities(image.trim()) : undefined,
    imageWidth: posInt(g('og:image:width')),
    imageHeight: posInt(g('og:image:height')),
    canonical: canonical ? decodeEntities(canonical.trim()) : undefined,
    video: video ? decodeEntities(video.trim()) : undefined,
  };
}

/** Find the charset declared inside the document (<meta charset> / http-equiv) in its first 4 KB. */
export function sniffCharset(bytes: Uint8Array): string | undefined {
  let s = '';
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]!);
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_.:-]{2,40})/i.exec(s);
  return m?.[1]?.toLowerCase();
}

/** Decode a page body with the header charset, else the <meta> one, else UTF-8 (never throws). */
export function decodeHtml(bytes: Uint8Array, headerCharset?: string): string {
  for (const cs of [headerCharset, sniffCharset(bytes), 'utf-8']) {
    if (!cs) continue;
    try { return new TextDecoder(cs, { fatal: false }).decode(bytes); } catch { /* unknown label */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Identify an image by its magic bytes (servers often mislabel og:images). */
export function sniffImage(b: Uint8Array): ImageMime | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export interface OEmbedInfo { title?: string; author?: string; site?: string; thumbnail?: string; width?: number; height?: number }

/** Read the few plain-string fields we use from an oEmbed JSON response (its `html` is ignored). */
export function parseOEmbed(text: string): OEmbedInfo | null {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
  const num = (k: string) => (typeof r[k] === 'number' ? posInt(String(r[k])) : typeof r[k] === 'string' ? posInt(r[k] as string) : undefined);
  return {
    title: cleanText(str('title'), 200),
    author: cleanText(str('author_name'), 100),
    site: cleanText(str('provider_name'), 100),
    thumbnail: str('thumbnail_url')?.trim() || undefined,
    width: num('width') ?? num('thumbnail_width'),
    height: num('height') ?? num('thumbnail_height'),
  };
}

/**
 * First http(s) URL in a piece of text, as the user typed it (trailing punctuation removed).
 * `complete` is false when the URL runs to the very end of the text (the user may still be typing).
 */
export function firstUrl(text: string): { url: string; complete: boolean } | null {
  const m = /\bhttps?:\/\/[^\s<>"'` ]+/i.exec(text);
  if (!m) return null;
  let url = m[0];
  // Drop trailing punctuation and unbalanced closing brackets.
  for (;;) {
    const last = url.slice(-1);
    if (/[.,!?;:'"*_~]/.test(last)) { url = url.slice(0, -1); continue; }
    if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) { url = url.slice(0, -1); continue; }
    if (last === ']' && !url.includes('[')) { url = url.slice(0, -1); continue; }
    break;
  }
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) && !/^xn--/i.test(u.hostname.split('.').pop() ?? '')) return null;
  const end = m.index + m[0].length;
  return { url, complete: end < text.length };
}

/** Domain shown on a card: "www.nytimes.com" → "nytimes.com". */
export function displayHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, ''); } catch { return ''; }
}
