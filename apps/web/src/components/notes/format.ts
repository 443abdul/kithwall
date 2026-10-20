// Note editor formatting (pure; unit-tested in format.test.ts). Notes are stored as a small Markdown
// subset (headings, bold, italic, lists, quotes, links) inside the encrypted post payload and rendered
// with components/auth/Markdown.tsx, which builds React elements only (no HTML injection).

export type FormatKind = 'bold' | 'italic' | 'heading' | 'list' | 'numbered' | 'quote' | 'link';

export interface Edit { text: string; start: number; end: number }

const WRAP: Partial<Record<FormatKind, string>> = { bold: '**', italic: '_' };
const PREFIX: Partial<Record<FormatKind, string>> = { heading: '## ', list: '- ', quote: '> ' };

/** Apply (or toggle off) a format to the selection [start, end) of `text`. */
export function applyFormat(text: string, start: number, end: number, kind: FormatKind, placeholder = ''): Edit {
  const sel = text.slice(start, end);
  const wrap = WRAP[kind];
  if (wrap) {
    const n = wrap.length;
    // Toggle off when the selection is already wrapped (inside or including the markers).
    if (text.slice(start - n, start) === wrap && text.slice(end, end + n) === wrap) {
      return { text: text.slice(0, start - n) + sel + text.slice(end + n), start: start - n, end: end - n };
    }
    if (sel.length >= 2 * n && sel.startsWith(wrap) && sel.endsWith(wrap)) {
      const inner = sel.slice(n, sel.length - n);
      return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
    }
    const body = sel || placeholder;
    return { text: text.slice(0, start) + wrap + body + wrap + text.slice(end), start: start + n, end: start + n + body.length };
  }
  if (kind === 'link') {
    const label = sel || placeholder;
    const url = 'https://';
    const out = `[${label}](${url})`;
    const urlStart = start + label.length + 3;
    return { text: text.slice(0, start) + out + text.slice(end), start: urlStart, end: urlStart + url.length };
  }
  // Line formats: apply to every line touched by the selection.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end > start && text[end - 1] === '\n' ? end - 1 : end);
  if (lineEnd < 0) lineEnd = text.length;
  const lines = text.slice(lineStart, lineEnd).split('\n');
  const prefixFor = (i: number) => (kind === 'numbered' ? `${i + 1}. ` : PREFIX[kind]!);
  const has = (l: string, i: number) => (kind === 'numbered' ? /^\d+[.)]\s/.test(l) : l.startsWith(prefixFor(i)));
  const allHave = lines.every((l, i) => has(l, i) || !l.trim());
  const strip = (l: string) => l.replace(kind === 'numbered' ? /^\d+[.)]\s/ : /^(#{1,6} |- |> )/, '');
  const next = lines.map((l, i) => {
    if (allHave) return has(l, i) ? (kind === 'numbered' ? l.replace(/^\d+[.)]\s/, '') : l.slice(prefixFor(i).length)) : l;
    if (!l.trim() && lines.length > 1) return l;
    return prefixFor(i) + strip(l);
  }).join('\n');
  const out = text.slice(0, lineStart) + next + text.slice(lineEnd);
  return { text: out, start: lineStart, end: lineStart + next.length };
}

/** Links in notes: only http(s) URLs; anything else renders as plain text. */
export function safeLink(href: string): string | null {
  const h = href.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(h)) return null;
  try {
    const u = new URL(h);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

/** Plain-text preview of a Markdown note. */
export function excerpt(md: string, max = 180): string {
  const plain = md
    .replace(/\r\n?/g, '\n')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** Minutes to read (≥ 1), at ~200 words per minute (counts CJK characters as words). */
export function readingMinutes(md: string): number {
  const words = (md.match(/[\p{L}\p{N}]+/gu) ?? []).length + (md.match(/[㐀-鿿]/g) ?? []).length;
  return Math.max(1, Math.round(words / 200));
}
