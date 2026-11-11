// On-device ranking for reels (docs/v2/12-reels.md §3). Run: npx vitest run src/lib/reels
import { describe, expect, it } from 'vitest';
import {
  applySignal, buildQueue, cleanProfile, decayed, emptyProfile, HALF_LIFE_MS, isQuickSkip, markSeen, profileSummary, reelLang,
  reelTopics, scoreReel, type QueueItem, type ReelCandidate, type ReelProfile,
} from './rank';

const NOW = Date.UTC(2026, 10, 11, 12);
const HOUR = 3_600_000;
const o = { now: NOW, lang: 'en', seed: 7 };

function cand(id: string, over: Partial<ReelCandidate> = {}): ReelCandidate {
  return { id, authorId: `author-${id}`, at: NOW - 5 * HOUR, source: 'discover', topics: [], lang: null, ...over };
}
const ids = (q: QueueItem[]) => q.map((x) => (x.kind === 'reel' ? x.id : '*'));

describe('reading a reel', () => {
  it('takes hashtags as topics, normalised, without duplicates or bare numbers', () => {
    expect(reelTopics('Sunday #Baking with #sourdough and #BAKING again #2026 #a')).toEqual(['baking', 'sourdough']);
    expect(reelTopics('عيد مبارك #عيد #لاہور')).toEqual(['عيد', 'لاہور']);
    expect(reelTopics('no tags here, issue#12 is not one')).toEqual([]);
    expect(reelTopics(null)).toEqual([]);
    expect(reelTopics(Array.from({ length: 20 }, (_, i) => `#tag${i}x`).join(' '))).toHaveLength(8);
  });

  it('knows the language from the hint, else from the script of the caption', () => {
    expect(reelLang('ur', 'anything')).toBe('ur');
    expect(reelLang(undefined, 'Cooking at home with friends')).toBe('latn');
    expect(reelLang(null, 'آج کا دن بہت اچھا تھا #lahore')).toBe('arab');
    expect(reelLang('not a language!', 'Привет, как дела')).toBe('cyrl');
    expect(reelLang(null, '#tags #only')).toBeNull();
    expect(reelLang(null, '')).toBeNull();
  });
});

describe('the interest profile', () => {
  it('learns from what I do and forgets with a three-week half-life', () => {
    const c = cand('a', { topics: ['baking'], lang: 'en' });
    let p = applySignal(emptyProfile(), c, 'complete', NOW);
    p = applySignal(p, c, 'like', NOW);
    expect(decayed(p.authors[c.authorId], NOW)).toBeCloseTo(3, 5);
    expect(decayed(p.topics.baking, NOW)).toBeCloseTo(1.8, 5);
    expect(decayed(p.langs.en, NOW)).toBeCloseTo(0.7, 5);
    expect(decayed(p.authors[c.authorId], NOW + HALF_LIFE_MS)).toBeCloseTo(1.5, 5);
    expect(decayed(p.authors[c.authorId], NOW + 10 * HALF_LIFE_MS)).toBeLessThan(0.01);
  });

  it('does not change the profile it was given', () => {
    const before = emptyProfile();
    applySignal(before, cand('a', { topics: ['x1'] }), 'like', NOW);
    expect(before).toEqual(emptyProfile());
  });

  it('skips and "not interested" count against an author and a topic', () => {
    const c = cand('a', { topics: ['pranks'] });
    let p = applySignal(emptyProfile(), c, 'skip', NOW);
    expect(decayed(p.authors[c.authorId], NOW)).toBeLessThan(0);
    p = applySignal(p, c, 'not_interested', NOW);
    expect(decayed(p.authors[c.authorId], NOW)).toBeCloseTo(-4.6, 5);
    expect(decayed(p.topics.pranks, NOW)).toBeCloseTo(-2.4, 5);
    expect(p.hidden.a).toBe(NOW);
  });

  it('stays bounded however much is watched', () => {
    let p = emptyProfile();
    for (let i = 0; i < 1500; i++) {
      p = applySignal(p, cand(`r${i}`, { topics: [`t${i}`] }), 'complete', NOW + i);
      p = markSeen(p, `r${i}`, NOW + i);
    }
    for (let i = 0; i < 50; i++) p = applySignal(p, cand('same'), 'like', NOW);
    expect(Object.keys(p.authors).length).toBeLessThanOrEqual(400);
    expect(Object.keys(p.topics).length).toBeLessThanOrEqual(300);
    expect(Object.keys(p.seen).length).toBeLessThanOrEqual(800);
    expect(p.seen.r1499).toBeDefined(); // the newest are the ones kept
    expect(decayed(p.authors['author-same'], NOW)).toBeLessThanOrEqual(12);
  });

  it('drops anything malformed read back from storage', () => {
    const p = cleanProfile({ authors: { a: { s: 2, t: NOW }, b: { s: 'x', t: NOW }, c: null }, topics: 'nope', seen: { r1: NOW, r2: 'yesterday' }, hidden: [] });
    expect(Object.keys(p.authors)).toEqual(['a']);
    expect(p.topics).toEqual({});
    expect(p.seen).toEqual({ r1: NOW });
    expect(cleanProfile(null)).toEqual(emptyProfile());
    expect(cleanProfile({ authors: { a: { s: 9999, t: NOW } } }).authors.a!.s).toBe(12);
  });

  it('summarises itself in plain numbers', () => {
    let p = applySignal(emptyProfile(), cand('a', { topics: ['baking', 'bread'] }), 'like', NOW);
    p = markSeen(p, 'a', NOW);
    expect(profileSummary(p, NOW)).toEqual({ authors: 1, topics: 2, seen: 1, hidden: 0 });
  });
});

