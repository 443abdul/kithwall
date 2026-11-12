// What an automated account posts (docs/v2/13-official-accounts.md). Pure functions: a feed item and the
// source's terms go in, a draft of a Public link post comes out. No network here.
//
// The rule every draft follows: show only what the source allows, name the source in the post itself, and
// link to the original. A source's `terms` decide how much of the item is shown:
//   public-domain  title, summary, picture                       (NASA)
//   cc             title, excerpt, licence named; a picture only when its own licence is free
//   summary        title and the publisher's own feed summary
//   headline       title only
//   embed          title; the video plays in the publisher's own player
import { clip, httpsUrl, plain, type FeedItem } from './feeds';
import type { LinkEmbed, PostPayload } from '../types';

export type SourceKind = 'rss' | 'youtube' | 'wikipedia' | 'nasa-image';
export type SourceTerms = 'public-domain' | 'cc' | 'summary' | 'headline' | 'embed';

export interface Source {
  id: string; account: string; kind: SourceKind; title: string; url: string; lang: string; terms: SourceTerms;
  per_day: number; enabled: boolean;
  /** Items whose title matches this pattern are left out (e.g. a section of a feed with different terms). */
  skip_title?: string | null;
}

/**
 * A post waiting to be signed: the payload without its picture, and where the picture comes from. The link
 * card carries the title and the site only; what the source lets us quote is in the post's text, once.
 */
export interface Draft {
  /** What makes this item this item (hashed into official_items.item_key). */
  key: string;
  text: string;
  link: NonNullable<PostPayload['link']>;
  /** A picture we may show, to be fetched, encrypted and attached as the link's image. */
  imageUrl?: string;
  /** When the item was published (ms), for "is this still news". */
  at: number | null;
}

const WORDS: Record<string, { source: string; image: string; text: string; onThisDay: string; featured: string; picture: string; didYouKnow: string; video: string }> = {
  en: {
    source: 'Source', image: 'Image', text: 'Text', onThisDay: 'On this day', featured: 'Featured article',
    picture: 'Picture of the day', didYouKnow: 'Did you know', video: 'Video',
  },
  ur: {
    source: 'ماخذ', image: 'تصویر', text: 'متن', onThisDay: 'آج کے دن', featured: 'منتخب مضمون',
    picture: 'آج کی تصویر', didYouKnow: 'کیا آپ جانتے ہیں', video: 'ویڈیو',
  },
};
const words = (lang: string) => WORDS[lang] ?? WORDS.en!;

const SUMMARY_MAX = 420;
const TITLE_MAX = 200;

function site(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Title, optional body, and a last line that names the source. */
function compose(parts: (string | undefined | false)[]): string {
  return parts.filter((p): p is string => !!p && !!p.trim()).map((p) => p.trim()).join('\n\n');
}

/** A feed's summary often just repeats the headline; say it once. */
function summaryOf(item: FeedItem, max = SUMMARY_MAX): string {
  const s = clip(item.summary.replace(/\n+/g, ' '), max);
  if (!s || s.toLowerCase().startsWith(item.title.toLowerCase().slice(0, 60))) return '';
  return s;
}

export function draftFromRss(src: Source, item: FeedItem): Draft {
  const w = words(src.lang);
  const title = clip(item.title, TITLE_MAX);
  const body = src.terms === 'headline' || src.terms === 'embed' ? '' : summaryOf(item);
  return {
    key: item.id,
    text: compose([title, body, `${w.source}: ${src.title}`]),
    link: { url: item.link, title, site: src.title },
    at: item.at,
  };
}

/**
 * NASA's feed links the original file, often 5 to 10 MB. Its site serves any upload at a requested width, so
 * ask for one that suits a post (the fetch still refuses anything over MAX_IMAGE_BYTES).
 */
export function nasaImageUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)nasa\.gov$/i.test(u.hostname) && u.pathname.startsWith('/wp-content/uploads/')) u.searchParams.set('w', '1280');
    return u.toString();
  } catch { return url; }
}

