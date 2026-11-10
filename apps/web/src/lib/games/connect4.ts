// Connect Four: 7 columns × 6 rows. A disc falls to the lowest empty cell of its column; four in a row
// (across, down or diagonally) wins; a full board is a draw. Cells are numbered row by row from the top
// left (row 0 is the top row); '0' is the first player's disc, '1' the second player's.
import { findLine, isBoard, isInt, isObj, setAt, type GameEngine, type Outcome } from './types';

export const C4_COLS = 7;
export const C4_ROWS = 6;

export interface C4State { b: string; t: 0 | 1; last: number }
export interface C4Move { c: number }

export const c4Line = (s: C4State): number[] | null => findLine(s.b, C4_ROWS, C4_COLS, 4);

/** The cell a disc dropped into this column lands in, or -1 when the column is full. */
export function c4Landing(b: string, col: number): number {
  for (let r = C4_ROWS - 1; r >= 0; r--) if (b[r * C4_COLS + col] === '.') return r * C4_COLS + col;
  return -1;
}

function outcome(s: C4State): Outcome | null {
  const line = c4Line(s);
  if (line) return { winner: Number(s.b[line[0]!]), why: 'line' };
  return s.b.includes('.') ? null : { winner: null, why: 'full' };
}

export const connect4: GameEngine<C4State, C4Move> = {
  kind: 'connect4',
  players: { min: 2, max: 2 },
  init: () => ({ b: '.'.repeat(C4_COLS * C4_ROWS), t: 0, last: -1 }),
  parse(x) {
    if (!isObj(x) || !isBoard(x.b, C4_COLS * C4_ROWS, '.01') || (x.t !== 0 && x.t !== 1) || !isInt(x.last, -1, C4_COLS * C4_ROWS - 1)) return null;
    // No disc may float above an empty cell.
    for (let i = 0; i < C4_COLS * (C4_ROWS - 1); i++) if (x.b[i] !== '.' && x.b[i + C4_COLS] === '.') return null;
    return { b: x.b, t: x.t, last: x.last };
  },
  parseMove: (x) => (isObj(x) && isInt(x.c, 0, C4_COLS - 1) ? { c: x.c } : null),
  turn: (s) => (outcome(s) ? null : s.t),
  moves(s) {
    if (outcome(s)) return [];
    const out: C4Move[] = [];
    for (let c = 0; c < C4_COLS; c++) if (s.b[c] === '.') out.push({ c });
    return out;
  },
  play(s, m) {
    if (outcome(s)) return null;
    const at = c4Landing(s.b, m.c);
    if (at < 0) return null;
    return { b: setAt(s.b, at, String(s.t)), t: s.t === 0 ? 1 : 0, last: at };
  },
  outcome,
};