describe('scoring', () => {
  it('prefers authors and topics I watched to the end, and what I skipped sinks', () => {
    const liked = cand('liked', { topics: ['baking'] });
    const skipped = cand('skipped', { topics: ['pranks'] });
    const fresh = cand('fresh');
    let p: ReelProfile = emptyProfile();
    for (let i = 0; i < 3; i++) p = applySignal(p, liked, 'complete', NOW);
    for (let i = 0; i < 3; i++) p = applySignal(p, skipped, 'skip', NOW);
    const next = (id: string, src: ReelCandidate) => scoreReel(cand(id, { authorId: src.authorId, topics: src.topics }), p, o);
    expect(next('n1', liked)).toBeGreaterThan(scoreReel(fresh, p, o));
    expect(next('n2', skipped)).toBeLessThan(scoreReel(fresh, p, o));
  });

  it('newer and more popular reels score higher when I have no history', () => {
    const p = emptyProfile();
    expect(scoreReel(cand('new', { at: NOW - HOUR }), p, o)).toBeGreaterThan(scoreReel(cand('old', { at: NOW - 240 * HOUR }), p, o));
    expect(scoreReel(cand('hit', { likes: 150, comments: 20 }), p, o)).toBeGreaterThan(scoreReel(cand('quiet', { likes: 0, comments: 0 }), p, o) + 0.3);
  });

  it('gives reels in my language a small lift', () => {
    const p = emptyProfile();
    const mine = scoreReel(cand('x', { lang: 'en' }), p, o);
    const other = scoreReel(cand('x', { lang: 'tr' }), p, o);
    expect(mine - other).toBeCloseTo(0.35, 5);
    // A caption only tells its script: Urdu readers get Arabic-script captions lifted.
    expect(scoreReel(cand('x', { lang: 'arab' }), p, { ...o, lang: 'ur' })).toBeGreaterThan(scoreReel(cand('x', { lang: 'latn' }), p, { ...o, lang: 'ur' }));
  });
});

