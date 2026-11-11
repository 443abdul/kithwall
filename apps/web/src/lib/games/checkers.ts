// Checkers: English draughts (American checkers), 8 × 8, twelve men each on the dark squares.
//   - Dark (the first player) moves first. Men move one square diagonally forward.
//   - Captures are forced: if you can jump, you must. A jump goes over an adjacent enemy piece onto the empty
//     square behind it; if the same piece can jump again from there it must carry on in the same turn. With
//     several captures to choose from, any of them may be played (there is no "take the most" rule).
//   - A man that reaches the far row becomes a king and the turn ends there, even if it could jump on.
//   - Kings move and jump one square in all four diagonal directions (no flying kings).
//   - You win when the other player has no legal move (no pieces left, or all blocked).
//   - Draw: 40 moves by each side without a capture or a man moving, or by agreement.
//
// Squares are numbered row by row from the top left (row 0 is the top row). The first player's pieces are
// 'b' (man) and 'B' (king) and start on rows 5–7, moving up; the second player's are 'w' and 'W' on rows
// 0–2, moving down. A move is the path of the piece: [from, to] or [from, landing, landing…] for jumps.
import { isBoard, isInt, isObj, type GameEngine, type Outcome } from './types';

export interface CheckersState {
  b: string; t: 0 | 1;
  /** Plies since the last capture or man move (draw at 80). */
  q: number;
  /** The path of the last move ([] before the first). */
  last: number[];
}
export interface CheckersMove { p: number[] }

export const CHECKERS_QUIET_LIMIT = 80;

const owner = (ch: string): 0 | 1 | null => (ch === 'b' || ch === 'B' ? 0 : ch === 'w' || ch === 'W' ? 1 : null);
const isKing = (ch: string) => ch === 'B' || ch === 'W';
const dirs = (ch: string): readonly (readonly [number, number])[] =>
  isKing(ch) ? [[-1, -1], [-1, 1], [1, -1], [1, 1]] : ch === 'b' ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];
const crownRow = (side: 0 | 1) => (side === 0 ? 0 : 7);

/** Every maximal jump sequence for the piece on `from` (paths include `from`). */
function jumpsFrom(b: string, from: number): number[][] {
  const piece = b[from]!;
  const side = owner(piece)!;
  const out: number[][] = [];
  const walk = (at: number, taken: number[], path: number[]) => {
    let extended = false;
    const r = Math.floor(at / 8), c = at % 8;
    for (const [dr, dc] of dirs(piece)) {
      const mr = r + dr, mc = c + dc, lr = r + 2 * dr, lc = c + 2 * dc;
      if (lr < 0 || lr > 7 || lc < 0 || lc > 7) continue;
      const mid = mr * 8 + mc, land = lr * 8 + lc;
      const victim = owner(b[mid]!);
      if (victim === null || victim === side || taken.includes(mid)) continue;
      // The landing square must be empty; the square the piece started from counts as empty.
      if (b[land] !== '.' && land !== from) continue;
      extended = true;
      // A man that lands on the far row is crowned and stops.
      if (!isKing(piece) && lr === crownRow(side)) out.push([...path, land]);
      else walk(land, [...taken, mid], [...path, land]);
    }
    if (!extended && path.length > 1) out.push(path);
  };
  walk(from, [], [from]);
  return out;
}

function stepsFrom(b: string, from: number): number[][] {
  const piece = b[from]!;
  const r = Math.floor(from / 8), c = from % 8;
  const out: number[][] = [];
  for (const [dr, dc] of dirs(piece)) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7 && b[nr * 8 + nc] === '.') out.push([from, nr * 8 + nc]);
  }
  return out;
}

function movesFor(b: string, side: 0 | 1): CheckersMove[] {
  const jumps: number[][] = [];
  const steps: number[][] = [];
  for (let i = 0; i < 64; i++) {
    if (owner(b[i]!) !== side) continue;
    jumps.push(...jumpsFrom(b, i));
    if (!jumps.length) steps.push(...stepsFrom(b, i));
  }
  return (jumps.length ? jumps : steps).map((p) => ({ p }));
}

/** The squares jumped over by a path (empty for a plain step). */
export function checkersCaptured(path: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, z = path[i]!;
    if (Math.abs(Math.floor(a / 8) - Math.floor(z / 8)) === 2) out.push((a + z) / 2);
  }
  return out;
}

function outcome(s: CheckersState): Outcome | null {
  if (!movesFor(s.b, s.t).length) return { winner: 1 - s.t, why: 'blocked' };
  if (s.q >= CHECKERS_QUIET_LIMIT) return { winner: null, why: 'quiet' };
  return null;
}

const START = (() => {
  const cells = Array<string>(64).fill('.');
  for (let i = 0; i < 64; i++) {
    const r = Math.floor(i / 8);
    if ((r + (i % 8)) % 2 === 1) cells[i] = r < 3 ? 'w' : r > 4 ? 'b' : '.';
  }
  return cells.join('');
})();

export const checkers: GameEngine<CheckersState, CheckersMove> = {
  kind: 'checkers',
  players: { min: 2, max: 2 },
  init: () => ({ b: START, t: 0, q: 0, last: [] }),
  parse(x) {
    if (!isObj(x) || !isBoard(x.b, 64, '.bBwW') || (x.t !== 0 && x.t !== 1) || !isInt(x.q, 0, CHECKERS_QUIET_LIMIT)) return null;
    if (!Array.isArray(x.last) || x.last.length > 13 || !x.last.every((v) => isInt(v, 0, 63))) return null;
    // Pieces live on dark squares only, at most twelve a side.
    let b = 0, w = 0;
    for (let i = 0; i < 64; i++) {
      const o = owner(x.b[i]!);
      if (o === null) continue;
      if ((Math.floor(i / 8) + (i % 8)) % 2 !== 1) return null;
      if (o === 0) b++; else w++;
    }
    if (b > 12 || w > 12) return null;
    return { b: x.b, t: x.t, q: x.q, last: [...(x.last as number[])] };
  },
  parseMove(x) {
    if (!isObj(x) || !Array.isArray(x.p) || x.p.length < 2 || x.p.length > 13 || !x.p.every((v) => isInt(v, 0, 63))) return null;
    return { p: [...(x.p as number[])] };
  },
  turn: (s) => (outcome(s) ? null : s.t),
  moves: (s) => (outcome(s) ? [] : movesFor(s.b, s.t)),
  play(s, m) {
    if (outcome(s)) return null;
    const key = m.p.join(',');
    if (!movesFor(s.b, s.t).some((x) => x.p.join(',') === key)) return null;
    const cells = [...s.b];
    const from = m.p[0]!, to = m.p[m.p.length - 1]!;
    const piece = cells[from]!;
    const taken = checkersCaptured(m.p);
    cells[from] = '.';
    for (const t of taken) cells[t] = '.';
    const crowned = !isKing(piece) && Math.floor(to / 8) === crownRow(s.t);
    cells[to] = crowned ? piece.toUpperCase() : piece;
    return { b: cells.join(''), t: s.t === 0 ? 1 : 0, q: taken.length || !isKing(piece) ? 0 : s.q + 1, last: [...m.p] };
  },
  outcome,
};
