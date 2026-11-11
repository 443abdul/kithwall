// From chat messages to games (docs/v2/11-games.md §4). A chat's game messages are sorted by the server's
// time and linked into chains by the hash each one names; every link is checked with `step`. The result
// is the same on every device that sees the same messages, whatever order they arrived in:
//
//   - a message that follows the rules extends its chain;
//   - a second message for the same place in a game (two devices, a retry, a race between a move and a
//     resignation) loses to the one the server stored first, silently;
//   - a message that breaks the rules, was edited, or hangs on nothing is refused and reported;
//   - when the start of a game is no longer there (disappearing messages), the oldest message still there
//     is taken as the starting point: its copy of the match is all anyone has.
//
// Which chain is the game, if there are several (someone deleted a move after it was answered, or made one
// up): the one that holds my own newest message, because my device only ever builds on moves it checked.
// For a game I'm not playing, the chain that starts at the invite; failing that, the newest.
//
// Pure: no React, no network.
import { canonicalJson } from '@kithwall/crypto';
import { linkOf, stamp, step, validInvite, type GameEvent, type Head, type Match } from './match';

export interface GameItem {
  /** The chat message: id, sender, server time, and whether it was edited after it was sent. */
  id: string; sender: string; at: string; edited: boolean;
  ev: GameEvent;
  /** Still being sent from this device (not stored by the server yet). */
  pending?: boolean;
}

export interface GameNode extends Head {
  id: string; sender: string; pending: boolean;
  /** True for the invite: a chain that starts here is checked from the first message on. */
  invite: boolean;
  order: number;
  parent: GameNode | null; child: GameNode | null;
}

export interface GameView {
  id: string;
  /** The match as it stands. */
  match: Match;
  head: GameNode;
  /** Root first, head last. */
  chain: GameNode[];
  /** Checked from the invite on (false: earlier messages are gone, the oldest one left was taken on trust). */
  complete: boolean;
  /** The head is a message of mine that is still being sent. */
  pending: boolean;
  /** Messages that were refused: "X sent a move that isn't allowed". */
  refused: { id: string; sender: string; at: string }[];
  /**
   * Stored messages that lost the race for their place in the game to the message that is now the head (two
   * people accepting at once, a move against a draw offer). The device that sent one sends it again.
   */
  dropped: GameItem[];
  /** Every chat message of this game (the thread shows one card for all of them). */
  rows: string[];
  /** The stored message the card stands in for (the newest one of the chain); null while only pending. */
  cardRow: string | null;
}

/** The digits after the milliseconds of a Postgres timestamp ("…12.345678+00:00" → 678), 0 when absent. */
function micros(at: string): number {
  const frac = /\.(\d+)/.exec(at)?.[1] ?? '';
  return Number((frac + '000000').slice(3, 6));
}

