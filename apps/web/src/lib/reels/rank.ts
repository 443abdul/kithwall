// Reels: the ranking, done on this device (docs/v2/12-reels.md §3). Pure and unit-tested (rank.test.ts).
//
// The server hands every device the same generic pages (reels of the people I follow, and public reels by
// popularity and by time). What I see first is decided here, from a small interest profile that is built
// from what I did with earlier reels and never leaves the device (./store.ts keeps it encrypted in
// IndexedDB): which authors and topics I watched to the end, liked, replayed, skipped quickly or marked
// "not interested", which language the reel is in, how new it is, and how popular it is in public.
// Scores fade with a half-life of three weeks, so the profile follows what I like now.

export interface Affinity { /** Score at time `t`. */ s: number; /** When it was last changed (ms). */ t: number }

export interface ReelProfile {
  v: 1;
  authors: Record<string, Affinity>;
  topics: Record<string, Affinity>;
  langs: Record<string, Affinity>;
  /** Reels I have been shown: id → when (ms). They are not queued again. */
  seen: Record<string, number>;
  /** Reels I marked "not interested": id → when (ms). */
  hidden: Record<string, number>;
}

export const emptyProfile = (): ReelProfile => ({ v: 1, authors: {}, topics: {}, langs: {}, seen: {}, hidden: {} });

/** What I did with a reel. Only ever recorded on this device. */
export type ReelSignal = 'complete' | 'replay' | 'like' | 'comment' | 'share' | 'follow' | 'skip' | 'not_interested';

/** What the ranking knows about a reel: all of it comes from the reel itself and its public counts. */
export interface ReelCandidate {
  id: string;
  authorId: string;
  /** When it was posted (ms). */
  at: number;
  /** 'followed': by someone I follow, am connected to or share a circle with. 'discover': a public reel. */
  source: 'followed' | 'discover';
  /** Hashtags of the caption, normalised (reelTopics). */
  topics: string[];
  /** Language of the reel (reelLang), when known. */
  lang: string | null;
  /** Public like and comment counts; only public reels have them. */
  likes?: number;
  comments?: number;
}

export type QueueItem = { kind: 'reel'; id: string; source: ReelCandidate['source'] } | { kind: 'caughtUp' };

export const HALF_LIFE_MS = 21 * 86_400_000;
const CAP = 12;
const MAX_AUTHORS = 400;
const MAX_TOPICS = 300;
const MAX_LANGS = 24;
const MAX_SEEN = 800;
const MAX_HIDDEN = 300;
/** Left before this many seconds (or this share of the reel): counted as a quick skip. */
export const SKIP_SECONDS = 2;
export const SKIP_SHARE = 0.15;

// author, topic and language weight of each signal
const WEIGHTS: Record<ReelSignal, [number, number, number]> = {
  complete: [1, 0.6, 0.3],
  replay: [1.5, 0.9, 0.3],
  like: [2, 1.2, 0.4],
  comment: [1.5, 0.8, 0.3],
  share: [1.5, 0.8, 0.3],
  follow: [3, 0, 0],
  skip: [-0.6, -0.4, -0.1],
  not_interested: [-4, -2, 0],
};

/** An affinity's value now: it halves every three weeks. */
export function decayed(a: Affinity | undefined, now: number): number {
  if (!a || !Number.isFinite(a.s) || !Number.isFinite(a.t)) return 0;
  return a.s * Math.pow(0.5, Math.max(0, now - a.t) / HALF_LIFE_MS);
}

function bump(map: Record<string, Affinity>, key: string, delta: number, now: number) {
  if (!key || !delta) return;
  const next = Math.max(-CAP, Math.min(CAP, decayed(map[key], now) + delta));
  map[key] = { s: Math.round(next * 1000) / 1000, t: now };
}

// When a map outgrows its bound it is cut back to nine tenths of it, so the sorting happens once in a while
// rather than on every reel.
const trimTo = (max: number) => Math.floor(max * 0.9);

