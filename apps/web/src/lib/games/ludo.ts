// Ludo for two to four players, standard rules:
//   - Each player has four pieces that start in their yard. A piece leaves the yard only on a six, onto the
//     player's start square. Pieces move clockwise by the roll: 51 squares of the shared track, then five
//     squares of the player's own home column, then home. Home needs the exact roll.
//   - A six gives another roll. Three sixes in a row forfeit the turn: the third six moves nothing.
//   - Landing on a square that holds exactly one piece of another player captures it (back to its yard).
//     Two or more pieces of one player on a square are safe, and so is every piece on the four start
//     squares and the four star squares. Pieces don't block each other.
//   - If no piece can move with the roll, the turn passes (after a six, the player still rolls again).
//   - If a piece can move, the player must move one.
//   - The first player to bring all four pieces home wins and the game ends.
//
// The roll is never chosen here: lib/games/match.ts derives it from the dice protocol and passes it in.
//
// A piece's position is -1 (yard), 0–50 (steps along the track from the player's own start square),
// 51–55 (home column) or 56 (home). Seats sit on the four corners of the board; with two players they
// take opposite corners. Track squares are numbered 0–51 clockwise from the first corner's start square.
import { isInt, isObj, type GameEngine, type Outcome, type Seat } from './types';

export const LUDO_HOME = 56;
export const LUDO_TRACK = 52;
/** Start squares and star squares: no captures here. */
export const LUDO_SAFE: readonly number[] = [0, 8, 13, 21, 26, 34, 39, 47];

export interface LudoLast {
  /** Who rolled, what, and which piece moved (-1: none). */
  s: Seat; r: number; k: number;
  /** Pieces sent back to their yard, as seat * 4 + piece. */
  hit: number[];
}
export interface LudoState {
  n: number;
  tok: number[][];
  t: Seat;
  /** Sixes the player to move has already rolled in this turn (0–2). */
  six: number;
  /** Seats that left the game (resigned or ran out of time), in ascending order. */
  out: Seat[];
  last: LudoLast | null;
}
export interface LudoMove { k: number }

/** Which corner of the board a seat plays from (two players sit opposite each other). */
export const ludoCorner = (n: number, seat: Seat) => (n === 2 ? seat * 2 : seat);
/** The shared-track square of a piece at position 0–50. */
export const ludoSquare = (n: number, seat: Seat, pos: number) => (13 * ludoCorner(n, seat) + pos) % LUDO_TRACK;

function candidates(s: LudoState, roll: number): number[] {
  if (roll === 6 && s.six >= 2) return []; // third six in a row: nothing moves
  const out: number[] = [];
  s.tok[s.t]!.forEach((pos, k) => {
    if (pos === -1 ? roll === 6 : pos + roll <= LUDO_HOME) out.push(k);
  });
  return out;
}

function nextSeat(s: Pick<LudoState, 'n' | 'out'>, from: Seat): Seat {
  for (let i = 1; i <= s.n; i++) {
    const seat = (from + i) % s.n;
    if (!s.out.includes(seat)) return seat;
  }
  return from;
}

function outcome(s: LudoState): Outcome | null {
  for (let seat = 0; seat < s.n; seat++) {
    if (!s.out.includes(seat) && s.tok[seat]!.every((p) => p === LUDO_HOME)) return { winner: seat, why: 'home' };
  }
  const left = [...Array(s.n).keys()].filter((seat) => !s.out.includes(seat));
  return left.length === 1 ? { winner: left[0]!, why: 'left' } : null;
}

export const ludo: GameEngine<LudoState, LudoMove> = {
  kind: 'ludo',
  players: { min: 2, max: 4 },
  dice: 6,
  init: (n) => ({ n, tok: Array.from({ length: n }, () => [-1, -1, -1, -1]), t: 0, six: 0, out: [], last: null }),
  parse(x, players) {
    if (!isObj(x) || x.n !== players || !isInt(x.n, 2, 4) || !isInt(x.t, 0, x.n - 1) || !isInt(x.six, 0, 2)) return null;
    const n = x.n;
    if (!Array.isArray(x.tok) || x.tok.length !== n) return null;
    const tok: number[][] = [];
    for (const row of x.tok as unknown[]) {
      if (!Array.isArray(row) || row.length !== 4 || !row.every((p) => isInt(p, -1, LUDO_HOME))) return null;
      tok.push([...(row as number[])]);
    }
    if (!Array.isArray(x.out) || x.out.length >= n || !x.out.every((v, i, a) => isInt(v, 0, n - 1) && (i === 0 || (a[i - 1] as number) < (v as number)))) return null;
    const out = [...(x.out as number[])];
    let last: LudoLast | null = null;
    if (x.last !== null) {
      const l = x.last;
      if (!isObj(l) || !isInt(l.s, 0, n - 1) || !isInt(l.r, 1, 6) || !isInt(l.k, -1, 3)) return null;
      if (!Array.isArray(l.hit) || l.hit.length > 3 || !l.hit.every((v) => isInt(v, 0, n * 4 - 1))) return null;
      last = { s: l.s, r: l.r, k: l.k, hit: [...(l.hit as number[])] };
    }
    const s: LudoState = { n, tok, t: x.t, six: x.six, out, last };
    if (out.includes(s.t) && !outcome(s)) return null;
    return s;
  },
  parseMove: (x) => (isObj(x) && isInt(x.k, -1, 3) ? { k: x.k } : null),
  turn: (s) => (outcome(s) ? null : s.t),
  moves(s, roll) {
    if (outcome(s) || !isInt(roll, 1, 6)) return [];
    const ks = candidates(s, roll);
    return ks.length ? ks.map((k) => ({ k })) : [{ k: -1 }];
  },
  play(s, m, roll) {
    if (outcome(s) || !isInt(roll, 1, 6)) return null;
    const ks = candidates(s, roll);
    if (ks.length ? !ks.includes(m.k) : m.k !== -1) return null;
    const tok = s.tok.map((row) => [...row]);
    const hit: number[] = [];
    if (m.k >= 0) {
      const from = tok[s.t]![m.k]!;
      const to = from === -1 ? 0 : from + roll;
      tok[s.t]![m.k] = to;
      if (to <= 50) {
        const square = ludoSquare(s.n, s.t, to);
        if (!LUDO_SAFE.includes(square)) {
          for (let seat = 0; seat < s.n; seat++) {
            if (seat === s.t || s.out.includes(seat)) continue;
            const there = tok[seat]!.map((p, k) => (p >= 0 && p <= 50 && ludoSquare(s.n, seat, p) === square ? k : -1)).filter((k) => k >= 0);
            if (there.length === 1) { tok[seat]![there[0]!] = -1; hit.push(seat * 4 + there[0]!); }
          }
        }
      }
    }
    // A six rolls again, unless it was the third in a row.
    const again = roll === 6 && s.six < 2;
    return {
      n: s.n, tok, out: [...s.out],
      t: again ? s.t : nextSeat(s, s.t),
      six: again ? s.six + 1 : 0,
      last: { s: s.t, r: roll, k: m.k, hit },
    };
  },
  outcome,
  drop(s, seat) {
    if (s.out.includes(seat) || !isInt(seat, 0, s.n - 1)) return s;
    const out = [...s.out, seat].sort((a, b) => a - b);
    const tok = s.tok.map((row, i) => (i === seat ? [-1, -1, -1, -1] : [...row]));
    const mine = s.t === seat;
    return { n: s.n, tok, out, t: mine ? nextSeat({ n: s.n, out }, seat) : s.t, six: mine ? 0 : s.six, last: s.last };
  },
};
