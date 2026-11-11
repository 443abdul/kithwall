// Search on your phone: how text is compared (docs/v2/03-safety.md §14). Pure; unit-tested in text.test.ts.
//
// Kithwall is used in languages with very different writing (English, Urdu, Arabic, Persian, Hindi,
// Bengali, Chinese, Russian, Spanish, French, Portuguese, Turkish), so text is FOLDED before it is compared:
//   - case: "Karachi" = "karachi"; Turkish dotless ı = i; ß = ss;
//   - accents and vowel marks that people leave out when typing: é = e, ё = е, Arabic harakat (كَتَبَ = كتب),
//     the tatweel, Hebrew points; Hindi and Bengali vowel signs are KEPT (they are letters there), only the
//     nukta goes (क़ = क) and chandrabindu = anusvara;
//   - letters that keyboards write differently: Arabic ي ى and Persian/Urdu ی; ك and ک; ه ہ ھ ة ۃ; the alef
//     forms أ إ آ ٱ ا; ؤ = و; ئ = ی;
//   - digits: ١٢٣, ۱۲۳, १२३, ১২৩ and full-width １２３ = 123;
//   - invisible characters (zero-width joiners, direction marks, soft hyphens) are dropped.
// Everything that is not a letter, a mark that was kept, or a digit separates words.
//
// Matching ("prefix tokeniser", chosen over n-grams because the index lives decrypted in memory only while
// the app is unlocked, so a scan is fast and needs no second structure to keep in step):
//   - every word of the query must be found (in any order);
//   - a query word matches a word of the text that STARTS with it ("kar" finds "Karachi");
//   - in scripts written without spaces (Chinese, Japanese, Thai, Lao, Khmer, Burmese) and in Arabic script,
//     where articles and prepositions are attached to the word (الكتاب, بالكتاب), a query word of two (CJK) or
//     three (Arabic script) characters or more is found anywhere inside the text.

const DROP = /[­ـ​-‏‪-‮⁠-⁤﻿]/;
/** Marks left out when typing: Latin/Greek/Cyrillic diacritics, Hebrew points, Arabic harakat, Indic nuktas. */
const SKIP_MARK = /[̀-ͯ҃-҉֑-ׇؐ-ًؚ-ٰٟۖ-़়਼઼଼ۭ᪰-᫿᷀-᷿⃐-⃿︠-︯]/;
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
/** Scripts where a query is looked for anywhere in the text, not only at the start of a word. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const ARABIC = /\p{Script=Arabic}/u;

const MAP: Record<string, string> = {
  'ı': 'i', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'đ': 'd', 'ł': 'l',
  // Arabic script: one spelling for the letters keyboards and languages write differently.
  'ي': 'ی', 'ى': 'ی', 'ك': 'ک',
  'ہ': 'ه', 'ھ': 'ه', 'ة': 'ه', 'ۃ': 'ه', 'ۀ': 'ه', 'ە': 'ه',
  'ٱ': 'ا',
  // Devanagari / Bengali chandrabindu = anusvara.
  'ँ': 'ं', 'ঁ': 'ং',
};

function digit(cp: number): string | null {
  for (const zero of [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6]) if (cp >= zero && cp <= zero + 9) return String(cp - zero);
  return null;
}

/** One character of the original text, folded: zero or more characters; ' ' for a separator. */
function foldChar(ch: string): string {
  let out = '';
  for (const part of ch.normalize('NFKD').toLowerCase()) {
    if (DROP.test(part) || SKIP_MARK.test(part)) continue;
    const d = digit(part.codePointAt(0)!);
    const mapped = d ?? MAP[part] ?? part;
    out += [...mapped].every((c) => WORD_CHAR.test(c)) ? mapped : ' ';
  }
  return out;
}

export interface Folded {
  /** Folded text, one separator per separating character (not collapsed), so positions map back. */
  text: string;
  /** For each character of `text`: where the original character that produced it starts and ends. */
  start: number[];
  end: number[];
}

