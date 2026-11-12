import { describe, expect, it } from 'vitest';
import { generateIdentity, openEnvelope, sealEnvelope } from '@kithwall/crypto';
import { clip, decodeEntities, httpsUrl, parseFeed, plain } from './feeds';
import {
  draftFromRss, draftsFromFeed, draftsFromWikipedia, freeLicence, isFresh, nasaImageUrl, pickForAccount, spread, FRESH_MS,
  type Draft, type Source,
} from './compose';
import { imageInfo } from './image';
import { postHeader } from '../postHeader';
import { validEmbed } from '../embeds';

const src = (over: Partial<Source> = {}): Source => ({
  id: 's', account: 'news', kind: 'rss', title: 'UN News', url: 'https://example.org/feed', lang: 'en', terms: 'summary', per_day: 2, enabled: true, ...over,
});

const RSS = `<?xml version="1.0"?><rss><channel><title>Feed</title>
<item>
  <title>Blue helmets &amp; a ceasefire</title>
  <link>https://news.example.org/story/1</link>
  <description><![CDATA[<p>After 48 years the mission ends.</p><script>alert(1)</script> <a href="x">More</a>]]></description>
  <enclosure url="https://www.nasa.gov/a.jpg" length="1621812" type="image/jpeg" />
  <guid isPermaLink="true">https://news.example.org/story/1</guid>
  <pubDate>Wed, 11 Nov 2026 12:00:00 +0000</pubDate>
</item>
<item><title>No link here</title><description>x</description></item>
<item><title>Plain http</title><link>http://news.example.org/2</link></item>
<item><title>&lt;b&gt;Escaped&lt;/b&gt; markup</title><link>https://news.example.org/3</link><description>&lt;p&gt;One&lt;/p&gt;&lt;p&gt;Two&lt;/p&gt;</description></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
<entry>
  <id>yt:video:fEjvSbI_PT4</id><yt:videoId>fEjvSbI_PT4</yt:videoId>
  <title>What Actually Happens?</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=fEjvSbI_PT4"/>
  <author><name>Kurzgesagt – In a Nutshell</name><uri>https://www.youtube.com/channel/x</uri></author>
  <published>2026-11-10T15:00:01+00:00</published>
  <media:group><media:description>Sponsored text https://shop.example</media:description></media:group>
</entry>
<entry><id>bad</id><yt:videoId>not a video id</yt:videoId><title>Odd</title><link rel="alternate" href="https://www.youtube.com/watch?v=zzz"/></entry>
</feed>`;

describe('feed text', () => {
  it('turns markup into plain text and never keeps a tag', () => {
    expect(plain('<p>One</p><p>Two &amp; three</p>')).toBe('One\nTwo & three');
    expect(plain('&lt;img src=x onerror=alert(1)&gt;Hello')).toBe('Hello');
    expect(plain('<![CDATA[<b>Bold</b> &#8220;quoted&#8221;]]>')).toBe('Bold “quoted”');
    expect(plain('a<script>steal()</script>b')).toBe('a b');
    expect(plain(null)).toBe('');
  });
  it('decodes references once and drops control characters', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('&#0;&#7;&#x41;&unknown;')).toBe('A&unknown;');
  });
  it('clips at a sentence or a word', () => {
    expect(clip('Short.', 50)).toBe('Short.');
    expect(clip('First sentence is here. Second one is much longer than that', 40)).toBe('First sentence is here.');
    expect(clip('word '.repeat(30), 22).endsWith('…')).toBe(true);
    expect(clip('word '.repeat(30), 22).length).toBeLessThanOrEqual(22);
  });
  it('accepts only https addresses without credentials', () => {
    expect(httpsUrl('https://example.org/a?b=1&amp;c=2')).toBe('https://example.org/a?b=1&c=2');
    expect(httpsUrl('http://example.org')).toBeNull();
    expect(httpsUrl('javascript:alert(1)')).toBeNull();
    expect(httpsUrl('https://user:pw@example.org')).toBeNull();
    expect(httpsUrl('')).toBeNull();
  });
});

describe('parseFeed', () => {
  it('reads RSS items and skips the ones without a usable link', () => {
    const items = parseFeed(RSS);
    expect(items.map((i) => i.title)).toEqual(['Blue helmets & a ceasefire', 'Escaped markup']);
    expect(items[0]).toMatchObject({
      id: 'https://news.example.org/story/1', link: 'https://news.example.org/story/1',
      summary: 'After 48 years the mission ends.\nMore', image: { url: 'https://www.nasa.gov/a.jpg', bytes: 1621812 },
    });
    expect(items[0]!.at).toBe(Date.parse('2026-11-11T12:00:00Z'));
    expect(items[1]!.summary).toBe('One\nTwo');
  });
  it('reads YouTube channel feeds', () => {
    const items = parseFeed(ATOM);
    expect(items[0]).toMatchObject({ videoId: 'fEjvSbI_PT4', author: 'Kurzgesagt – In a Nutshell', link: 'https://www.youtube.com/watch?v=fEjvSbI_PT4' });
    expect(items[1]!.videoId).toBeUndefined();
  });
  it('returns nothing for junk', () => {
    expect(parseFeed('')).toEqual([]);
    expect(parseFeed('<html><body>Not a feed</body></html>')).toEqual([]);
    expect(parseFeed('x'.repeat(5 * 1024 * 1024))).toEqual([]);
  });
});