describe('the queue', () => {
  const followed = ['f1', 'f2', 'f3', 'f4', 'f5'].map((id, i) => cand(id, { source: 'followed', at: NOW - (i + 1) * HOUR }));
  const discover = ['d1', 'd2', 'd3', 'd4'].map((id, i) => cand(id, { at: NOW - (i + 1) * HOUR }));

  it('mixes two followed reels with one discovered, then says "all caught up", then goes on discovering', () => {
    const q = buildQueue([...discover, ...followed], emptyProfile(), o);
    expect(q.filter((x) => x.kind === 'caughtUp')).toHaveLength(1);
    const order = q.map((x) => (x.kind === 'caughtUp' ? '*' : x.source === 'followed' ? 'F' : 'D')).join('');
    expect(order).toBe('FFDFFDF*DD');
    expect(new Set(ids(q)).size).toBe(q.length);
  });

  it('has no "caught up" card when I follow nobody who makes reels', () => {
    const q = buildQueue(discover, emptyProfile(), o);
    expect(ids(q)).not.toContain('*');
    expect(q).toHaveLength(4);
  });

  it('waits with "caught up" while more followed reels are still to be fetched', () => {
    const q = buildQueue([...followed, ...discover], emptyProfile(), { ...o, moreFollowed: true });
    expect(ids(q)).not.toContain('*');
  });

  it('ends on "caught up" when there is nothing to discover', () => {
    expect(ids(buildQueue(followed.slice(0, 2), emptyProfile(), o))).toEqual(['f1', 'f2', '*']);
  });

  it('leaves out what I have seen or marked "not interested"', () => {
    let p = markSeen(emptyProfile(), 'f1', NOW);
    p = applySignal(p, discover[0]!, 'not_interested', NOW);
    const q = ids(buildQueue([...followed, ...discover], p, o));
    expect(q).not.toContain('f1');
    expect(q).not.toContain('d1');
    expect(ids(buildQueue([...followed, ...discover], p, { ...o, includeSeen: true }))).toContain('f1');
    expect(ids(buildQueue([...followed, ...discover], p, { ...o, includeSeen: true }))).not.toContain('d1');
  });

  it('keeps what is already on screen and re-ranks only what comes after', () => {
    const first = buildQueue([...followed, ...discover], emptyProfile(), o);
    const fixed = first.slice(0, 3);
    // I liked d4's author a lot while watching: it should now come before the other discovered reels.
    let p = emptyProfile();
    for (let i = 0; i < 4; i++) p = applySignal(p, discover[3]!, 'like', NOW);
    const again = buildQueue([...followed, ...discover], p, { ...o, fixed });
    expect(again.slice(0, 3)).toEqual(fixed);
    const rest = again.slice(3).filter((x) => x.kind === 'reel' && x.source === 'discover').map((x) => (x.kind === 'reel' ? x.id : ''));
    expect(rest[0]).toBe('d4');
    expect(new Set(ids(again)).size).toBe(again.length);
    expect(again.filter((x) => x.kind === 'caughtUp')).toHaveLength(1);
  });

  it('counts a reel that arrives from both sources once, as followed, with its public counts', () => {
    const both = [cand('x', { source: 'discover', likes: 9, comments: 1 }), cand('x', { source: 'followed' })];
    const q = buildQueue(both, emptyProfile(), o);
    expect(q).toEqual([{ kind: 'reel', id: 'x', source: 'followed' }, { kind: 'caughtUp' }]);
  });

  it('keeps a place for something new: every fourth discovered reel is picked without the profile', () => {
    // Eight reels by an author I love, one fresh popular reel by a stranger I skipped once.
    const fav = Array.from({ length: 8 }, (_, i) => cand(`fav${i}`, { authorId: 'fav', at: NOW - 200 * HOUR }));
    const other = cand('other', { authorId: 'other', at: NOW - HOUR, likes: 120, comments: 30 });
    let p = emptyProfile();
    for (let i = 0; i < 5; i++) p = applySignal(p, fav[0]!, 'like', NOW);
    for (let i = 0; i < 4; i++) p = applySignal(p, other, 'skip', NOW);
    const q = ids(buildQueue([...fav, other], p, o));
    expect(q.indexOf('other')).toBe(3);
  });

  it('is the same order for the same inputs, and a different seed may shuffle equals', () => {
    const many = Array.from({ length: 12 }, (_, i) => cand(`e${i}`, { at: NOW - 5 * HOUR }));
    expect(buildQueue(many, emptyProfile(), o)).toEqual(buildQueue(many, emptyProfile(), o));
    expect(ids(buildQueue(many, emptyProfile(), { ...o, seed: 99 }))).not.toEqual(ids(buildQueue(many, emptyProfile(), o)));
  });
});

describe('quick skips', () => {
  it('is a skip when left within two seconds or before 15% of the reel', () => {
    expect(isQuickSkip(1.2, 30)).toBe(true);
    expect(isQuickSkip(4, 60)).toBe(true);
    expect(isQuickSkip(6, 30)).toBe(false);
    expect(isQuickSkip(3, undefined)).toBe(false);
    expect(isQuickSkip(NaN, 30)).toBe(false);
  });
});
