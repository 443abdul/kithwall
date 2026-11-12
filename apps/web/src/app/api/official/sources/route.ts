// POST /api/official/sources — an admin adds a source of their own for an automated account
// (Admin → Official accounts → "Add a source", docs/v2/13-official-accounts.md §5).
// Body: { account, url, title?, lang?, perDay?, summary? }.
//
// The address is a thing a person typed, so before it is stored the server checks it: https, a public host
// (never an address inside a network), and a feed that really parses with at least one item. A page that only
// points to its feed is followed to it; a YouTube channel address becomes that channel's own feed. Such a
// source shows the headline and a link (with `summary`: also the feed's own summary, for publishers that
// allow it), never pictures; a YouTube source plays in YouTube's own player.
import { randomBytes } from 'node:crypto';
import { admin, json, readJson } from '@/lib/auth/server';
import { adminCaller } from '@/lib/official/adminAuth';
import { cleanSourceUrl, publicGet } from '@/lib/official/fetch';
import { feedLinkIn, feedTitle, parseFeed } from '@/lib/official/feeds';
import { fetchFeed } from '@/lib/official/run';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_SOURCES = 60;
const YT_HOST = /^(www\.|m\.)?youtube\.com$/i;
const YT_FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

interface Body { account?: unknown; url?: unknown; title?: unknown; lang?: unknown; perDay?: unknown; summary?: unknown }

const bad = (error: string, status = 400) => json({ error }, status);

/** A YouTube channel address → that channel's feed. Null when the channel can't be told from it. */
async function youtubeFeed(u: URL): Promise<string | null> {
  const direct = /^\/channel\/(UC[A-Za-z0-9_-]{22})(\/|$)/.exec(u.pathname)?.[1]
    ?? (u.pathname === '/feeds/videos.xml' ? u.searchParams.get('channel_id') : null);
  if (direct && /^UC[A-Za-z0-9_-]{22}$/.test(direct)) return YT_FEED + direct;
  if (!/^\/(@[^/]{2,60}|c\/[^/]{1,80}|user\/[^/]{1,80})(\/|$)/.test(u.pathname)) return null;
  // @name, /c/name and /user/name: the channel's page names its feed.
  const page = await publicGet(`https://www.youtube.com${u.pathname}`, {
    accept: 'text/html', maxBytes: 3 * 1024 * 1024, timeoutMs: 9000, hostOk: (h) => YT_HOST.test(h),
  });
  const html = page.body.toString('utf8');
  const id = /[?&]channel_id=(UC[A-Za-z0-9_-]{22})/.exec(html)?.[1] ?? /"(?:channelId|externalId)":"(UC[A-Za-z0-9_-]{22})"/.exec(html)?.[1];
  return id ? YT_FEED + id : null;
}

export async function POST(req: Request) {
  const denied = await adminCaller(req);
  if (denied) return denied;
  const body = await readJson<Body>(req, 4096);
  if (!body) return bad('bad_request');
  const account = typeof body.account === 'string' ? body.account : '';
  const address = cleanSourceUrl(typeof body.url === 'string' ? body.url : '');
  if (!/^[a-z]{2,20}$/.test(account)) return bad('account');
  if (!address) return bad('address');
  const lang = typeof body.lang === 'string' && /^[a-z]{2}$/.test(body.lang) ? body.lang : 'en';
  const perDay = Math.min(24, Math.max(1, Math.round(Number(body.perDay) || 2)));

  const db = admin();
  const { data: def } = await db.from('official_account_defs').select('slug').eq('slug', account).maybeSingle();
  if (!def) return bad('account');
  const { count } = await db.from('official_sources').select('id', { count: 'exact', head: true });
  if ((count ?? 0) >= MAX_SOURCES) return bad('too_many');

  try {
    const u = new URL(address);
    const youtube = YT_HOST.test(u.hostname);
    let feedUrl: string | null = youtube ? await youtubeFeed(u) : address;
    if (!feedUrl) return bad('no_feed');
    let xml = await fetchFeed(feedUrl);
    let items = parseFeed(xml);
    if (!items.length && !youtube) {
      // Not a feed: perhaps the site's front page, which says where its feed is.
      const linked = feedLinkIn(xml, feedUrl);
      const next = linked ? cleanSourceUrl(linked) : null;
      if (next) {
        feedUrl = next;
        xml = await fetchFeed(feedUrl);
        items = parseFeed(xml);
      }
    }
    if (!items.length || (youtube && !items.some((i) => i.videoId))) return bad('no_feed');

    const given = typeof body.title === 'string' ? body.title.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
    const title = given.length >= 2 ? given : feedTitle(xml) || new URL(feedUrl).hostname.replace(/^www\./, '');
    const { data: dup } = await db.from('official_sources').select('id').eq('url', feedUrl).maybeSingle();
    if (dup) return bad('exists', 409);
    const id = `c-${randomBytes(5).toString('hex')}`;
    const { error } = await db.from('official_sources').insert({
      id, account, kind: youtube ? 'youtube' : 'rss', title: title.length >= 2 ? title : 'Feed', url: feedUrl, lang,
      terms: youtube ? 'embed' : body.summary === true ? 'summary' : 'headline', per_day: perDay, enabled: true, custom: true, position: 1000,
    });
    if (error) throw new Error(error.message);
    return json({ id, title, kind: youtube ? 'youtube' : 'rss', items: items.length, latest: items[0]!.title });
  } catch (e) {
    const why = String((e as Error)?.message ?? '');
    // What the publisher's server said is useful to the admin ("answered 403"); nothing else leaves the server.
    return bad(/^(answered \d{3}|timed out|too large|not https|not a public address|could not connect|too many redirects|redirected to a place that is not public|not an allowed host)$/.test(why) ? `fetch: ${why}` : 'failed', 422);
  }
}
