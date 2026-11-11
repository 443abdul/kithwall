// Run: npx vitest run src/lib/social
import { describe, expect, it } from 'vitest';
import { cleanHiddenWords, matchesHidden, MAX_HIDDEN_WORDS, parseHiddenInput } from './hiddenWords';

describe('hidden words', () => {
  it('matches whole words and phrases, ignoring case', () => {
    expect(matchesHidden('Win a FREE phone today', ['free phone'])).toBe(true);
    expect(matchesHidden('What a spoiler!', ['spoiler'])).toBe(true);
    expect(matchesHidden('Nothing to see', ['spoiler'])).toBe(false);
  });

  it('does not match inside longer words', () => {
    expect(matchesHidden('A first-class seat', ['ass'])).toBe(false);
    expect(matchesHidden('What an ass.', ['ass'])).toBe(true);
    expect(matchesHidden('classic', ['class'])).toBe(false);
  });

  it('handles punctuation, hashtags and letter width', () => {
    expect(matchesHidden('so much #crypto here', ['#crypto'])).toBe(true);
    expect(matchesHidden('ＦＲＥＥ money', ['free'])).toBe(true);
    expect(matchesHidden('Über cool', ['über'])).toBe(true);
    expect(matchesHidden('visit example.com/now', ['example.com'])).toBe(true);
  });

  it('matches anywhere for scripts written without spaces, and whole words in Arabic script', () => {
    expect(matchesHidden('今日は天気がいい', ['天気'])).toBe(true);
    expect(matchesHidden('یہ ایک اشتہار ہے', ['اشتہار'])).toBe(true);
    expect(matchesHidden('یہ اشتہارات ہیں', ['اشتہار'])).toBe(false);
  });

  it('is off without words or text', () => {
    expect(matchesHidden('', ['x'])).toBe(false);
    expect(matchesHidden(null, ['x'])).toBe(false);
    expect(matchesHidden('anything', [])).toBe(false);
  });

  it('cleans what was typed or stored', () => {
    expect(parseHiddenInput(' Spoiler ,  free   PHONE\nspoiler,,')).toEqual(['spoiler', 'free phone']);
    expect(cleanHiddenWords('nope')).toEqual([]);
    expect(cleanHiddenWords([1, null, 'ok', 'x'.repeat(100)])).toEqual(['ok', 'x'.repeat(60)]);
    expect(cleanHiddenWords(Array.from({ length: 500 }, (_, i) => `w${i}`))).toHaveLength(MAX_HIDDEN_WORDS);
  });
});