export function draftFromNasaImage(src: Source, item: FeedItem): Draft {
  const w = words(src.lang);
  const title = clip(item.title, TITLE_MAX);
  const body = summaryOf(item, 600);
  return {
    key: item.id,
    text: compose([title, body, `${w.image}: NASA`]),
    link: { url: item.link, title, site: src.title },
    ...(item.image ? { imageUrl: nasaImageUrl(item.image.url) } : {}),
    at: item.at,
  };
}

export function draftFromYoutube(src: Source, item: FeedItem): Draft | null {
  if (!item.videoId) return null;
  const w = words(src.lang);
  const title = clip(item.title, TITLE_MAX);
  const channel = item.author || src.title;
  const embed: LinkEmbed = { provider: 'youtube', id: item.videoId, aspect: '16:9' };
  return {
    key: `yt:${item.videoId}`,
    text: compose([title, `${w.video}: ${channel} · YouTube`]),
    link: { url: `https://www.youtube.com/watch?v=${item.videoId}`, title, site: 'YouTube', embed },
    at: item.at,
  };
}

/** The largest picture we fetch. Bigger ones are posted without the picture. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// ---------------------------------------------------------------------------------------
// Wikipedia's daily feed (api.wikimedia.org/feed/v1/wikipedia/<lang>/featured/YYYY/MM/DD)
// ---------------------------------------------------------------------------------------
interface WikiPage { titles?: { normalized?: string }; extract?: string; content_urls?: { desktop?: { page?: string } } }
interface WikiFeatured {
  tfa?: WikiPage;
  image?: {
    title?: string; file_page?: string; thumbnail?: { source?: string }; description?: { text?: string; html?: string };
    artist?: { text?: string; html?: string }; credit?: { text?: string; html?: string }; license?: { type?: string; code?: string };
  };
  onthisday?: { text?: string; year?: number | string; pages?: WikiPage[] }[];
}

/** Licences under which a Commons picture may be shown with credit. Anything else: no picture. */
export function freeLicence(code: string | undefined): boolean {
  return !!code && /^(pd|cc0|cc-zero|cc-pd.*|cc-by(-sa)?(-\d(\.\d)?)?(-[a-z]{2,5})?)$/i.test(code.trim());
}

const pageUrl = (p: WikiPage | undefined) => httpsUrl(p?.content_urls?.desktop?.page);
const CC = 'Wikipedia, CC BY-SA 4.0';

/**
 * Up to three posts from one day's feed: the featured article, the picture of the day (only when its own
 * licence is free; credited to its author with the licence named) and "on this day". `day` is YYYY-MM-DD and
 * is part of each key, so each is posted once a day.
 */
export function draftsFromWikipedia(src: Source, json: unknown, day: string): Draft[] {
  const w = words(src.lang);
  const d = (json && typeof json === 'object' ? json : {}) as WikiFeatured;
  const out: Draft[] = [];
  const at = Date.parse(`${day}T00:00:00Z`) || null;

  const tfaUrl = pageUrl(d.tfa);
  const tfaTitle = plain(d.tfa?.titles?.normalized);
  const extract = clip(plain(d.tfa?.extract).replace(/\n+/g, ' '), 600);
  if (tfaUrl && tfaTitle && extract) {
    out.push({
      key: `tfa:${day}`,
      text: compose([`${w.featured}: ${tfaTitle}`, extract, `${w.text}: ${CC}`]),
      link: { url: tfaUrl, title: tfaTitle, site: 'Wikipedia' },
      at,
    });
  }

  const img = d.image;
  const filePage = httpsUrl(img?.file_page);
  const thumb = httpsUrl(img?.thumbnail?.source);
  if (img && filePage && thumb && freeLicence(img.license?.code)) {
    const about = clip(plain(img.description?.text ?? img.description?.html).replace(/\n+/g, ' '), 500);
    const by = clip(plain(img.artist?.text ?? img.artist?.html ?? img.credit?.text ?? img.credit?.html).replace(/\n+/g, ' '), 120);
    const licence = clip(plain(img.license?.type) || 'free licence', 40);
    const title = clip(plain(img.title).replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' '), TITLE_MAX) || w.picture;
    out.push({
      key: `potd:${day}`,
      text: compose([w.picture, about, `${w.image}: ${by ? `${by} · ` : ''}${licence} · Wikimedia Commons`]),
      link: { url: filePage, title, site: 'Wikimedia Commons' },
      imageUrl: thumb,
      at,
    });
  }

  const events = (Array.isArray(d.onthisday) ? d.onthisday : [])
    .map((e) => ({ year: String(e.year ?? '').trim(), text: clip(plain(e.text).replace(/\n+/g, ' '), 260), url: pageUrl(e.pages?.[0]) }))
    .filter((e) => /^-?\d{1,4}$/.test(e.year) && e.text)
    .slice(0, 3);
  const first = events.find((e) => e.url);
  if (events.length && first?.url) {
    out.push({
      key: `otd:${day}`,
      text: compose([w.onThisDay, events.map((e) => `${e.year}: ${e.text}`).join('\n'), `${w.text}: ${CC}`]),
      link: { url: first.url, title: w.onThisDay, site: 'Wikipedia' },
      at,
    });
  }
  return out;
}

