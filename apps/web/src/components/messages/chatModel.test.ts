import { describe, expect, it } from 'vitest';
import { buildThread, dayBucket, firstUrl, fold, isEmojiOnly, linkify, matches, orderConversations, previewOffer, safeHref, snippet, tallyReactions } from './chatModel';

const at = (h: number, m = 0, d = 20) => new Date(2026, 9, d, h, m).toISOString();

describe('buildThread', () => {
  it('adds day separators and groups runs by sender within 5 minutes', () => {
    const items = buildThread([
      { id: '1', sender: 'a', at: at(9, 0, 19) },
      { id: '2', sender: 'a', at: at(9, 0) },
      { id: '3', sender: 'a', at: at(9, 3) },
      { id: '4', sender: 'b', at: at(9, 4) },
      { id: '5', sender: 'b', at: at(9, 20) },
      { id: '6', sender: 'b', at: at(9, 21), event: true },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['day', 'msg', 'day', 'msg', 'msg', 'msg', 'msg', 'event']);
    const msgs = items.filter((i) => i.kind === 'msg') as Extract<(typeof items)[number], { kind: 'msg' }>[];
    expect(msgs.map((m) => [m.line.id, m.first, m.last])).toEqual([
      ['1', true, true], ['2', true, false], ['3', false, true], ['4', true, true], ['5', true, true],
    ]);
  });
});

describe('dayBucket', () => {
  const now = new Date(2026, 9, 20, 12);
  it('buckets relative days', () => {
    expect(dayBucket(at(1), now)).toBe('today');
    expect(dayBucket(at(23, 0, 19), now)).toBe('yesterday');
    expect(dayBucket(at(10, 0, 15), now)).toBe('week');
    expect(dayBucket(at(10, 0, 1), now)).toBe('older');
  });
});

describe('links', () => {
  it('only links http(s) and trims punctuation', () => {
    expect(linkify('see https://example.com/a. ok')).toEqual([{ text: 'see ' }, { text: 'https://example.com/a', href: 'https://example.com/a' }, { text: '. ok' }]);
    expect(linkify('javascript:alert(1)')).toEqual([{ text: 'javascript:alert(1)' }]);
    expect(safeHref('https://user:pw@example.com')).toBeNull();
    expect(firstUrl('go to www.example.org now')).toBe('https://www.example.org/');
    expect(linkify('(https://en.wikipedia.org/wiki/Foo_(bar))')[1]).toEqual({ text: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' });
  });
});

describe('search and order', () => {
  it('matches case- and accent-insensitively', () => {
    expect(fold('Zoë ÁVILA')).toBe('zoe avila');
    expect(matches('zoe', 'Zoë')).toBe(true);
    expect(matches('', 'x')).toBe(true);
    expect(matches('dan', null, 'Sara')).toBe(false);
  });
  it('puts pinned first, then newest', () => {
    const out = orderConversations([
      { id: 'a', lastAt: '2026-10-20T10:00:00Z' },
      { id: 'b', lastAt: '2026-10-20T12:00:00Z' },
      { id: 'c', lastAt: '2026-10-01T10:00:00Z', pinnedAt: '2026-10-02T00:00:00Z' },
      { id: 'd', lastAt: '2026-10-01T10:00:00Z', pinnedAt: '2026-10-05T00:00:00Z' },
    ]);
    expect(out.map((x) => x.id)).toEqual(['d', 'c', 'b', 'a']);
  });
});

describe('misc', () => {
  it('detects emoji-only messages', () => {
    expect(isEmojiOnly('❤️')).toBe(true);
    expect(isEmojiOnly('👍👍')).toBe(true);
    expect(isEmojiOnly('ok 👍')).toBe(false);
    expect(isEmojiOnly('1')).toBe(false);
  });
  it('clips snippets', () => {
    expect(snippet('a   b\nc')).toBe('a b c');
    expect(snippet('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
  it('tallies reactions by count then picker order', () => {
    expect(tallyReactions([{ userId: 'a', emoji: '👍' }, { userId: 'b', emoji: '❤️' }, { userId: 'c', emoji: '👍' }, { userId: 'c', emoji: '👍' }], ['❤️', '👍']))
      .toEqual([{ emoji: '👍', users: ['a', 'c'] }, { emoji: '❤️', users: ['b'] }]);
  });
});

describe('previewOffer (security review C2: previews only on request)', () => {
  it('offers the first link, but only as an offer', () => {
    expect(previewOffer('see https://example.org/a and https://b.example', { hasFiles: false, enabled: true })).toBe('https://example.org/a');
  });
  it('offers nothing with attachments, with the setting off, or once dismissed', () => {
    const text = 'https://example.org/a';
    expect(previewOffer(text, { hasFiles: true, enabled: true })).toBeNull();
    expect(previewOffer(text, { hasFiles: false, enabled: false })).toBeNull();
    expect(previewOffer(text, { hasFiles: false, enabled: true, dismissed: 'https://example.org/a' })).toBeNull();
    expect(previewOffer('no links here', { hasFiles: false, enabled: true })).toBeNull();
  });
});