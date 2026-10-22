// Pure helpers for the Kithwall 2 messenger (no React, no network): grouping messages into runs and
// days, safe link detection, search matching and list ordering. Unit-tested in chatModel.test.ts.

export interface ChatLine { id: string; sender: string; at: string; /** system event (rename, joined…) */ event?: boolean }

export type ThreadItem<T extends ChatLine> =
  | { kind: 'day'; key: string; day: string; at: string }
  | { kind: 'event'; key: string; line: T }
  | { kind: 'msg'; key: string; line: T; first: boolean; last: boolean };

/** Messages closer together than this (same sender, same day) form one visual group. */
export const GROUP_GAP_MS = 5 * 60_000;

/** Local calendar day "YYYY-MM-DD" of an ISO time. */
export function dayKey(iso: string | number | Date): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Day separators + runs: each message knows whether it starts / ends its sender's run. */
export function buildThread<T extends ChatLine>(lines: T[]): ThreadItem<T>[] {
  const out: ThreadItem<T>[] = [];
  let prevDay = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const day = dayKey(line.at);
    if (day !== prevDay) { out.push({ kind: 'day', key: `d-${day}`, day, at: line.at }); prevDay = day; }
    if (line.event) { out.push({ kind: 'event', key: line.id, line }); continue; }
    const prev = lines[i - 1];
    const next = lines[i + 1];
    const joins = (a: T | undefined, b: T | undefined) => !!a && !!b && !a.event && !b.event && a.sender === b.sender
      && dayKey(a.at) === dayKey(b.at) && Math.abs(new Date(b.at).getTime() - new Date(a.at).getTime()) < GROUP_GAP_MS;
    out.push({ kind: 'msg', key: line.id, line, first: !joins(prev, line), last: !joins(line, next) });
  }
  return out;
}

/** 'today' | 'yesterday' | 'week' (within 6 days) | 'older', relative to `now`. */
export function dayBucket(iso: string, now: Date = new Date()): 'today' | 'yesterday' | 'week' | 'older' {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return 'week';
  return 'older';
}

// ---------------------------------------------------------------------------------------------
// Links: only http(s) URLs become links (rel="noopener noreferrer nofollow", new tab). Everything
// else stays plain text, escaped by React.

const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+\.[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]}'"]$/;

export function safeHref(raw: string): string | null {
  try {
    const u = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}

export type TextPart = { text: string } | { text: string; href: string };

export function linkify(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    while (TRAILING.test(url)) {
      const ch = url[url.length - 1];
      if (ch === ')' && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
      url = url.slice(0, -1);
    }
    const start = m.index ?? 0;
    const href = safeHref(url);
    if (!href) continue;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: url, href });
    last = start + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The first link in a message (for a preview card), or null. */
export function firstUrl(text: string): string | null {
  for (const p of linkify(text)) if ('href' in p) return p.href;
  return null;
}

/**
 * The link the composer may OFFER a preview for (security review C2). Offering costs nothing: the preview
 * is fetched only when the person taps "Add link preview" (ChatComposer), never while they type.
 * Null with attachments, with the setting off, or after the person dismissed the offer for this link.
 */
export function previewOffer(text: string, opts: { hasFiles: boolean; enabled: boolean; dismissed?: string | null }): string | null {
  if (opts.hasFiles || !opts.enabled) return null;
  const url = firstUrl(text);
  return url && url !== opts.dismissed ? url : null;
}

let graphemes: Intl.Segmenter | null | undefined;
function segmenter(): Intl.Segmenter | null {
  if (graphemes === undefined) graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return graphemes;
}

/** A message that is only emoji (1–3) is shown large, without a bubble. */
export function isEmojiOnly(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 24) return false;
  const g = segmenter();
  const seg = g ? [...g.segment(t)].map((s) => s.segment) : Array.from(t);
  const parts = seg.filter((s) => s.trim());
  return parts.length >= 1 && parts.length <= 3 && parts.every((s) => /\p{Extended_Pictographic}/u.test(s));
}

// ---------------------------------------------------------------------------------------------
// Search (on this device, over decrypted names and previews)

/** Case- and accent-insensitive "contains". */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  return fields.some((f) => !!f && fold(f).includes(q));
}

// ---------------------------------------------------------------------------------------------
// List order: pinned first (most recently pinned on top), then newest activity.

export interface ListEntry { id: string; lastAt: string; pinnedAt?: string | null }

export function orderConversations<T extends ListEntry>(xs: T[]): T[] {
  return [...xs].sort((a, b) => {
    const pa = a.pinnedAt ?? '';
    const pb = b.pinnedAt ?? '';
    if (pa || pb) {
      if (!pa) return 1;
      if (!pb) return -1;
      if (pa !== pb) return pb.localeCompare(pa);
    }
    return b.lastAt.localeCompare(a.lastAt);
  });
}

/** Clip a preview / quote to a short single line. */
export function snippet(text: string, max = 90): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** Group "who reacted": emoji → user ids, in the picker's order. */
export function tallyReactions(list: { userId: string; emoji: string }[], order: readonly string[]): { emoji: string; users: string[] }[] {
  const by = new Map<string, string[]>();
  for (const r of list) {
    const xs = by.get(r.emoji) ?? [];
    if (!xs.includes(r.userId)) xs.push(r.userId);
    by.set(r.emoji, xs);
  }
  return [...by.entries()]
    .sort((a, b) => b[1].length - a[1].length || order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([emoji, users]) => ({ emoji, users }));
}
