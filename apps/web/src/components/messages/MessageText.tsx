'use client';
// Message text with safe auto-links: only http(s) URLs become links, opened in a new tab with
// rel="noopener noreferrer nofollow". Everything else is plain React text (escaped).
import type { ReactNode } from 'react';

const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+\.[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]}'"]$/;

export function safeHref(raw: string): string | null {
  try {
    const u = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

export function MessageText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    // Drop trailing punctuation, but keep a closing paren that belongs to the URL,
    // e.g. https://en.wikipedia.org/wiki/Foo_(bar)
    while (TRAILING.test(url)) {
      const ch = url[url.length - 1];
      if (ch === ')' && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
      url = url.slice(0, -1);
    }
    const start = m.index ?? 0;
    const href = safeHref(url);
    if (!href) continue;
    if (start > last) out.push(text.slice(last, start));
    out.push(<a key={i++} href={href} target="_blank" rel="noopener noreferrer nofollow">{url}</a>);
    last = start + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <span className="kwm-text">{out}</span>;
}
