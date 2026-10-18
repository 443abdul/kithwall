import { describe, expect, it } from 'vitest';
import { embedSrc, needsResolve, parseEmbed, parseTime, validEmbed, EMBED_FRAME_ORIGINS } from './embeds';

const yt = (id: string, extra: object = {}) => ({ provider: 'youtube', id, aspect: '16:9', ...extra });

describe('parseEmbed: YouTube', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', yt('dQw4w9WgXcQ')],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ', yt('dQw4w9WgXcQ')],
    ['http://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share', yt('dQw4w9WgXcQ')],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', yt('dQw4w9WgXcQ')],
    ['https://www.youtube.com/watch?feature=youtu.be&v=dQw4w9WgXcQ', yt('dQw4w9WgXcQ')],
    ['https://youtu.be/dQw4w9WgXcQ', yt('dQw4w9WgXcQ')],
    ['https://youtu.be/dQw4w9WgXcQ?si=abcDEF123', yt('dQw4w9WgXcQ')],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', yt('dQw4w9WgXcQ')],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0', yt('dQw4w9WgXcQ')],
    ['https://www.youtube.com/v/dQw4w9WgXcQ', yt('dQw4w9WgXcQ')],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', yt('dQw4w9WgXcQ')],
    ['https://www.youtube.com/shorts/aqz-KE-bpKQ', { provider: 'youtube', id: 'aqz-KE-bpKQ', aspect: '9:16' }],
    ['https://youtube.com/shorts/aqz-KE-bpKQ?feature=share', { provider: 'youtube', id: 'aqz-KE-bpKQ', aspect: '9:16' }],
    ['https://m.youtube.com/shorts/aqz-KE-bpKQ', { provider: 'youtube', id: 'aqz-KE-bpKQ', aspect: '9:16' }],
  ])('%s', (url, want) => {
    expect(parseEmbed(url)).toEqual(want);
  });

  it('keeps timestamps', () => {
    expect(parseEmbed('https://youtu.be/dQw4w9WgXcQ?t=43')).toEqual(yt('dQw4w9WgXcQ', { start: 43 }));
    expect(parseEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')).toEqual(yt('dQw4w9WgXcQ', { start: 90 }));
    expect(parseEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s')).toEqual(yt('dQw4w9WgXcQ', { start: 90 }));
    expect(parseEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=1h2m3s')).toEqual(yt('dQw4w9WgXcQ', { start: 3723 }));
    expect(parseEmbed('https://www.youtube.com/embed/dQw4w9WgXcQ?start=12')).toEqual(yt('dQw4w9WgXcQ', { start: 12 }));
    expect(parseEmbed('https://youtu.be/dQw4w9WgXcQ?t=0')).toEqual(yt('dQw4w9WgXcQ'));
    expect(parseEmbed('https://youtu.be/dQw4w9WgXcQ?t=junk')).toEqual(yt('dQw4w9WgXcQ'));
  });

  it('plays the video of a playlist link, ignores pure playlists', () => {
    expect(parseEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890abcdef&index=3')).toEqual(yt('dQw4w9WgXcQ'));
    expect(parseEmbed('https://www.youtube.com/playlist?list=PL1234567890abcdef')).toBeNull();
  });

  it('rejects other pages and bad ids', () => {
    expect(parseEmbed('https://www.youtube.com/')).toBeNull();
    expect(parseEmbed('https://www.youtube.com/@SomeChannel')).toBeNull();
    expect(parseEmbed('https://www.youtube.com/channel/UC123')).toBeNull();
    expect(parseEmbed('https://www.youtube.com/results?search_query=cats')).toBeNull();
    expect(parseEmbed('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(parseEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ%22onload')).toBeNull();
    expect(parseEmbed('https://youtu.be/')).toBeNull();
    expect(parseEmbed('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseEmbed('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseEmbed('javascript:alert(1)//youtu.be/dQw4w9WgXcQ')).toBeNull();
    expect(parseEmbed('https://user:pw@youtu.be/dQw4w9WgXcQ')).toBeNull();
    expect(parseEmbed('not a url')).toBeNull();
    expect(parseEmbed('')).toBeNull();
  });
});

describe('parseEmbed: Vimeo', () => {
  it.each([
    ['https://vimeo.com/76979871', { provider: 'vimeo', id: '76979871', aspect: '16:9' }],
    ['https://www.vimeo.com/76979871', { provider: 'vimeo', id: '76979871', aspect: '16:9' }],
    ['https://vimeo.com/channels/staffpicks/76979871', { provider: 'vimeo', id: '76979871', aspect: '16:9' }],
    ['https://vimeo.com/groups/shortfilms/videos/76979871', { provider: 'vimeo', id: '76979871', aspect: '16:9' }],
    ['https://vimeo.com/showcase/123456/video/76979871', { provider: 'vimeo', id: '76979871', aspect: '16:9' }],
    ['https://player.vimeo.com/video/76979871?h=8272103f6e', { provider: 'vimeo', id: '76979871', aspect: '16:9', hash: '8272103f6e' }],
    ['https://vimeo.com/76979871/8272103f6e', { provider: 'vimeo', id: '76979871', aspect: '16:9', hash: '8272103f6e' }],
    ['https://vimeo.com/76979871#t=30s', { provider: 'vimeo', id: '76979871', aspect: '16:9', start: 30 }],
  ])('%s', (url, want) => {
    expect(parseEmbed(url)).toEqual(want);
  });
  it('rejects non-video pages', () => {
    expect(parseEmbed('https://vimeo.com/')).toBeNull();
    expect(parseEmbed('https://vimeo.com/staffpicks')).toBeNull();
    expect(parseEmbed('https://vimeo.com/user12345')).toBeNull();
    expect(parseEmbed('https://vimeo.com/76979871/settings')).toBeNull();
    expect(parseEmbed('https://vimeo.com/blog/post/123')).toBeNull();
  });
});

describe('parseEmbed: Dailymotion', () => {
  const dm = { provider: 'dailymotion', id: 'x8abc12', aspect: '16:9' };
  it.each([
    'https://www.dailymotion.com/video/x8abc12',
    'https://dailymotion.com/video/x8abc12_some-title_news',
    'https://m.dailymotion.com/video/x8abc12',
    'https://www.dailymotion.com/embed/video/x8abc12?autoplay=1',
    'https://geo.dailymotion.com/player.html?video=x8abc12',
    'https://dai.ly/x8abc12',
  ])('%s', (url) => {
    expect(parseEmbed(url)).toEqual(dm);
  });
  it('rejects other pages', () => {
    expect(parseEmbed('https://www.dailymotion.com/')).toBeNull();
    expect(parseEmbed('https://www.dailymotion.com/someuser')).toBeNull();
    expect(parseEmbed('https://dai.ly/')).toBeNull();
  });
});

describe('parseEmbed: Streamable', () => {
  it.each([
    ['https://streamable.com/moo', 'moo'],
    ['https://streamable.com/e/abc123', 'abc123'],
    ['https://www.streamable.com/o/abc123', 'abc123'],
  ])('%s', (url, id) => {
    expect(parseEmbed(url)).toEqual({ provider: 'streamable', id, aspect: '16:9' });
  });
  it('rejects site pages', () => {
    expect(parseEmbed('https://streamable.com/')).toBeNull();
    expect(parseEmbed('https://streamable.com/login')).toBeNull();
    expect(parseEmbed('https://streamable.com/documentation')).toBeNull();
    expect(parseEmbed('https://streamable.com/a/b/c')).toBeNull();
  });
});

describe('parseEmbed: TikTok', () => {
  const tt = { provider: 'tiktok', id: '7231338487075638570', aspect: '9:16' };
  it.each([
    'https://www.tiktok.com/@scout2015/video/7231338487075638570',
    'https://www.tiktok.com/@scout2015/video/7231338487075638570?is_from_webapp=1&sender_device=pc',
    'https://tiktok.com/@some.user_name/video/7231338487075638570',
    'https://m.tiktok.com/v/7231338487075638570.html',
    'https://www.tiktok.com/embed/v2/7231338487075638570',
    'https://www.tiktok.com/player/v1/7231338487075638570?autoplay=1',
  ])('%s', (url) => {
    expect(parseEmbed(url)).toEqual(tt);
  });
  it('needs the redirect for short links; ignores photos and profiles', () => {
    expect(parseEmbed('https://vm.tiktok.com/ZMabcdef/')).toBeNull();
    expect(needsResolve('https://vm.tiktok.com/ZMabcdef/')).toBe(true);
    expect(needsResolve('https://www.tiktok.com/t/ZTabcdef/')).toBe(true);
    expect(needsResolve('https://www.tiktok.com/@scout2015/video/7231338487075638570')).toBe(false);
    expect(parseEmbed('https://www.tiktok.com/@scout2015')).toBeNull();
    expect(parseEmbed('https://www.tiktok.com/@scout2015/photo/7231338487075638570')).toBeNull();
  });
});

describe('parseEmbed: others', () => {
  it('returns null for ordinary sites', () => {
    expect(parseEmbed('https://www.nytimes.com/2024/01/01/world/story.html')).toBeNull();
    expect(parseEmbed('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseEmbed('ftp://youtu.be/dQw4w9WgXcQ')).toBeNull();
  });
});

describe('parseTime', () => {
  it('parses', () => {
    expect(parseTime('75')).toBe(75);
    expect(parseTime('2m')).toBe(120);
    expect(parseTime('1h')).toBe(3600);
    expect(parseTime('1m5s')).toBe(65);
    expect(parseTime('')).toBe(0);
    expect(parseTime('abc')).toBe(0);
    expect(parseTime(null)).toBe(0);
  });
});

describe('validEmbed / embedSrc', () => {
  it('validates untrusted objects', () => {
    expect(validEmbed({ provider: 'youtube', id: 'dQw4w9WgXcQ', aspect: '16:9' })).toEqual(yt('dQw4w9WgXcQ'));
    expect(validEmbed({ provider: 'youtube', id: 'dQw4w9WgXcQ', aspect: 'weird' })).toEqual(yt('dQw4w9WgXcQ'));
    expect(validEmbed({ provider: 'youtube', id: '../../evil?x' })).toBeNull();
    expect(validEmbed({ provider: 'evil', id: 'dQw4w9WgXcQ' })).toBeNull();
    expect(validEmbed({ provider: 'toString', id: 'x' })).toBeNull();
    expect(validEmbed({ provider: 'vimeo', id: '123', hash: '"><script>' })).toEqual({ provider: 'vimeo', id: '123', aspect: '16:9' });
    expect(validEmbed({ provider: 'youtube', id: 'dQw4w9WgXcQ', start: -5 })).toEqual(yt('dQw4w9WgXcQ'));
    expect(validEmbed({ provider: 'youtube', id: 'dQw4w9WgXcQ', start: 1.5 })).toEqual(yt('dQw4w9WgXcQ'));
    expect(validEmbed(null)).toBeNull();
    expect(validEmbed('youtube')).toBeNull();
  });

  it('builds private player URLs on allowed origins', () => {
    const cases: [string, string][] = [
      ['https://youtu.be/dQw4w9WgXcQ?t=10', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1&start=10'],
      ['https://vimeo.com/76979871/8272103f6e', 'https://player.vimeo.com/video/76979871?dnt=1&autoplay=1&h=8272103f6e'],
      ['https://dai.ly/x8abc12', 'https://www.dailymotion.com/embed/video/x8abc12?autoplay=1'],
      ['https://streamable.com/moo', 'https://streamable.com/e/moo?autoplay=1'],
      ['https://www.tiktok.com/@a/video/7231338487075638570', 'https://www.tiktok.com/player/v1/7231338487075638570?autoplay=1'],
    ];
    for (const [url, src] of cases) {
      const s = embedSrc(parseEmbed(url)!);
      expect(s).toBe(src);
      expect(EMBED_FRAME_ORIGINS.some((o) => s!.startsWith(`${o}/`))).toBe(true);
    }
    expect(embedSrc({ provider: 'youtube', id: 'bad', aspect: '16:9' })).toBeNull();
  });
});
