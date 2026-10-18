import { describe, expect, it } from 'vitest';
import { cleanText, decodeEntities, decodeHtml, displayHost, firstUrl, parseHtmlMeta, parseOEmbed, sniffCharset, sniffImage } from './linkMeta';

const page = (head: string, body = '<p>hi</p>') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('parseHtmlMeta', () => {
  it('prefers Open Graph', () => {
    const m = parseHtmlMeta(page(`
      <title>Fallback title</title>
      <meta property="og:title" content="OG &amp; title">
      <meta property="og:description" content="OG description">
      <meta name="description" content="plain description">
      <meta property="og:site_name" content="The Site">
      <meta property="og:image" content="/img/a.jpg">
      <meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
      <meta property="og:url" content="https://example.com/a">`));
    expect(m).toMatchObject({
      title: 'OG & title', description: 'OG description', site: 'The Site', image: '/img/a.jpg',
      imageWidth: 1200, imageHeight: 630, canonical: 'https://example.com/a',
    });
  });

  it('falls back to twitter:* and <title>', () => {
    const m = parseHtmlMeta(page(`<title> Just   a
      title </title><meta name="twitter:description" content="tw desc"><meta name="twitter:image:src" content="https://x.test/i.png">`));
    expect(m.title).toBe('Just a title');
    expect(m.description).toBe('tw desc');
    expect(m.image).toBe('https://x.test/i.png');
    const t = parseHtmlMeta(page(`<meta name="twitter:title" content="TW title"><meta name="description" content="d">`));
    expect(t.title).toBe('TW title');
    expect(t.description).toBe('d');
  });

  it('handles attribute order, quotes and case', () => {
    const m = parseHtmlMeta(page(`<META CONTENT='Single quoted' PROPERTY='OG:TITLE'><meta content=Unquoted name=description>`));
    expect(m.title).toBe('Single quoted');
    expect(m.description).toBe('Unquoted');
  });

  it('decodes entities in image URLs and text', () => {
    const m = parseHtmlMeta(page(`<meta property="og:image" content="https://cdn.test/i.jpg?a=1&amp;b=2"><meta property="og:title" content="It&#39;s &quot;quoted&quot; &#x2014; ok &hellip;">`));
    expect(m.image).toBe('https://cdn.test/i.jpg?a=1&b=2');
    expect(m.title).toBe('It\'s "quoted" — ok …');
  });

  it('ignores body, comments and scripts', () => {
    const m = parseHtmlMeta(`<html><head><!-- <meta property="og:title" content="commented"> -->
      <script>var s = '<meta property="og:title" content="in script">';</script>
      <meta property="og:title" content="real"></head>
      <body><meta property="og:description" content="in body"></body></html>`);
    expect(m.title).toBe('real');
    expect(m.description).toBeUndefined();
  });

  it('first value wins; empty values are skipped', () => {
    const m = parseHtmlMeta(page(`<meta property="og:title" content=""><meta property="og:title" content="First"><meta property="og:title" content="Second">`));
    expect(m.title).toBe('First');
  });

  it('strips tags, control and bidi characters and caps length', () => {
    const m = parseHtmlMeta(page(`<meta property="og:title" content="&lt;b&gt;Bold&lt;/b&gt; ‮evil\u0007"><meta name="description" content="${'x'.repeat(1000)}">`));
    expect(m.title).toBe('Bold evil');
    expect(m.description!.length).toBe(400);
    expect(m.description!.endsWith('…')).toBe(true);
  });

  it('finds og:video and rel=canonical', () => {
    const m = parseHtmlMeta(page(`<link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"><meta property="og:video:url" content="https://www.youtube.com/embed/dQw4w9WgXcQ">`));
    expect(m.canonical).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(m.video).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('works without a </head>', () => {
    expect(parseHtmlMeta('<meta property="og:title" content="truncated page"').title).toBeUndefined();
    expect(parseHtmlMeta('<meta property="og:title" content="no head">').title).toBe('no head');
  });

  it('ignores invalid image dimensions', () => {
    const m = parseHtmlMeta(page(`<meta property="og:image:width" content="-5"><meta property="og:image:height" content="abc">`));
    expect(m.imageWidth).toBeUndefined();
    expect(m.imageHeight).toBeUndefined();
  });
});

describe('text helpers', () => {
  it('decodeEntities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65;&#x42; &unknown; &#0;')).toBe('a & b <c> AB &unknown; ');
  });
  it('cleanText', () => {
    expect(cleanText('  a\n\tb  ', 10)).toBe('a b');
    expect(cleanText('', 10)).toBeUndefined();
    expect(cleanText('abcdefghijkl', 5)).toBe('abcd…');
  });
});

