import { describe, expect, it } from 'vitest';
import { CIRCLE_TONES, circleMark, cleanCircleInfo, firstGrapheme, isTone, toneOf } from './look';

describe('circle look', () => {
  it('keeps whole emoji graphemes', () => {
    expect(firstGrapheme('👨‍👩‍👧 family')).toBe('👨‍👩‍👧');
    expect(firstGrapheme('  ✈️trip')).toBe('✈️');
    expect(firstGrapheme('')).toBe('');
  });

  it('picks a stable tone, preferring the stored one', () => {
    expect(toneOf('abc', 'danger')).toBe('danger');
    expect(toneOf('abc', '#3b5998')).toBe(toneOf('abc'));
    expect(CIRCLE_TONES).toContain(toneOf('some-id'));
    expect(isTone('accent2')).toBe(true);
    expect(isTone('pink')).toBe(false);
  });

  it('cleans info before sealing', () => {
    expect(cleanCircleInfo({ name: '  Family   Ahmed ', description: '  ', emoji: '🏡 home', tone: 'success' }))
      .toEqual({ name: 'Family Ahmed', emoji: '🏡', tone: 'success' });
    expect(cleanCircleInfo({ name: 'x'.repeat(200), tone: 'nope' })).toEqual({ name: 'x'.repeat(80) });
  });

  it('falls back to a letter mark', () => {
    expect(circleMark('neighbours')).toBe('N');
    expect(circleMark('')).toBe('•');
  });
});
