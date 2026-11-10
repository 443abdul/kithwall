// Dots and Boxes on a grid of 5 × 5 boxes (6 × 6 dots). Players take turns drawing one line between two
// neighbouring dots. Whoever draws the fourth side of a box owns it and must draw again. When every box is
// owned, the player with more boxes wins (25 boxes, so there is no draw).
//
// Lines are numbered: first the horizontal ones row by row (6 rows of 5; line r * 5 + c is the top side of
// box (r, c)), then the vertical ones (5 rows of 6; line 30 + r * 6 + c is the left side of box (r, c)).
// '.' is an undrawn line or an unowned box, '0' / '1' the player who drew or owns it.
import { isBoard, isInt, isObj, setAt, type GameEngine, type Outcome } from './types';

export const DOTS_N = 5;
const H = (DOTS_N + 1) * DOTS_N;
export const DOTS_LINES = 2 * H;
const BOXES = DOTS_N * DOTS_N;

export interface DotsState {
  /** Every line (horizontal ones first), then who owns each box. */
  l: string; o: string; t: 0 | 1;
  /** The last line drawn (-1 before the first). */
  last: number;
}
export interface DotsMove { e: number }

/** The four lines around box (r, c): top, bottom, left, right. */
export function dotsSides(r: number, c: number): [number, number, number, number] {
  return [r * DOTS_N + c, (r + 1) * DOTS_N + c, H + r * (DOTS_N + 1) + c, H + r * (DOTS_N + 1) + c + 1];
}

export function dotsScore(o: string): [number, number] {
  let a = 0, b = 0;
  for (const ch of o) { if (ch === '0') a++; else if (ch === '1') b++; }
  return [a, b];
}

function outcome(s: DotsState): Outcome | null {
  if (s.o.includes('.')) return null;
  const [a, b] = dotsScore(s.o);
  return { winner: a === b ? null : a > b ? 0 : 1, why: 'count' };
}

export const dots: GameEngine<DotsState, DotsMove> = {
  kind: 'dots',
  players: { min: 2, max: 2 },
  init: () => ({ l: '.'.repeat(DOTS_LINES), o: '.'.repeat(BOXES), t: 0, last: -1 }),
  parse(x) {
    if (!isObj(x) || !isBoard(x.l, DOTS_LINES, '.01') || !isBoard(x.o, BOXES, '.01') || (x.t !== 0 && x.t !== 1) || !isInt(x.last, -1, DOTS_LINES - 1)) return null;
    // A box is owned exactly when all four of its sides are drawn.
    for (let r = 0; r < DOTS_N; r++) {
      for (let c = 0; c < DOTS_N; c++) {
        const closed = dotsSides(r, c).every((e) => (x.l as string)[e] !== '.');
        if (closed !== (x.o[r * DOTS_N + c] !== '.')) return null;
      }
    }
    return { l: x.l, o: x.o, t: x.t, last: x.last };
  },
  parseMove: (x) => (isObj(x) && isInt(x.e, 0, DOTS_LINES - 1) ? { e: x.e } : null),
  turn: (s) => (outcome(s) ? null : s.t),
  moves(s) {
    const out: DotsMove[] = [];
    for (let e = 0; e < DOTS_LINES; e++) if (s.l[e] === '.') out.push({ e });
    return out;
  },
  play(s, m) {
    if (s.l[m.e] !== '.') return null;
    const l = setAt(s.l, m.e, String(s.t));
    let o = s.o;
    for (let r = 0; r < DOTS_N; r++) {
      for (let c = 0; c < DOTS_N; c++) {
        const sides = dotsSides(r, c);
        if (o[r * DOTS_N + c] === '.' && sides.includes(m.e) && sides.every((e) => l[e] !== '.')) o = setAt(o, r * DOTS_N + c, String(s.t));
      }
    }
    // Completing a box means drawing again.
    return { l, o, t: o !== s.o ? s.t : s.t === 0 ? 1 : 0, last: m.e };
  },
  outcome,
};
