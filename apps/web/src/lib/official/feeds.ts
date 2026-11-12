// Reading public feeds for the automated accounts (docs/v2/13-official-accounts.md). Pure functions, no
// network: RSS 2.0 and Atom (YouTube's channel feeds are Atom with a `yt:videoId`), turned into plain text.
//
// Feeds are other people's text. Nothing from them is ever treated as markup: tags are removed, entities
// decoded, and what remains is shown by the app as plain text like any post.

export interface FeedItem {
  /** The item's own stable address or id (guid / atom id / link). */
  id: string;
  title: string;
  link: string;
  /** Plain-text summary from the feed, if it has one. */
  summary: string;
  /** Publication time (ms since epoch), or null when the feed gives none we can read. */
  at: number | null;
  /** An attached picture (RSS enclosure), if any. */
  image?: { url: string; bytes?: number };
  /** YouTube: the video id and the channel's name. */
  videoId?: string;
  author?: string;
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', deg: '°',
  middot: '·', bull: '•', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', uuml: 'ü', ouml: 'ö', auml: 'ä',
  ntilde: 'ñ', ccedil: 'ç', pound: '£', euro: '€', times: '×', frac12: '½',
};

/** Decodes character references once. Unknown names are left as they are. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      // Control characters carry nothing a reader should see (keep tab and line breaks).
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return '';
      return String.fromCodePoint(code);
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/** Control characters and invisible separators carry nothing a reader should see (tab and line breaks stay). */
function dropInvisible(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f || c === 0x200b || c === 0x2028 || c === 0x2029 || c === 0xfeff) continue;
    out += ch;
  }
  return out;
}

/**
 * Feed text → plain text. Feeds carry HTML either escaped (&lt;p&gt;) or in CDATA, sometimes both, so:
 * decode once, drop tags, decode what the tags contained. Line breaks survive as single newlines.
 */
export function plain(raw: string | undefined | null): string {
  if (!raw) return '';
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (let pass = 0; pass < 2; pass++) {
    s = s
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
      .replace(/<[^>]{0,2000}>/g, '');
    s = decodeEntities(s);
  }
  return dropInvisible(s)
    .replace(/[ \t\xa0]+/g, ' ')
    .replace(/ ?\r?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Shortens text to `max` characters at a sentence end if there is one late enough, else at a word. */
export function clip(text: string, max: number): string {
  const s = text.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('۔ '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence >= max * 0.5) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(' ');
  return `${(word >= max * 0.5 ? cut.slice(0, word) : cut.slice(0, max - 1)).replace(/[\s,;:–—-]+$/, '')}…`;
}

/** An https address, or null. Feeds are not trusted to hand us anything else. */
export function httpsUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(decodeEntities(raw.trim()));
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(block);
  return m ? m[1] : undefined;
}

function attr(block: string, name: string, attribute: string, where?: RegExp): string | undefined {
  const re = new RegExp(`<${name}\\b([^>]*)>`, 'gi');
  for (let m = re.exec(block); m; m = re.exec(block)) {
    const attrs = m[1] ?? '';
    if (where && !where.test(attrs)) continue;
    const a = new RegExp(`\\b${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
    if (a) return a[2] ?? a[3];
  }
  return undefined;
}

function when(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(plain(raw));
  return Number.isFinite(t) ? t : null;
}

const MAX_FEED = 4 * 1024 * 1024;
const MAX_ITEMS = 60;

/** Items of an RSS or Atom document, in the feed's own order. Malformed items are skipped. */
export function parseFeed(xml: string): FeedItem[] {
  if (typeof xml !== 'string' || xml.length > MAX_FEED) return [];
  const out: FeedItem[] = [];
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (let m = re.exec(xml); m && out.length < MAX_ITEMS; m = re.exec(xml)) {
    const atom = m[1]!.toLowerCase() === 'entry';
    const b = m[2]!;
    const title = clip(plain(tag(b, 'title')).replace(/\n/g, ' '), 300);
    const link = httpsUrl(atom
      ? attr(b, 'link', 'href', /\brel\s*=\s*["']alternate["']/i) ?? attr(b, 'link', 'href')
      : plain(tag(b, 'link')));
    if (!title || !link) continue;
    const idRaw = plain(tag(b, atom ? 'id' : 'guid'));
    const summary = plain(tag(b, atom ? 'summary' : 'description') ?? (atom ? tag(b, 'media:description') : undefined));
    const item: FeedItem = {
      id: (idRaw || link).slice(0, 500), title, link, summary,
      at: when(tag(b, atom ? 'published' : 'pubDate') ?? tag(b, 'updated') ?? tag(b, 'dc:date')),
    };
    const enc = httpsUrl(attr(b, 'enclosure', 'url', /\btype\s*=\s*["']image\/(jpeg|png|webp)["']/i));
    if (enc) {
      const len = Number(attr(b, 'enclosure', 'length'));
      item.image = { url: enc, ...(Number.isFinite(len) && len > 0 ? { bytes: len } : {}) };
    }
    const vid = plain(tag(b, 'yt:videoId'));
    if (/^[A-Za-z0-9_-]{11}$/.test(vid)) item.videoId = vid;
    const author = plain(tag(tag(b, 'author') ?? '', 'name'));
    if (author) item.author = clip(author, 80);
    out.push(item);
  }
  return out;
}