/** Keep the entries that matter most now (largest faded score, either direction). */
function pruneAffinities(map: Record<string, Affinity>, max: number, now: number): Record<string, Affinity> {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const weight = keys.map((k) => [k, Math.abs(decayed(map[k], now))] as const).sort((a, b) => b[1] - a[1]).slice(0, trimTo(max));
  return Object.fromEntries(weight.map(([k]) => [k, map[k]!]));
}

/** Keep the newest entries of an id → time map. */
function pruneTimes(map: Record<string, number>, max: number): Record<string, number> {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  return Object.fromEntries(keys.sort((a, b) => map[b]! - map[a]!).slice(0, trimTo(max)).map((k) => [k, map[k]!]));
}

/** The profile after one thing I did with a reel. Returns a new object; the old one is not changed. */
export function applySignal(profile: ReelProfile, c: Pick<ReelCandidate, 'id' | 'authorId' | 'topics' | 'lang'>, signal: ReelSignal, now: number): ReelProfile {
  const [wa, wt, wl] = WEIGHTS[signal];
  const p: ReelProfile = { v: 1, authors: { ...profile.authors }, topics: { ...profile.topics }, langs: { ...profile.langs }, seen: profile.seen, hidden: profile.hidden };
  bump(p.authors, c.authorId, wa, now);
  for (const tag of c.topics.slice(0, 8)) bump(p.topics, tag, wt, now);
  if (c.lang) bump(p.langs, c.lang, wl, now);
  if (signal === 'not_interested') p.hidden = pruneTimes({ ...profile.hidden, [c.id]: now }, MAX_HIDDEN);
  p.authors = pruneAffinities(p.authors, MAX_AUTHORS, now);
  p.topics = pruneAffinities(p.topics, MAX_TOPICS, now);
  p.langs = pruneAffinities(p.langs, MAX_LANGS, now);
  return p;
}

/** Remember that a reel was shown, so it is not queued again. */
export function markSeen(profile: ReelProfile, id: string, now: number): ReelProfile {
  if (profile.seen[id]) return profile;
  return { ...profile, seen: pruneTimes({ ...profile.seen, [id]: now }, MAX_SEEN) };
}

/** A profile read from storage: anything malformed is dropped rather than trusted. */
export function cleanProfile(v: unknown): ReelProfile {
  const out = emptyProfile();
  if (!v || typeof v !== 'object') return out;
  const src = v as Partial<Record<keyof ReelProfile, unknown>>;
  const affinities = (m: unknown, max: number) => {
    const res: Record<string, Affinity> = {};
    if (!m || typeof m !== 'object') return res;
    for (const [k, a] of Object.entries(m as Record<string, unknown>).slice(0, max)) {
      const x = a as Partial<Affinity> | null;
      if (k.length <= 80 && x && typeof x.s === 'number' && typeof x.t === 'number' && Number.isFinite(x.s) && Number.isFinite(x.t)) {
        res[k] = { s: Math.max(-CAP, Math.min(CAP, x.s)), t: x.t };
      }
    }
    return res;
  };
  const times = (m: unknown, max: number) => {
    const res: Record<string, number> = {};
    if (!m || typeof m !== 'object') return res;
    for (const [k, t] of Object.entries(m as Record<string, unknown>).slice(0, max)) if (k.length <= 80 && typeof t === 'number' && Number.isFinite(t)) res[k] = t;
    return res;
  };
  out.authors = affinities(src.authors, MAX_AUTHORS);
  out.topics = affinities(src.topics, MAX_TOPICS);
  out.langs = affinities(src.langs, MAX_LANGS);
  out.seen = times(src.seen, MAX_SEEN);
  out.hidden = times(src.hidden, MAX_HIDDEN);
  return out;
}

// ------------------------------------------------------------------------------------- reading a reel
const TAG = /(^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_]{2,40})/gu;

