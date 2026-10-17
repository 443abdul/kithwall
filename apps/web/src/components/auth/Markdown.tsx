// Tiny, safe Markdown → React renderer for our own legal/help documents. It produces React
// elements only (no innerHTML), so the strict CSP / Trusted Types stay intact.
// Supports: # headings, paragraphs, > blockquotes, - / 1. lists (nested by indent), | tables |,
// --- rules, **bold**, *italic* / _italic_, `code`, [links](url).
import type { ReactNode } from 'react';

export type LinkMapper = (href: string) => string | null;

const defaultMapper: LinkMapper = (href) => (/^https?:\/\//i.test(href) || href.startsWith('/') || href.startsWith('#') || href.startsWith('mailto:') ? href : null);

// ---------------------------------------------------------------------------------------
// Inline
function inline(text: string, map: LinkMapper, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let k = 0;
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  const key = () => `${keyPrefix}-${k++}`;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < text.length && /[\\`*_[\]()#|>-]/.test(text[i + 1]!)) { buf += text[i + 1]; i += 2; continue; }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) { flush(); out.push(<code key={key()}>{text.slice(i + 1, end)}</code>); i = end + 1; continue; }
    }
    if (c === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) { flush(); out.push(<strong key={key()}>{inline(text.slice(i + 2, end), map, key())}</strong>); i = end + 2; continue; }
    }
    if ((c === '*' || c === '_') && text[i + 1] !== c && text[i + 1] !== ' ' && (c === '*' || i === 0 || /[\s(]/.test(text[i - 1]!))) {
      const end = text.indexOf(c, i + 1);
      if (end > i + 1 && text[end - 1] !== ' ' && (c === '*' || end + 1 >= text.length || /[\s).,;:!?]/.test(text[end + 1]!))) {
        flush(); out.push(<em key={key()}>{inline(text.slice(i + 1, end), map, key())}</em>); i = end + 1; continue;
      }
    }
    if (c === '[') {
      const close = findClose(text, i);
      if (close > 0 && text[close + 1] === '(') {
        const pend = text.indexOf(')', close + 2);
        if (pend > close) {
          const label = text.slice(i + 1, close);
          const href = text.slice(close + 2, pend).trim();
          const target = map(href);
          flush();
          if (target === null) out.push(...inline(label, map, key()));
          else if (/^https?:\/\//i.test(target)) out.push(<a key={key()} href={target} target="_blank" rel="noopener noreferrer nofollow">{inline(label, map, key())}</a>);
          else out.push(<a key={key()} href={target}>{inline(label, map, key())}</a>);
          i = pend + 1;
          continue;
        }
      }
    }
    buf += c; i++;
  }
  flush();
  return out;
}

function findClose(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === '[') depth++;
    else if (text[j] === ']') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

// ---------------------------------------------------------------------------------------
// Blocks
interface ListItem { text: string; children: ListBlock | null }
interface ListBlock { ordered: boolean; start: number; items: ListItem[] }

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const indentOf = (s: string) => s.replace(/\t/g, '    ').length;

function parseList(lines: string[], start: number): { block: ListBlock; next: number } {
  const first = LIST_RE.exec(lines[start]!)!;
  const baseIndent = indentOf(first[1]!);
  const ordered = /\d/.test(first[2]!);
  const block: ListBlock = { ordered, start: ordered ? parseInt(first[2]!, 10) : 1, items: [] };
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const nxt = lines[i + 1];
      if (nxt && LIST_RE.test(nxt) && indentOf(LIST_RE.exec(nxt)![1]!) >= baseIndent) { i++; continue; }
      break;
    }
    const m = LIST_RE.exec(line);
    if (m) {
      const ind = indentOf(m[1]!);
      if (ind < baseIndent) break;
      if (ind > baseIndent) {
        const last = block.items[block.items.length - 1];
        const sub = parseList(lines, i);
        if (last) last.children = sub.block; else block.items.push({ text: '', children: sub.block });
        i = sub.next;
        continue;
      }
      block.items.push({ text: m[3]!, children: null });
      i++;
      continue;
    }
    // Continuation line of the previous item (indented text).
    if (/^\s+\S/.test(line) && block.items.length) { block.items[block.items.length - 1]!.text += ` ${line.trim()}`; i++; continue; }
    break;
  }
  return { block, next: i };
}

function renderList(b: ListBlock, map: LinkMapper, key: string): ReactNode {
  const items = b.items.map((it, j) => {
    const t = it.text.replace(/^\[( |x|X)\]\s+/, (_, x: string) => (x.trim() ? '☑ ' : '☐ '));
    return <li key={j}>{inline(t, map, `${key}-${j}`)}{it.children ? renderList(it.children, map, `${key}-${j}-c`) : null}</li>;
  });
  return b.ordered ? <ol key={key} start={b.start}>{items}</ol> : <ul key={key}>{items}</ul>;
}

const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

export function renderMarkdown(src: string, map: LinkMapper = defaultMapper): ReactNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `b${n++}`;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!;
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      const k = key();
      const kids = inline(text, map, k);
      out.push(level === 1 ? <h1 key={k} id={id}>{kids}</h1> : level === 2 ? <h2 key={k} id={id}>{kids}</h2> : level === 3 ? <h3 key={k} id={id}>{kids}</h3> : <h4 key={k} id={id}>{kids}</h4>);
      i++; continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push(<hr key={key()} />); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) { quote.push(lines[i]!.replace(/^\s*>\s?/, '')); i++; }
      out.push(<blockquote key={key()}>{renderMarkdown(quote.join('\n'), map)}</blockquote>);
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const head = splitRow(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) { body.push(splitRow(lines[i]!)); i++; }
      const k = key();
      out.push(
        <div className="tw" key={k}><table><thead><tr>{head.map((c, j) => <th key={j}>{inline(c, map, `${k}-h${j}`)}</th>)}</tr></thead>
          <tbody>{body.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? '', map, `${k}-${ri}-${j}`)}</td>)}</tr>)}</tbody></table></div>,
      );
      continue;
    }
    if (LIST_RE.test(line)) {
      const { block, next } = parseList(lines, i);
      out.push(renderList(block, map, key()));
      i = next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6})\s/.test(lines[i]!) && !/^\s*>/.test(lines[i]!) && !LIST_RE.test(lines[i]!)
      && !/^\s*\|/.test(lines[i]!) && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]!)) {
      para.push(lines[i]!.trim());
      i++;
    }
    const k = key();
    // Inline markup may span lines, so parse whole runs of lines; a trailing backslash is a hard break.
    const runs: string[][] = [[]];
    for (const p of para) {
      runs[runs.length - 1]!.push(p.replace(/\\$/, ''));
      if (/\\$/.test(p)) runs.push([]);
    }
    const parts: ReactNode[] = [];
    runs.filter((r) => r.length).forEach((r, j, all) => {
      parts.push(...inline(r.join(' '), map, `${k}-${j}`));
      if (j < all.length - 1) parts.push(<br key={`${k}-br${j}`} />);
    });
    out.push(<p key={k}>{parts}</p>);
  }
  return out;
}