describe('drafts', () => {
  const item = parseFeed(RSS)[0]!;
  it('shows only what the source allows, and always names the source', () => {
    const summary = draftFromRss(src(), item);
    expect(summary.text).toBe('Blue helmets & a ceasefire\n\nAfter 48 years the mission ends. More\n\nSource: UN News');
    expect(summary.link).toMatchObject({ url: item.link, site: 'UN News' });
    const headline = draftFromRss(src({ terms: 'headline', title: 'BBC News' }), item);
    expect(headline.text).toBe('Blue helmets & a ceasefire\n\nSource: BBC News');
    expect(headline.link.description).toBeUndefined();
    expect(summary.link.description).toBeUndefined();
    expect(draftFromRss(src({ lang: 'ur', title: 'یو این نیوز' }), item).text.endsWith('ماخذ: یو این نیوز')).toBe(true);
  });
  it('never copies a picture from a feed that only allows a summary', () => {
    expect(draftsFromFeed(src(), parseFeed(RSS)).every((d) => d.imageUrl === undefined)).toBe(true);
    expect(draftsFromFeed(src({ kind: 'nasa-image', terms: 'public-domain', title: 'NASA Image of the Day' }), parseFeed(RSS))
      .find((d) => d.key === item.id)!.imageUrl).toBe('https://www.nasa.gov/a.jpg');
  });
  it('makes YouTube posts that play in the publisher’s own player, and nothing from a malformed entry', () => {
    const drafts = draftsFromFeed(src({ kind: 'youtube', terms: 'embed', title: 'Kurzgesagt' }), parseFeed(ATOM));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.key).toBe('yt:fEjvSbI_PT4');
    expect(drafts[0]!.text).toBe('What Actually Happens?\n\nVideo: Kurzgesagt – In a Nutshell · YouTube');
    expect(validEmbed(drafts[0]!.link.embed)).toEqual({ provider: 'youtube', id: 'fEjvSbI_PT4', aspect: '16:9' });
    expect(drafts[0]!.text).not.toContain('Sponsored');
  });
  it('leaves out titles the source says to skip, and asks NASA for a picture of a sensible size', () => {
    const feed = parseFeed(RSS);
    expect(draftsFromFeed(src({ skip_title: '^Blue' }), feed).map((d) => d.link.title)).toEqual(['Escaped markup']);
    expect(draftsFromFeed(src({ skip_title: '((' }), feed)).toHaveLength(2);
    expect(nasaImageUrl('https://www.nasa.gov/wp-content/uploads/2026/11/a.jpg')).toBe('https://www.nasa.gov/wp-content/uploads/2026/11/a.jpg?w=1280');
    expect(nasaImageUrl('https://example.org/wp-content/uploads/a.jpg')).toBe('https://example.org/wp-content/uploads/a.jpg');
  });
  it('keeps only fresh news', () => {
    const now = Date.parse('2026-11-12T00:00:00Z');
    const d = (at: number | null): Draft => ({ key: 'k', text: 't', link: { url: 'https://e.org' }, at });
    expect(isFresh(d(now - 1000), now)).toBe(true);
    expect(isFresh(d(now - FRESH_MS - 1), now)).toBe(false);
    expect(isFresh(d(now + 2 * 3600_000), now)).toBe(false);
    expect(isFresh(d(null), now)).toBe(true);
  });
});

