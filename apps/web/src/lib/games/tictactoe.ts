// Tic-tac-toe: 3 × 3, three in a row wins, a full board is a draw. Cells are numbered 0–8 row by row from
// the top left; '0' is the first player's mark (X), '1' the second player's (O).
import { findLine, isBoard, isInt, isObj, setAt, type GameEngine, type Outcome } from './types';

export interface TttState { b: string; t: 0 | 1 }
export interface TttMove { c: number }

export const tttLine = (s: TttState): number[] | null => findLine(s.b, 3, 3, 3);

function outcome(s: TttState): Outcome | null {
  const line = tttLine(s);
  if (line) return { winner: Number(s.b[line[0]!]), why: 'line' };
  return s.b.includes('.') ? null : { winner: null, why: 'full' };
}

export const tictactoe: GameEngine<TttState, TttMove> = {
  kind: 'tictactoe',
  players: { min: 2, max: 2 },
  init: () => ({ b: '.........', t: 0 }),
  parse(x) {
    if (!isObj(x) || !isBoard(x.b, 9, '.01') || (x.t !== 0 && x.t !== 1)) return null;
    return { b: x.b, t: x.t };
  },
  parseMove: (x) => (isObj(x) && isInt(x.c, 0, 8) ? { c: x.c } : null),
  turn: (s) => (outcome(s) ? null : s.t),
  moves(s) {
    if (outcome(s)) return [];
    const out: TttMove[] = [];
    for (let c = 0; c < 9; c++) if (s.b[c] === '.') out.push({ c });
    return out;
  },
  play(s, m) {
    if (outcome(s) || s.b[m.c] !== '.') return null;
    return { b: setAt(s.b, m.c, String(s.t)), t: s.t === 0 ? 1 : 0 };
  },
  outcome,
};