/** The hashtags of a caption, lower-cased and normalised, at most eight. */
export function reelTopics(caption: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (caption ?? '').matchAll(TAG)) {
    const tag = m[2]!.normalize('NFKC').toLowerCase();
    if (!/^\p{N}+$/u.test(tag) && !out.includes(tag)) out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

const SCRIPTS: [RegExp, string][] = [
  [/\p{Script=Arabic}/gu, 'arab'], [/\p{Script=Devanagari}/gu, 'deva'], [/\p{Script=Bengali}/gu, 'beng'],
  [/\p{Script=Cyrillic}/gu, 'cyrl'], [/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, 'hani'], [/\p{Script=Latin}/gu, 'latn'],
];

/**
 * The language of a reel for ranking: the two-letter language its author's app was in when the reel carries
 * one, otherwise the script most of its caption is written in ('latn', 'arab', …), otherwise unknown.
 */
export function reelLang(hint: string | null | undefined, caption: string | null | undefined): string | null {
  const h = (hint ?? '').toLowerCase();
  if (/^[a-z]{2,3}$/.test(h)) return h;
  const text = (caption ?? '').replace(/#[\p{L}\p{N}_]+|@[a-z0-9._-]+|https?:\/\/\S+/giu, ' ');
  let best: string | null = null;
  let most = 2; // a couple of letters say nothing
  for (const [re, name] of SCRIPTS) {
    const n = text.match(re)?.length ?? 0;
    if (n > most) { most = n; best = name; }
  }
  return best;
}

/** The script a language is normally written in, to compare an app language with a caption's script. */
export function scriptOf(lang: string): string {
  const l = lang.toLowerCase().slice(0, 2);
  if (l === 'ar' || l === 'ur' || l === 'fa') return 'arab';
  if (l === 'hi') return 'deva';
  if (l === 'bn') return 'beng';
  if (l === 'ru') return 'cyrl';
  if (l === 'zh' || l === 'ja') return 'hani';
  return 'latn';
}

// ------------------------------------------------------------------------------------- scoring
export interface RankOptions {
  now: number;
  /** The language of my app (two letters). */
  lang: string;
  /** Changes the small shuffle between sessions, so equal reels don't always come in the same order. */
  seed?: number;
}

/** A stable pseudo-random number in [0, 1) for a reel and a seed (FNV-1a). */
export function jitter(id: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 0x100000000;
}

const langMatch = (c: ReelCandidate, lang: string) => !!c.lang && (c.lang === lang || c.lang === scriptOf(lang));

/** How new and how popular a reel is: the part of the score that has nothing to do with me. */
export function baseScore(c: ReelCandidate, o: RankOptions): number {
  const ageHours = Math.max(0, o.now - c.at) / 3_600_000;
  const fresh = Math.exp(-ageHours / 72);
  const pop = Math.min(1, Math.log1p((c.likes ?? 0) + 2 * (c.comments ?? 0)) / Math.log(201));
  return fresh + 0.8 * pop + 0.15 * jitter(c.id, o.seed ?? 0);
}

/** Higher comes first. */
export function scoreReel(c: ReelCandidate, profile: ReelProfile, o: RankOptions): number {
  const author = 2 * Math.tanh(decayed(profile.authors[c.authorId], o.now) / 3);
  const tags = c.topics.map((t) => decayed(profile.topics[t], o.now));
  const topic = tags.length ? 1.2 * Math.tanh(tags.reduce((a, b) => a + b, 0) / tags.length / 2) : 0;
  const lang = c.lang ? 0.5 * Math.tanh(decayed(profile.langs[c.lang], o.now) / 4) + (langMatch(c, o.lang) ? 0.35 : 0) : 0;
  return baseScore(c, o) + author + topic + lang;
}

/**
 * The order to play reels in.
 *  - `fixed` is what was already queued up to (and just past) the reel on screen; it is kept as it is, so
 *    nothing jumps around under the viewer. Everything after it is ranked afresh from the current profile.
 *  - Reels I have seen or marked "not interested" are left out (unless `includeSeen`).
 *  - Followed and discovered reels are mixed: two followed, then one discovered, while followed ones last.
 *    When they run out, a "You're all caught up" card comes before discovery continues (not while
 *    `moreFollowed` says further pages of followed reels are still to be fetched).
 *  - Among discovered reels every fourth place goes to the best reel by newness and popularity alone, so the
 *    feed keeps showing things outside what the profile already favours.
 */
export function buildQueue(cands: readonly ReelCandidate[], profile: ReelProfile,
  o: RankOptions & { fixed?: readonly QueueItem[]; includeSeen?: boolean; moreFollowed?: boolean }): QueueItem[] {
  const fixed = [...(o.fixed ?? [])];
  const placed = new Set(fixed.flatMap((q) => (q.kind === 'reel' ? [q.id] : [])));
  const byId = new Map<string, ReelCandidate>();
  for (const c of cands) {
    const prev = byId.get(c.id);
    // The same reel can arrive both from the people I follow and from the public pages: it counts as followed.
    if (!prev || (prev.source === 'discover' && c.source === 'followed')) byId.set(c.id, prev ? { ...c, likes: c.likes ?? prev.likes, comments: c.comments ?? prev.comments } : c);
    else if (prev.likes === undefined && c.likes !== undefined) byId.set(c.id, { ...prev, likes: c.likes, comments: c.comments });
  }
  const rest = [...byId.values()].filter((c) => !placed.has(c.id) && !profile.hidden[c.id] && (o.includeSeen || !profile.seen[c.id]));
  const scored = rest.map((c) => ({ c, score: scoreReel(c, profile, o), base: baseScore(c, o) }));
  const followed = scored.filter((x) => x.c.source === 'followed').sort((a, b) => b.score - a.score || (a.c.id < b.c.id ? -1 : 1));
  const discover = scored.filter((x) => x.c.source === 'discover').sort((a, b) => b.score - a.score || (a.c.id < b.c.id ? -1 : 1));

  // Discovery order with an exploration slot at every fourth place.
  const disc: ReelCandidate[] = [];
  const left = [...discover];
  while (left.length) {
    let pick = 0;
    if (disc.length % 4 === 3) for (let i = 1; i < left.length; i++) if (left[i]!.base > left[pick]!.base) pick = i;
    disc.push(left.splice(pick, 1)[0]!.c);
  }

  const out: QueueItem[] = fixed;
  const hadFollowed = followed.length > 0 || fixed.some((q) => q.kind === 'reel' && q.source === 'followed');
  const caughtUp = fixed.some((q) => q.kind === 'caughtUp');
  // Keep the two-then-one rhythm going across the fixed part.
  let run = 0;
  for (let i = fixed.length - 1; i >= 0 && run < 2; i--) { const q = fixed[i]!; if (q.kind === 'reel' && q.source === 'followed') run++; else break; }
  let f = 0;
  let d = 0;
  while (f < followed.length) {
    if (run >= 2 && d < disc.length) { out.push({ kind: 'reel', id: disc[d++]!.id, source: 'discover' }); run = 0; continue; }
    out.push({ kind: 'reel', id: followed[f++]!.c.id, source: 'followed' });
    run++;
  }
  if (hadFollowed && !caughtUp && !o.moreFollowed) out.push({ kind: 'caughtUp' });
  while (d < disc.length) out.push({ kind: 'reel', id: disc[d++]!.id, source: 'discover' });
  return out;
}

/** Was leaving a reel after `watched` seconds a quick skip? */
export function isQuickSkip(watched: number, duration: number | undefined): boolean {
  if (!(watched >= 0)) return false;
  if (watched < SKIP_SECONDS) return true;
  return !!duration && duration > 0 && watched / duration < SKIP_SHARE;
}

/** A few plain numbers about the profile, for Settings ("what reels has learned"). */
export function profileSummary(profile: ReelProfile, now: number): { authors: number; topics: number; seen: number; hidden: number } {
  const live = (m: Record<string, Affinity>) => Object.values(m).filter((a) => Math.abs(decayed(a, now)) >= 0.05).length;
  return { authors: live(profile.authors), topics: live(profile.topics), seen: Object.keys(profile.seen).length, hidden: Object.keys(profile.hidden).length };
}