/** Feed items → drafts, newest first, for one source. */
export function draftsFromFeed(src: Source, items: FeedItem[]): Draft[] {
  let skip: RegExp | null = null;
  try { if (src.skip_title && src.skip_title.length <= 200) skip = new RegExp(src.skip_title, 'i'); } catch { skip = null; }
  const drafts = items.filter((it) => !skip || !skip.test(it.title)).map((it) => (
    src.kind === 'youtube' ? draftFromYoutube(src, it) : src.kind === 'nasa-image' ? draftFromNasaImage(src, it) : draftFromRss(src, it)
  )).filter((d): d is Draft => d !== null && !!site(d.link.url));
  return drafts.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** News older than this is not news: a source that was just switched on does not post its whole backlog. */
export const FRESH_MS = 3 * 24 * 3600_000;

export const isFresh = (d: Draft, now: number) => d.at === null || (d.at <= now + 3600_000 && now - d.at <= FRESH_MS);

/** A source's newest item may be this old and still be posted, once: a weekly blog is quiet, not stale. */
export const LATEST_MS = 30 * 24 * 3600_000;

/** What a source has to offer now (drafts come newest first): everything fresh, or failing that its newest item. */
export function freshOrLatest(drafts: Draft[], now: number): Draft[] {
  const fresh = drafts.filter((d) => isFresh(d, now));
  if (fresh.length) return fresh;
  const newest = drafts[0];
  return newest && newest.at !== null && newest.at <= now + 3600_000 && now - newest.at <= LATEST_MS ? [newest] : [];
}

/**
 * The day's posts for one account: each source gives at most `per_day`, sources take turns so one busy feed
 * does not crowd out the others, and the account posts at most `cap`.
 */
export function pickForAccount(perSource: { source: Source; drafts: Draft[] }[], cap: number): { source: Source; draft: Draft }[] {
  const queues = perSource.map((s) => ({ source: s.source, drafts: s.drafts.slice(0, Math.max(1, s.source.per_day)) }));
  const out: { source: Source; draft: Draft }[] = [];
  for (let round = 0; out.length < cap; round++) {
    let took = false;
    for (const q of queues) {
      const d = q.drafts[round];
      if (!d) continue;
      took = true;
      out.push({ source: q.source, draft: d });
      if (out.length >= cap) break;
    }
    if (!took) break;
  }
  return out;
}

/**
 * When each of today's posts goes out: the first now, the rest evenly over the next `hours`, so the account
 * is alive all day although the job runs once. Returns ISO times (null: now).
 */
export function spread(count: number, now: number, hours = 20): (string | null)[] {
  if (count <= 0) return [];
  const step = count > 1 ? (hours * 3600_000) / count : 0;
  return Array.from({ length: count }, (_, i) => (i === 0 ? null : new Date(now + Math.round(i * step)).toISOString()));
}