describe('Wikipedia', () => {
  const page = (t: string) => ({ titles: { normalized: t }, content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${t}` } } });
  const feed = {
    tfa: { ...page('Philae'), extract: 'Philae is a robotic lander.' },
    image: {
      title: 'File:Comet_67P.jpg', file_page: 'https://commons.wikimedia.org/wiki/File:Comet_67P.jpg',
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/960px-Comet.jpg' },
      description: { html: '<a href="x">Comet</a> seen by <b>Rosetta</b>' }, artist: { html: '<bdi>ESA</bdi>' },
      license: { type: 'CC BY-SA 4.0', code: 'cc-by-sa-4.0' },
    },
    onthisday: [
      { text: 'Philae landed on a comet.', year: 2014, pages: [page('Philae')] },
      { text: 'A second event.', year: 1970, pages: [] },
    ],
  };
  const w = src({ kind: 'wikipedia', terms: 'cc', title: 'Wikipedia', account: 'learn' });

  it('makes the three daily posts with credit and licence', () => {
    const d = draftsFromWikipedia(w, feed, '2026-11-12');
    expect(d.map((x) => x.key)).toEqual(['tfa:2026-11-12', 'potd:2026-11-12', 'otd:2026-11-12']);
    expect(d[0]!.text).toBe('Featured article: Philae\n\nPhilae is a robotic lander.\n\nText: Wikipedia, CC BY-SA 4.0');
    expect(d[0]!.imageUrl).toBeUndefined();
    expect(d[1]!.text).toBe('Picture of the day\n\nComet seen by Rosetta\n\nImage: ESA · CC BY-SA 4.0 · Wikimedia Commons');
    expect(d[1]!.imageUrl).toBe('https://upload.wikimedia.org/thumb/960px-Comet.jpg');
    expect(d[1]!.link.title).toBe('Comet 67P');
    expect(d[2]!.text).toBe('On this day\n\n2014: Philae landed on a comet.\n1970: A second event.\n\nText: Wikipedia, CC BY-SA 4.0');
  });
  it('leaves the picture out when its licence is not free', () => {
    const d = draftsFromWikipedia(w, { ...feed, image: { ...feed.image, license: { type: 'Fair use', code: 'fair-use' } } }, '2026-11-12');
    expect(d.map((x) => x.key)).toEqual(['tfa:2026-11-12', 'otd:2026-11-12']);
    expect(freeLicence('pd')).toBe(true);
    expect(freeLicence('cc0')).toBe(true);
    expect(freeLicence('cc-by-3.0')).toBe(true);
    expect(freeLicence('cc-by-sa-4.0')).toBe(true);
    expect(freeLicence('cc-by-nc-4.0')).toBe(false);
    expect(freeLicence('cc-by-nd-4.0')).toBe(false);
    expect(freeLicence(undefined)).toBe(false);
  });
  it('survives a feed that is not what we expect', () => {
    expect(draftsFromWikipedia(w, null, '2026-11-12')).toEqual([]);
    expect(draftsFromWikipedia(w, { tfa: 7, image: 'x', onthisday: {} }, '2026-11-12')).toEqual([]);
  });
});

describe('the plan for the day', () => {
  const d = (k: string): Draft => ({ key: k, text: k, link: { url: 'https://e.org' }, at: null });
  it('lets sources take turns and respects per_day and the cap', () => {
    const a = src({ id: 'a', per_day: 2 });
    const b = src({ id: 'b', per_day: 1 });
    const picks = pickForAccount([{ source: a, drafts: [d('a1'), d('a2'), d('a3')] }, { source: b, drafts: [d('b1'), d('b2')] }], 8);
    expect(picks.map((p) => p.draft.key)).toEqual(['a1', 'b1', 'a2']);
    expect(pickForAccount([{ source: a, drafts: [d('a1'), d('a2')] }, { source: b, drafts: [d('b1')] }], 2).map((p) => p.draft.key)).toEqual(['a1', 'b1']);
    expect(pickForAccount([], 8)).toEqual([]);
  });
  it('spreads the posts over the day, the first one now', () => {
    const now = Date.parse('2026-11-12T03:10:00Z');
    const t = spread(4, now, 20);
    expect(t[0]).toBeNull();
    expect(t.slice(1)).toEqual(['2026-11-12T08:10:00.000Z', '2026-11-12T13:10:00.000Z', '2026-11-12T18:10:00.000Z']);
    expect(spread(1, now)).toEqual([null]);
    expect(spread(0, now)).toEqual([]);
  });
});

describe('a post signed by the job', () => {
  it('verifies exactly like a post written in the app', () => {
    const me = generateIdentity();
    const row = {
      id: '11111111-1111-4111-8111-111111111111', author_id: '22222222-2222-4222-8222-222222222222',
      wall_owner_id: '22222222-2222-4222-8222-222222222222', group_id: null, event_id: null, kind: 'link' as const,
      is_public: true, audience_id: null, epoch: null,
    };
    const payload = { text: 'Hello', link: { url: 'https://e.org', title: 'T', site: 'S' } };
    const envelope = sealEnvelope({ header: postHeader(row), payload, signPriv: me.signPriv });
    expect(openEnvelope({ header: postHeader(row), envelope, signPub: me.signPub })).toEqual(payload);
    expect(() => openEnvelope({ header: postHeader(row), envelope: { ...envelope, body: { ...payload, text: 'Changed' } }, signPub: me.signPub })).toThrow();
  });
});

describe('imageInfo', () => {
  const png = (w: number, h: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    (w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
  const jpeg = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc2, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda]);
  it('reads the size from the file itself', () => {
    expect(imageInfo(png(960, 643))).toEqual({ mime: 'image/png', w: 960, h: 643 });
    expect(imageInfo(jpeg(1200, 800))).toEqual({ mime: 'image/jpeg', w: 1200, h: 800 });
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, 0x3f, 0x02, 0, 0xdf, 0x01, 0]);
    expect(imageInfo(webp)).toEqual({ mime: 'image/webp', w: 576, h: 480 });
  });
  it('refuses what is not a picture, or is absurdly large or small', () => {
    expect(imageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
    expect(imageInfo(new TextEncoder().encode(`GIF89a${'x'.repeat(40)}`))).toBeNull();
    expect(imageInfo(png(40000, 100))).toBeNull();
    expect(imageInfo(png(4, 4))).toBeNull();
    expect(imageInfo(new Uint8Array(5))).toBeNull();
  });
});
