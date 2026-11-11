// Hidden words (docs/v2/10-follow-public.md §6): a personal list of words and phrases. Posts and comments
// that contain one are folded away for me only, on this device. The matching is pure (tested in
// hiddenWords.test.ts); the list itself lives in my encrypted vault (./hiddenStore.ts), so the server never
// learns which words I hide, and nobody else's view changes.

export const MAX_HIDDEN_WORDS = 200;
export const MAX_HIDDEN_LENGTH = 60;

/** Lower-cased, width- and compatibility-normalised, spaces collapsed. */
export function normalizeHidden(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A clean list from whatever was typed or stored: normalised, no duplicates, bounded. */
export function cleanHiddenWords(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const w = normalizeHidden(raw).slice(0, MAX_HIDDEN_LENGTH).trim();
    if (w && !out.includes(w)) out.push(w);
    if (out.length >= MAX_HIDDEN_WORDS) break;
  }
  return out;
}

/** Words typed into one box: separated by commas or new lines. */
export function parseHiddenInput(text: string): string[] {
  return cleanHiddenWords(text.split(/[,\n]/));
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
// Scripts written without spaces between words: a phrase can sit anywhere in the text.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * Does the text contain one of the hidden words? Whole words and phrases only ("ass" does not hide
 * "class"), ignoring case and letter width; for scripts written without spaces, anywhere in the text.
 */
export function matchesHidden(text: string | null | undefined, words: readonly string[]): boolean {
  if (!text || !words.length) return false;
  const hay = normalizeHidden(text);
  for (const w of words) {
    if (!w) continue;
    const free = UNSPACED.test(w);
    for (let at = hay.indexOf(w); at !== -1; at = hay.indexOf(w, at + 1)) {
      if (free) return true;
      const before = at > 0 ? hay[at - 1]! : '';
      const after = hay[at + w.length] ?? '';
      // A boundary is only needed on a side where the hidden word itself ends in a letter or digit.
      const openStart = !WORD_CHAR.test(w[0]!) || !before || !WORD_CHAR.test(before);
      const openEnd = !WORD_CHAR.test(w[w.length - 1]!) || !after || !WORD_CHAR.test(after);
      if (openStart && openEnd) return true;
    }
  }
  return false;
}
