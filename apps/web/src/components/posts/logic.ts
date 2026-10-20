// Pure helpers for the Kithwall 2 post components (no React, no network, no '@/' imports so vitest can
// run them directly): safe link detection in post text, relative-time buckets, one-level comment
// threads and feed paging.

// ---------------------------------------------------------------------------------------------
// Text → safe segments. Only http(s) links become anchors; everything else stays plain text that React
// escapes. Bare "www." hosts are linked with https://. Trailing punctuation is not part of the link.

export type TextSegment = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAIL = /[.,:;!?…)\]}'"»”’]+$/;

/** Normalise a link found in text, or null when it isn't a safe http(s) URL. */
export function safeHref(raw: string): string | null {
  const withScheme = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Shorten a URL for display: no scheme, no "www.", at most `max` characters. */
export function linkLabel(href: string, max = 48): string {
  const s = href.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function segmentText(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  const push = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'text') prev.text += t; else out.push({ kind: 'text', text: t });
  };
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let raw = m[0];
    // Keep a closing bracket that belongs to the URL itself, e.g. wikipedia.org/wiki/Foo_(bar).
    const trail = TRAIL.exec(raw)?.[0] ?? '';
    let keep = '';
    if (trail.startsWith(')') && (raw.slice(0, -trail.length).match(/\(/g)?.length ?? 0) > (raw.slice(0, -trail.length).match(/\)/g)?.length ?? 0)) keep = ')';
    raw = raw.slice(0, raw.length - trail.length) + keep;
    const href = safeHref(raw);
    push(text.slice(last, start));
    if (href) out.push({ kind: 'link', text: raw, href }); else push(raw);
    last = start + raw.length;
  }
  push(text.slice(last));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Relative time: "now", "5 min", "3 h", "yesterday" → Intl.RelativeTimeFormat units; older → a date.

export type When =
  | { kind: 'now' }
  | { kind: 'relative'; value: number; unit: 'minute' | 'hour' | 'day' }
  | { kind: 'date'; sameYear: boolean };

export function whenParts(iso: string | number | Date, now: number = Date.now()): When {
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return { kind: 'now' };
  const min = Math.round(s / 60);
  if (min < 60) return { kind: 'relative', value: -Math.max(1, min), unit: 'minute' };
  const h = Math.floor(s / 3600);
  if (h < 24) return { kind: 'relative', value: -h, unit: 'hour' };
  const d = Math.floor(s / 86400);
  if (d < 7) return { kind: 'relative', value: -d, unit: 'day' };
  return { kind: 'date', sameYear: new Date(t).getFullYear() === new Date(now).getFullYear() };
}

// ---------------------------------------------------------------------------------------------
// Comments, threaded one level: replies to a reply are shown under the top-level comment it belongs to.

export interface ThreadInput { id: string; created_at: string; replyTo?: string | null }
export interface Thread<T extends ThreadInput> { root: T; replies: T[] }

export function threadComments<T extends ThreadInput>(items: T[]): Thread<T>[] {
  const byId = new Map(items.map((c) => [c.id, c]));
  const rootOf = (c: T): T => {
    let cur = c;
    const seen = new Set<string>();
    while (cur.replyTo && byId.has(cur.replyTo) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.replyTo)!;
    }
    return cur;
  };
  const sorted = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const threads = new Map<string, Thread<T>>();
  for (const c of sorted) {
    const root = rootOf(c);
    if (root.id === c.id) {
      if (!threads.has(c.id)) threads.set(c.id, { root: c, replies: [] });
    } else {
      let th = threads.get(root.id);
      if (!th) { th = { root, replies: [] }; threads.set(root.id, th); }
      th.replies.push(c);
    }
  }
  return [...threads.values()].sort((a, b) => a.root.created_at.localeCompare(b.root.created_at));
}

// ---------------------------------------------------------------------------------------------
// Paging: newest first; the next page starts before the oldest row of a full page.

export function nextCursor(rows: { created_at: string }[], pageSize: number): string | undefined {
  if (rows.length < pageSize) return undefined;
  return rows[rows.length - 1]?.created_at;
}

/** Remove duplicates across pages (a post can appear twice when pages shift during posting). */
export function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

// ---------------------------------------------------------------------------------------------
// Photo grid layout: how many tiles to show and how many are hidden behind "+N".

export function gridLayout(count: number, max = 4): { shown: number; more: number; layout: 'one' | 'two' | 'three' | 'four' } {
  const shown = Math.min(count, max);
  const layout = (['one', 'one', 'two', 'three', 'four'] as const)[Math.min(shown, 4)];
  return { shown, more: Math.max(0, count - shown), layout };
}

/** Clamp a lightbox index into [0, n) with wrap-around disabled (stops at both ends). */
export function stepIndex(i: number, delta: number, n: number): number {
  return Math.max(0, Math.min(n - 1, i + delta));
}
