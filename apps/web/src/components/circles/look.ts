// Circle look (emoji + colour tone) helpers. Pure: no React, no network (unit-tested in look.test.ts).
// Tones map to semantic design tokens (styles/v2/circles.css), so every style × mode keeps contrast.

export const CIRCLE_TONES = ['accent', 'accent2', 'success', 'warning', 'danger', 'neutral'] as const;
export type CircleTone = (typeof CIRCLE_TONES)[number];

export const CIRCLE_EMOJI = ['👪', '🏡', '🎓', '⚽', '🎵', '📚', '🍲', '🌱', '✈️', '💼', '🎮', '❤️', '🌍', '🐾', '⛪', '🎨'];

export function isTone(x: unknown): x is CircleTone {
  return typeof x === 'string' && (CIRCLE_TONES as readonly string[]).includes(x);
}

/** A tone for a circle: the stored one, else a stable pick from its id (v1 groups had hex colours). */
export function toneOf(id: string, stored?: unknown): CircleTone {
  if (isTone(stored)) return stored;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CIRCLE_TONES[h % CIRCLE_TONES.length]!;
}

/** The first user-perceived character (grapheme) of `s`, or '' — so "👨‍👩‍👧 family" keeps the whole emoji. */
export function firstGrapheme(s: string): string {
  const t = s.trim();
  if (!t) return '';
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of seg.segment(t)) return segment;
  }
  return Array.from(t)[0] ?? '';
}

/** Clean user input for a circle's info before sealing it. */
export function cleanCircleInfo(input: { name: string; description?: string; emoji?: string; tone?: string }): {
  name: string; description?: string; emoji?: string; tone?: CircleTone;
} {
  const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 80);
  const description = (input.description ?? '').trim().slice(0, 1000);
  const emoji = firstGrapheme(input.emoji ?? '');
  return {
    name,
    ...(description ? { description } : {}),
    ...(emoji ? { emoji } : {}),
    ...(isTone(input.tone) ? { tone: input.tone } : {}),
  };
}

/** Initials-style fallback mark for a circle with no emoji. */
export function circleMark(name: string): string {
  return firstGrapheme(name).toUpperCase() || '•';
}
