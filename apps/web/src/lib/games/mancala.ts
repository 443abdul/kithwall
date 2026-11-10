// Mancala, the Kalah rules with six pits a side and four seeds in each:
//   - On your turn, pick up all the seeds of one of your pits and sow them one by one into the following
//     pits, anticlockwise, including your own store but skipping the other player's store.
//   - If the last seed lands in your store, you move again.
//   - If the last seed lands in an empty pit on your side and the pit opposite holds seeds, you capture
//     that seed and everything in the opposite pit into your store.
//   - When all six pits on one side are empty the game ends; the seeds left on the other side go to that
//     side's owner. The player with more seeds in their store wins; 24 each is a draw.
//
// The board is 14 numbers: 0–5 the first player's pits (from their left to their right), 6 their store,
// 7–12 the second player's pits (from their left to their right), 13 their store. Sowing goes up the
// numbers. A move names one of the mover's own pits, 0–5 from their left.
import { isInt, isObj, type GameEngine, type Outcome } from './types';

export const MANCALA_SEEDS = 48;

export interface MancalaState {
  p: number[]; t: 0 | 1;
  /** The pit (0–13) the last move was sown from, -1 before the first. */
  last: number;
  /** True when the last seed landed in the mover's store, so the same player moves again. */
  again: boolean;
}
export interface MancalaMove { i: number }

const store = (side: 0 | 1) => (side === 0 ? 6 : 13);
const sideEmpty = (p: number[], side: 0 | 1) => p.slice(side * 7, side * 7 + 6).every((n) => n === 0);
const over = (s: MancalaState) => sideEmpty(s.p, 0) || sideEmpty(s.p, 1);

function outcome(s: MancalaState): Outcome | null {
  if (!over(s)) return null;
  const a = s.p[6]!, b = s.p[13]!;
  return { winner: a === b ? null : a > b ? 0 : 1, why: 'count' };
}

export const mancala: GameEngine<MancalaState, MancalaMove> = {
  kind: 'mancala',
  players: { min: 2, max: 2 },
  init: () => ({ p: [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0], t: 0, last: -1, again: false }),
  parse(x) {
    if (!isObj(x) || !Array.isArray(x.p) || x.p.length !== 14 || !x.p.every((n) => isInt(n, 0, MANCALA_SEEDS))) return null;
    if ((x.p as number[]).reduce((a, n) => a + n, 0) !== MANCALA_SEEDS) return null;
    if ((x.t !== 0 && x.t !== 1) || !isInt(x.last, -1, 13) || typeof x.again !== 'boolean') return null;
    return { p: [...(x.p as number[])], t: x.t, last: x.last, again: x.again };
  },
  parseMove: (x) => (isObj(x) && isInt(x.i, 0, 5) ? { i: x.i } : null),
  turn: (s) => (over(s) ? null : s.t),
  moves(s) {
    if (over(s)) return [];
    const out: MancalaMove[] = [];
    for (let i = 0; i < 6; i++) if (s.p[s.t * 7 + i]! > 0) out.push({ i });
    return out;
  },
  play(s, m) {
    if (over(s)) return null;
    const from = s.t * 7 + m.i;
    let seeds = s.p[from]!;
    if (!seeds) return null;
    const p = [...s.p];
    p[from] = 0;
    const mine = store(s.t), theirs = store(s.t === 0 ? 1 : 0);
    let at = from;
    while (seeds > 0) {
      at = (at + 1) % 14;
      if (at === theirs) continue;
      p[at]! += 1;
      seeds--;
    }
    const again = at === mine;
    // Capture: the last seed made a pit of mine hold exactly one, and the pit opposite has seeds.
    if (!again && Math.floor(at / 7) === s.t && p[at] === 1 && p[12 - at]! > 0) {
      p[mine]! += p[12 - at]! + 1;
      p[at] = 0; p[12 - at] = 0;
    }
    // One side is empty: what is left on the other side goes to its owner.
    if (sideEmpty(p, 0) || sideEmpty(p, 1)) {
      for (const side of [0, 1] as const) {
        for (let i = side * 7; i < side * 7 + 6; i++) { p[store(side)]! += p[i]!; p[i] = 0; }
      }
    }
    return { p, t: again ? s.t : s.t === 0 ? 1 : 0, last: from, again };
  },
  outcome,
};