function byTime(a: GameItem, b: GameItem): number {
  if (!!a.pending !== !!b.pending) return a.pending ? 1 : -1;
  if (a.pending) return 0; // keep the order they were written in
  // Server time to the microsecond (read from the digits, so the text format doesn't matter), then the id.
  return stamp(a.at) - stamp(b.at) || micros(a.at) - micros(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const tipOf = (n: GameNode) => { let x = n; while (x.child) x = x.child; return x; };
const rootOf = (n: GameNode) => { let x = n; while (x.parent) x = x.parent; return x; };

function reduce(g: string, items: GameItem[], me: string | null, waiting: boolean): GameView | null {
  const byLink = new Map<string, GameNode>();
  const roots: GameNode[] = [];
  const refused: { item: GameItem; order: number }[] = [];
  const dropped: GameItem[] = [];
  const add = (it: GameItem, order: number, parent: GameNode | null, invite: boolean) => {
    const link = linkOf(it.ev);
    if (byLink.has(link)) return; // the very same event sent twice
    const node: GameNode = { id: it.id, sender: it.sender, at: it.at, ev: it.ev, link, pending: !!it.pending, invite, order, parent, child: null };
    byLink.set(link, node);
    if (parent) parent.child = node; else roots.push(node);
  };
  items.forEach((it, order) => {
    const ev = it.ev;
    if (it.edited) { refused.push({ item: it, order }); return; }
    if (ev.n === 0) {
      if (validInvite(ev, it.sender, it.id) && !roots.some((r) => r.invite)) add(it, order, null, true);
      else refused.push({ item: it, order });
      return;
    }
    const parent = byLink.get(ev.p);
    if (parent && parent.ev.n + 1 === ev.n) {
      if (parent.child) { if (!it.pending) dropped.push(it); return; } // this place was taken first by another message
      const res = step(parent.ev.s, { g, n: ev.n, sender: it.sender, link: parent.link, prevAt: stamp(parent.at), at: stamp(it.at) }, ev.a);
      if (res.ok && canonicalJson(res.match) === canonicalJson(ev.s)) add(it, order, parent, false);
      else if (res.ok || res.why === 'illegal') refused.push({ item: it, order });
      return;
    }
    // It hangs on nothing we have: a possible starting point, if its sender is the player it says it is.
    if (ev.s.players[ev.s.who] === it.sender) add(it, order, null, false);
  });
  if (!roots.length) return null;

  const nodes = [...byLink.values()];
  const mine = me ? nodes.filter((n) => n.sender === me) : [];
  let root: GameNode | undefined = mine.length ? rootOf(mine.reduce((a, b) => (b.order > a.order ? b : a))) : roots.find((r) => r.invite);
  if (!root) {
    // Named as a player with nothing of my own to go by: a finished game can't be taken on someone's word.
    const ok = roots.filter((r) => !(me && r.ev.s.players.includes(me) && tipOf(r).ev.s.result));
    root = ok.length ? ok.reduce((a, b) => (tipOf(b).order > tipOf(a).order ? b : a)) : undefined;
  }
  if (!root) return null;

  const chain: GameNode[] = [];
  for (let x: GameNode | null = root; x; x = x.child) chain.push(x);
  const head = chain[chain.length - 1]!;
  const stored = [...chain].reverse().find((n) => !n.pending);
  // A later message that started a chain of its own is made up, or built on a move that was taken back.
  // While some messages can't be read yet (a key is on its way), it may simply be missing its neighbours.
  const strays = waiting ? [] : roots.filter((r) => r !== root && r.order > root.order && r.sender !== me);
  return {
    id: g, match: head.ev.s, head, chain, complete: root.invite, pending: head.pending,
    refused: [
      ...refused.filter((r) => r.order > root.order).map((r) => r.item),
      ...strays.map((r) => ({ id: r.id, sender: r.sender, at: r.at })),
    ].map(({ id, sender, at }) => ({ id, sender, at })).sort((a, b) => stamp(a.at) - stamp(b.at)),
    dropped: dropped.filter((it) => it.ev.n === head.ev.n && it.ev.p === head.ev.p && it.id !== head.id),
    rows: items.filter((it) => !it.pending).map((it) => it.id),
    cardRow: stored?.id ?? null,
  };
}

/**
 * Every game in these messages, oldest activity first. `waiting`: some messages of the chat can't be
 * decrypted yet, so a message that seems to hang on nothing is not reported.
 */
export function buildGames(items: GameItem[], me: string | null, waiting = false): GameView[] {
  const sorted = [...items].sort(byTime);
  const groups = new Map<string, GameItem[]>();
  for (const it of sorted) {
    const xs = groups.get(it.ev.g);
    if (xs) xs.push(it); else groups.set(it.ev.g, [it]);
  }
  const out: GameView[] = [];
  for (const [g, xs] of groups) {
    const v = reduce(g, xs, me, waiting);
    if (v) out.push(v);
  }
  const when = (v: GameView) => (v.head.pending ? Number.MAX_SAFE_INTEGER : stamp(v.head.at));
  return out.sort((a, b) => when(a) - when(b) || (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// Scores: worked out on this device from the games still in the chat. Nothing is stored anywhere.

export interface Score { player: string; won: number; lost: number; drawn: number }

/** Wins, losses and draws per person over the finished games (declined and cancelled ones don't count). */
export function tally(views: GameView[]): Score[] {
  const by = new Map<string, Score>();
  const of = (p: string) => { let s = by.get(p); if (!s) { s = { player: p, won: 0, lost: 0, drawn: 0 }; by.set(p, s); } return s; };
  for (const v of views) {
    const m = v.match;
    if (m.status !== 'over' || !m.result) continue;
    m.players.forEach((p, seat) => {
      if (m.result!.winner === null) of(p).drawn++;
      else if (m.result!.winner === seat) of(p).won++;
      else of(p).lost++;
    });
  }
  return [...by.values()].sort((a, b) => b.won - a.won || a.lost - b.lost || (a.player < b.player ? -1 : 1));
}
