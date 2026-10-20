import { describe, expect, it } from 'vitest';
import { applyFormat, excerpt, readingMinutes, safeLink } from './format';

describe('applyFormat', () => {
  it('wraps and unwraps bold/italic', () => {
    const a = applyFormat('hello world', 6, 11, 'bold');
    expect(a).toEqual({ text: 'hello **world**', start: 8, end: 13 });
    expect(applyFormat(a.text, a.start, a.end, 'bold')).toEqual({ text: 'hello world', start: 6, end: 11 });
    expect(applyFormat('x', 1, 1, 'italic', 'text')).toEqual({ text: 'x_text_', start: 2, end: 6 });
    expect(applyFormat('a **b** c', 2, 7, 'bold')).toEqual({ text: 'a b c', start: 2, end: 3 });
  });

  it('toggles line prefixes over the selected lines', () => {
    const t = 'one\ntwo\nthree';
    const l = applyFormat(t, 0, 7, 'list');
    expect(l.text).toBe('- one\n- two\nthree');
    expect(applyFormat(l.text, 0, 11, 'list').text).toBe('one\ntwo\nthree');
    expect(applyFormat(t, 9, 9, 'heading').text).toBe('one\ntwo\n## three');
    expect(applyFormat('## title', 3, 3, 'quote').text).toBe('> title');
    expect(applyFormat('a\nb', 0, 3, 'numbered').text).toBe('1. a\n2. b');
    expect(applyFormat('1. a\n2. b', 0, 9, 'numbered').text).toBe('a\nb');
  });

  it('inserts links with the URL selected', () => {
    const r = applyFormat('see docs', 4, 8, 'link');
    expect(r.text).toBe('see [docs](https://)');
    expect(r.text.slice(r.start, r.end)).toBe('https://');
  });
});

describe('note helpers', () => {
  it('only allows http(s) links', () => {
    expect(safeLink('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('data:text/html,hi')).toBeNull();
    expect(safeLink('/relative')).toBeNull();
    expect(safeLink('https://exa mple.org')).toBeNull();
  });

  it('makes plain excerpts', () => {
    expect(excerpt('## Title\n\n**Bold** and _it_ with [a link](https://x.y).\n- item')).toBe('Title Bold and it with a link. item');
    expect(excerpt('word '.repeat(100), 20).length).toBeLessThanOrEqual(20);
  });

  it('estimates reading time', () => {
    expect(readingMinutes('short')).toBe(1);
    expect(readingMinutes('word '.repeat(1000))).toBe(5);
  });
});
