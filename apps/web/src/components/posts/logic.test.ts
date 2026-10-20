// Run: npx vitest run src/components/posts
import { describe, expect, it } from 'vitest';
import { dedupeById, gridLayout, linkLabel, nextCursor, safeHref, segmentText, stepIndex, threadComments, whenParts } from './logic';

describe('segmentText', () => {
  it('keeps plain text as one segment', () => {
    expect(segmentText('hello world')).toEqual([{ kind: 'text', text: 'hello world' }]);
  });
  it('links http(s) URLs and leaves trailing punctuation outside', () => {
    expect(segmentText('see https://example.com/a?b=1, ok.')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { kind: 'text', text: ', ok.' },
    ]);
  });
  it('links bare www. hosts with https', () => {
    const s = segmentText('go to www.kithwall.com!');
    expect(s[1]).toEqual({ kind: 'link', text: 'www.kithwall.com', href: 'https://www.kithwall.com/' });
    expect(s[2]).toEqual({ kind: 'text', text: '!' });
  });
  it('keeps balanced closing brackets inside the URL', () => {
    const s = segmentText('(https://en.wikipedia.org/wiki/Foo_(bar))');
    expect(s[1]).toMatchObject({ kind: 'link', text: 'https://en.wikipedia.org/wiki/Foo_(bar)' });
    expect(s[2]).toEqual({ kind: 'text', text: ')' });
  });
  it('never links javascript:, data: or credentials', () => {
    expect(segmentText('javascript:alert(1)').every((x) => x.kind === 'text')).toBe(true);
    expect(segmentText('data:text/html,<b>x</b>').every((x) => x.kind === 'text')).toBe(true);
    expect(segmentText('https://user:pw@evil.example/').every((x) => x.kind === 'text')).toBe(true);
    expect(safeHref('https://intranet/')).toBeNull();
  });
  it('handles several links and newlines', () => {
    const s = segmentText('a https://a.example\nb http://b.example');
    expect(s.filter((x) => x.kind === 'link').map((x) => (x as { href: string }).href)).toEqual(['https://a.example/', 'http://b.example/']);
    expect(s.map((x) => x.text).join('')).toBe('a https://a.example\nb http://b.example');
  });
  it('labels links compactly', () => {
    expect(linkLabel('https://www.example.com/')).toBe('example.com');
    expect(linkLabel(`https://example.com/${'x'.repeat(80)}`, 20)).toHaveLength(20);
  });
});

describe('whenParts', () => {
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  it('buckets times', () => {
    expect(whenParts(now - 10_000, now)).toEqual({ kind: 'now' });
    expect(whenParts(now - 5 * 60_000, now)).toEqual({ kind: 'relative', value: -5, unit: 'minute' });
    expect(whenParts(now - 3 * 3_600_000, now)).toEqual({ kind: 'relative', value: -3, unit: 'hour' });
    expect(whenParts(now - 2 * 86_400_000, now)).toEqual({ kind: 'relative', value: -2, unit: 'day' });
    expect(whenParts(now - 30 * 86_400_000, now)).toEqual({ kind: 'date', sameYear: true });
    expect(whenParts(now - 400 * 86_400_000, now)).toEqual({ kind: 'date', sameYear: false });
  });
  it('treats clock skew (future times) as now', () => {
    expect(whenParts(now + 60_000, now)).toEqual({ kind: 'now' });
  });
});

describe('threadComments', () => {
  const c = (id: string, t: number, replyTo?: string) => ({ id, created_at: new Date(t * 1000).toISOString(), replyTo });
  it('nests replies one level, in time order', () => {
    const th = threadComments([c('b', 3, 'a'), c('a', 1), c('d', 2), c('e', 4, 'b'), c('f', 5, 'missing')]);
    expect(th.map((x) => x.root.id)).toEqual(['a', 'd', 'f']);
    expect(th[0]!.replies.map((x) => x.id)).toEqual(['b', 'e']);
    expect(th[1]!.replies).toEqual([]);
  });
  it('survives reply cycles', () => {
    const th = threadComments([c('x', 1, 'y'), c('y', 2, 'x')]);
    expect(th.length).toBeGreaterThan(0);
  });
});

describe('paging and layout', () => {
  it('computes the next cursor only for full pages', () => {
    const rows = [{ created_at: '3' }, { created_at: '2' }];
    expect(nextCursor(rows, 2)).toBe('2');
    expect(nextCursor(rows, 3)).toBeUndefined();
  });
  it('dedupes rows by id keeping the first', () => {
    expect(dedupeById([{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'a', n: 3 }])).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
  });
  it('lays out photo grids', () => {
    expect(gridLayout(1)).toEqual({ shown: 1, more: 0, layout: 'one' });
    expect(gridLayout(3)).toEqual({ shown: 3, more: 0, layout: 'three' });
    expect(gridLayout(9)).toEqual({ shown: 4, more: 5, layout: 'four' });
  });
  it('steps the lightbox without wrapping', () => {
    expect(stepIndex(0, -1, 3)).toBe(0);
    expect(stepIndex(2, 1, 3)).toBe(2);
    expect(stepIndex(1, 1, 3)).toBe(2);
  });
});