describe('charset', () => {
  it('sniffs <meta charset>', () => {
    const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    expect(sniffCharset(enc('<meta charset="ISO-8859-1">'))).toBe('iso-8859-1');
    expect(sniffCharset(enc('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">'))).toBe('windows-1252');
    expect(sniffCharset(enc('<html>'))).toBeUndefined();
    // "é" in Latin-1
    expect(decodeHtml(Uint8Array.from([...enc('<meta charset="iso-8859-1">caf'), 0xe9]))).toContain('café');
    expect(decodeHtml(new TextEncoder().encode('café'), 'bogus-charset')).toBe('café');
  });
});

describe('sniffImage', () => {
  const pad = (b: number[]) => Uint8Array.from([...b, ...new Array(16).fill(0)]);
  it('identifies formats by magic bytes', () => {
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImage(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
    expect(sniffImage(pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
    expect(sniffImage(pad([0x3c, 0x73, 0x76, 0x67]))).toBeNull(); // <svg
    expect(sniffImage(new Uint8Array(3))).toBeNull();
  });
});

describe('parseOEmbed', () => {
  it('reads string fields only', () => {
    expect(parseOEmbed(JSON.stringify({
      title: 'Never Gonna Give You Up', author_name: 'Rick Astley', provider_name: 'YouTube',
      thumbnail_url: 'https://i.ytimg.com/vi/x/hqdefault.jpg', width: 200, height: 113, html: '<iframe src=evil>',
    }))).toEqual({
      title: 'Never Gonna Give You Up', author: 'Rick Astley', site: 'YouTube',
      thumbnail: 'https://i.ytimg.com/vi/x/hqdefault.jpg', width: 200, height: 113,
    });
    expect(parseOEmbed('{"title": 5, "thumbnail_url": {"a":1}, "width": "720", "height": "1280"}'))
      .toEqual({ title: undefined, author: undefined, site: undefined, thumbnail: undefined, width: 720, height: 1280 });
    expect(parseOEmbed('not json')).toBeNull();
    expect(parseOEmbed('[1,2]')).toBeNull();
    expect(parseOEmbed('null')).toBeNull();
  });
});

describe('firstUrl', () => {
  it('finds the first http(s) link', () => {
    expect(firstUrl('look https://example.com/a?b=1 cool')).toEqual({ url: 'https://example.com/a?b=1', complete: true });
    expect(firstUrl('look https://example.com/a')).toEqual({ url: 'https://example.com/a', complete: false });
    expect(firstUrl('one http://a.example.org two https://b.example.org')?.url).toBe('http://a.example.org');
  });
  it('drops trailing punctuation and unbalanced brackets', () => {
    expect(firstUrl('see https://example.com/page.')?.url).toBe('https://example.com/page');
    expect(firstUrl('(see https://example.com/page)')?.url).toBe('https://example.com/page');
    expect(firstUrl('https://en.wikipedia.org/wiki/Foo_(bar) ok')?.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(firstUrl('"https://example.com/q"')?.url).toBe('https://example.com/q');
    expect(firstUrl('wow https://example.com!!! ')?.url).toBe('https://example.com');
  });
  it('ignores incomplete or non-http text', () => {
    expect(firstUrl('https://exa')).toBeNull();
    expect(firstUrl('https://')).toBeNull();
    expect(firstUrl('ftp://example.com')).toBeNull();
    expect(firstUrl('example.com')).toBeNull();
    expect(firstUrl('no links here')).toBeNull();
  });
  it('displayHost', () => {
    expect(displayHost('https://www.nytimes.com/x')).toBe('nytimes.com');
    expect(displayHost('https://m.youtube.com/x')).toBe('youtube.com');
    expect(displayHost('bad')).toBe('');
  });
});