/** Fold a text keeping the way back to the original (for highlighting). */
export function foldWithMap(original: string): Folded {
  let text = '';
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;
  for (const ch of original) {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) { start.push(i); end.push(i + ch.length); }
    // A mark that folds to nothing (a vowel sign, an accent typed separately) belongs to the letter before it.
    if (!f && end.length) end[end.length - 1] = i + ch.length;
    text += f;
    i += ch.length;
  }
  return { text, start, end };
}

/** The folded words of a text, separated by single spaces, with a space at both ends: what the index compares against. */
export function prepare(original: string): string {
  let out = ' ';
  for (const ch of original) {
    const f = foldChar(ch);
    for (const c of f) { if (c !== ' ' || !out.endsWith(' ')) out += c; }
  }
  return out.endsWith(' ') ? out : `${out} `;
}

export interface QueryWord { text: string; anywhere: boolean }

/** The words of a query, folded (at most 8; longer queries add nothing a person would notice). */
export function queryWords(query: string): QueryWord[] {
  const seen = new Set<string>();
  const out: QueryWord[] = [];
  for (const w of prepare(query.slice(0, 200)).trim().split(' ')) {
    if (!w || seen.has(w)) continue;
    seen.add(w);
    const n = [...w].length;
    out.push({ text: w, anywhere: (UNSPACED.test(w) && n >= 2) || (ARABIC.test(w) && n >= 3) });
    if (out.length === 8) break;
  }
  return out;
}

/** Does a prepared text contain every query word? */
export function matches(prepared: string, words: readonly QueryWord[]): boolean {
  if (!words.length) return false;
  for (const w of words) if (!prepared.includes(w.anywhere ? w.text : ` ${w.text}`)) return false;
  return true;
}

export interface Range { start: number; end: number }

/** Where the query words are in the ORIGINAL text (merged, in order), for highlighting. */
export function findRanges(original: string, words: readonly QueryWord[]): Range[] {
  const f = foldWithMap(original);
  const raw: Range[] = [];
  for (const w of words) {
    for (let at = f.text.indexOf(w.text); at !== -1; at = f.text.indexOf(w.text, at + 1)) {
      if (!w.anywhere && at > 0 && f.text[at - 1] !== ' ') continue;
      raw.push({ start: f.start[at]!, end: f.end[at + w.text.length - 1]! });
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

export interface Piece { text: string; hit: boolean }

/**
 * A short excerpt around the first match, cut into highlighted and plain pieces. Line breaks become spaces;
 * an ellipsis marks where text was left out.
 */
export function excerpt(original: string, words: readonly QueryWord[], max = 140): Piece[] {
  const ranges = findRanges(original, words);
  const first = ranges[0];
  let from = 0;
  if (first && first.start > max * 0.4) {
    from = first.start - Math.floor(max * 0.3);
    // Start at a word, not in the middle of one (or of a surrogate pair / mark sequence).
    const space = original.lastIndexOf(' ', from);
    from = space !== -1 && from - space < 24 ? space + 1 : from;
    while (from > 0 && from < original.length && /[\udc00-\udfff\p{M}]/u.test(original[from]!)) from++;
  }
  let to = Math.min(original.length, from + max);
  if (to < original.length) {
    const space = original.lastIndexOf(' ', to);
    if (space > from + max * 0.6) to = space;
    while (to < original.length && /[\udc00-\udfff\p{M}]/u.test(original[to]!)) to++;
  }
  const pieces: Piece[] = [];
  const push = (text: string, hit: boolean) => { const t = text.replace(/\s+/g, ' '); if (t) pieces.push({ text: t, hit }); };
  let at = from;
  if (from > 0) pieces.push({ text: '…', hit: false });
  for (const r of ranges) {
    if (r.end <= from || r.start >= to) continue;
    const s = Math.max(r.start, from);
    const e = Math.min(r.end, to);
    push(original.slice(at, s), false);
    push(original.slice(s, e), true);
    at = e;
  }
  push(original.slice(at, to), false);
  if (to < original.length) pieces.push({ text: '…', hit: false });
  return pieces;
}
