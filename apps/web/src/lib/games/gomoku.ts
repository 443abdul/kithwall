// Gomoku (five in a row), freestyle rules: 15 × 15, players take turns placing a stone on any empty point,
// and the first with five or more of their stones in an unbroken line (across, down or diagonally) wins.
// A full board without a line is a draw. Cells are numbered row by row from the top left; '0' is the first
// player's stone (dark), '1' the second player's.
import { findLine, isBoard, isInt, isObj, setAt, type GameEngine, type Outcome } from './types';

export const GOMOKU_SIZE = 15;
const CELLS = GOMOKU_SIZE * GOMOKU_SIZE;

export interface GomokuState { b: string; t: 0 | 1; last: number }
export interface GomokuMove { c: number }

export const gomokuLine = (s: GomokuState): number[] | null => findLine(s.b, GOMOKU_SIZE, GOMOKU_SIZE, 5);

function outcome(s: GomokuState): Outcome | null {
  const line = gomokuLine(s);
  if (line) return { winner: Number(s.b[line[0]!]), why: 'line' };
  return s.b.includes('.') ? null : { winner: null, why: 'full' };
}

export const gomoku: GameEngine<GomokuState, GomokuMove> = {
  kind: 'gomoku',
  players: { min: 2, max: 2 },
  init: () => ({ b: '.'.repeat(CELLS), t: 0, last: -1 }),
  parse(x) {
    if (!isObj(x) || !isBoard(x.b, CELLS, '.01') || (x.t !== 0 && x.t !== 1) || !isInt(x.last, -1, CELLS - 1)) return null;
    return { b: x.b, t: x.t, last: x.last };
  },
  parseMove: (x) => (isObj(x) && isInt(x.c, 0, CELLS - 1) ? { c: x.c } : null),
  turn: (s) => (outcome(s) ? null : s.t),
  moves(s) {
    if (outcome(s)) return [];
    const out: GomokuMove[] = [];
    for (let c = 0; c < CELLS; c++) if (s.b[c] === '.') out.push({ c });
    return out;
  },
  play(s, m) {
    if (outcome(s) || s.b[m.c] !== '.') return null;
    return { b: setAt(s.b, m.c, String(s.t)), t: s.t === 0 ? 1 : 0, last: m.c };
  },
  outcome,
};
