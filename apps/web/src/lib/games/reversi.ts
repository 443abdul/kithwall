// Reversi (Othello): 8 × 8, dark moves first. A move must flip at least one of the other player's discs
// (every straight line of theirs that ends at one of your own discs flips). A player with no legal move
// passes automatically; when neither player can move the game ends and the player with more discs wins.
// Cells are numbered row by row from the top left; '0' is dark (first player), '1' is light.
import { isBoard, isInt, isObj, type GameEngine, type Outcome } from './types';

export interface ReversiState {
  b: string; t: 0 | 1;
  /** The last disc placed (-1 before the first move). */
  last: number;
  /** True when the other player had no move after the last disc, so the same player moves again. */
  passed: boolean;
}
export interface ReversiMove { c: number }

const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]] as const;

/** The discs a move at `c` by `side` would flip (empty when the move isn't legal). */
export function reversiFlips(b: string, c: number, side: 0 | 1): number[] {
  if (b[c] !== '.') return [];
  const mine = String(side), theirs = String(1 - side);
  const r0 = Math.floor(c / 8), c0 = c % 8;
  const out: number[] = [];
  for (const [dr, dc] of DIRS) {
    const run: number[] = [];
    let r = r0 + dr, cc = c0 + dc;
    while (r >= 0 && r < 8 && cc >= 0 && cc < 8 && b[r * 8 + cc] === theirs) { run.push(r * 8 + cc); r += dr; cc += dc; }
    if (run.length && r >= 0 && r < 8 && cc >= 0 && cc < 8 && b[r * 8 + cc] === mine) out.push(...run);
  }
  return out;
}

function movesFor(b: string, side: 0 | 1): ReversiMove[] {
  const out: ReversiMove[] = [];
  for (let c = 0; c < 64; c++) if (reversiFlips(b, c, side).length) out.push({ c });
  return out;
}

export function reversiCount(b: string): [number, number] {
  let d = 0, l = 0;
  for (const ch of b) { if (ch === '0') d++; else if (ch === '1') l++; }
  return [d, l];
}

const over = (s: ReversiState) => movesFor(s.b, s.t).length === 0;

function outcome(s: ReversiState): Outcome | null {
  if (!over(s)) return null;
  const [d, l] = reversiCount(s.b);
  return { winner: d === l ? null : d > l ? 0 : 1, why: 'count' };
}

const START = (() => {
  const cells = Array<string>(64).fill('.');
  cells[27] = '1'; cells[36] = '1'; cells[28] = '0'; cells[35] = '0';
  return cells.join('');
})();

export const reversi: GameEngine<ReversiState, ReversiMove> = {
  kind: 'reversi',
  players: { min: 2, max: 2 },
  init: () => ({ b: START, t: 0, last: -1, passed: false }),
  parse(x) {
    if (!isObj(x) || !isBoard(x.b, 64, '.01') || (x.t !== 0 && x.t !== 1) || !isInt(x.last, -1, 63) || typeof x.passed !== 'boolean') return null;
    return { b: x.b, t: x.t, last: x.last, passed: x.passed };
  },
  parseMove: (x) => (isObj(x) && isInt(x.c, 0, 63) ? { c: x.c } : null),
  turn: (s) => (over(s) ? null : s.t),
  moves: (s) => movesFor(s.b, s.t),
  play(s, m) {
    const flips = reversiFlips(s.b, m.c, s.t);
    if (!flips.length) return null;
    const cells = [...s.b];
    cells[m.c] = String(s.t);
    for (const f of flips) cells[f] = String(s.t);
    const b = cells.join('');
    const other = (1 - s.t) as 0 | 1;
    // The other player moves next if they can; otherwise they pass and the same player goes again (if neither
    // can move, the game is over and whose "turn" it is no longer matters).
    const otherCan = movesFor(b, other).length > 0;
    return { b, t: otherCan ? other : s.t, last: m.c, passed: !otherCan && movesFor(b, s.t).length > 0 };
  },
  outcome,
};
