// Rule engines other than chess and Ludo: known move counts, the edge cases of each rule set, sample games,
// and (for all of them) random games that must always stay well-formed and come to an end.
import { describe, expect, it } from 'vitest';
import type { GameEngine } from './types';
import { GAME_KINDS, engineOf } from './registry';
import { tictactoe, tttLine, type TttState } from './tictactoe';
import { connect4, c4Line, type C4State } from './connect4';
import { reversi, reversiCount, type ReversiState } from './reversi';
import { checkers, CHECKERS_QUIET_LIMIT, type CheckersState } from './checkers';
import { gomoku, type GomokuState } from './gomoku';
import { dots, dotsScore, dotsSides, type DotsState } from './dots';
import { mancala, type MancalaState } from './mancala';

function perft<S, M>(e: GameEngine<S, M>, s: S, depth: number): number {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of e.moves(s)) n += perft(e, e.play(s, m)!, depth - 1);
  return n;
}
/** Number of complete games from a position. */
function games<S, M>(e: GameEngine<S, M>, s: S): number {
  const ms = e.moves(s);
  if (!ms.length) return 1;
  let n = 0;
  for (const m of ms) n += games(e, e.play(s, m)!);
  return n;
}
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const playCells = <S>(e: GameEngine<S, { c: number }>, s: S, cells: number[]): S => cells.reduce((st, c) => {
  const next = e.play(st, { c });
  if (!next) throw new Error(`illegal ${c}`);
  return next;
}, s);
/** Rows of a board picture, top row first, without spaces. */
const pic = (...rows: string[]) => rows.join('').replace(/\s/g, '');

describe('tic-tac-toe', () => {
  it('has 255,168 possible games', () => {
    expect(games(tictactoe, tictactoe.init(2))).toBe(255_168);
  });
  it('three in a row wins; the loser cannot move on', () => {
    const s = playCells(tictactoe, tictactoe.init(2), [4, 0, 2, 1, 6]);
    expect(tictactoe.outcome(s)).toEqual({ winner: 0, why: 'line' });
    expect(tttLine(s)).toEqual([2, 4, 6]);
    expect(tictactoe.play(s, { c: 8 })).toBeNull();
  });
  it('a full board is a draw; a taken square is refused', () => {
    const s = playCells(tictactoe, tictactoe.init(2), [0, 1, 2, 4, 3, 5, 7, 6, 8]);
    expect(tictactoe.outcome(s)).toEqual({ winner: null, why: 'full' });
    expect(tictactoe.play(tictactoe.init(2), { c: 9 } as never)).toBeNull();
    expect(tictactoe.play(playCells(tictactoe, tictactoe.init(2), [4]), { c: 4 })).toBeNull();
    expect(tictactoe.parseMove({ c: 9 })).toBeNull();
    expect(tictactoe.parse({ b: '....x....', t: 0 }, 2)).toBeNull();
  });
});

describe('connect four', () => {
  it('move counts', () => {
    expect([1, 2, 3, 4].map((d) => perft(connect4, connect4.init(2), d))).toEqual([7, 49, 343, 2401]);
    expect(perft(connect4, connect4.init(2), 7)).toBe(823_536); // 7^7 minus the seven ways to overfill a column
  }, 60_000);
  it('discs fall, columns fill up', () => {
    let s = connect4.init(2);
    for (let i = 0; i < 6; i++) s = connect4.play(s, { c: 3 })!;
    expect([0, 1, 2, 3, 4, 5].map((r) => s.b[r * 7 + 3]).join('')).toBe('101010');
    expect(connect4.play(s, { c: 3 })).toBeNull();
    expect(connect4.moves(s).map((m) => m.c)).toEqual([0, 1, 2, 4, 5, 6]);
  });
  it('four across, down and on both diagonals', () => {
    const play = (cols: number[]) => cols.reduce<C4State>((st, c) => connect4.play(st, { c })!, connect4.init(2));
    expect(connect4.outcome(play([0, 0, 1, 1, 2, 2, 3]))).toEqual({ winner: 0, why: 'line' });
    expect(connect4.outcome(play([0, 1, 0, 1, 0, 1, 0]))).toEqual({ winner: 0, why: 'line' });
    const rising = play([0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3]);
    expect(connect4.outcome(rising)).toEqual({ winner: 0, why: 'line' });
    expect(c4Line(rising)).toEqual([17, 23, 29, 35]);
    expect(connect4.outcome(play([6, 5, 5, 4, 4, 3, 4, 3, 3, 0, 3]))).toEqual({ winner: 0, why: 'line' });
    expect(connect4.outcome(play([0, 0, 1, 1, 2, 2]))).toBeNull();
  });
  it('a full board without four is a draw; floating discs are not a position', () => {
    // Columns filled in an order that never makes four.
    const order = [0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 2, 3, 2, 3, 2, 3, 3, 2, 3, 2, 3, 2, 4, 5, 4, 5, 4, 5, 5, 4, 5, 4, 5, 4, 6, 6, 6, 6, 6, 6];
    const s = order.reduce<C4State>((st, c) => connect4.play(st, { c })!, connect4.init(2));
    expect(connect4.outcome(s)).toEqual({ winner: null, why: 'full' });
    expect(connect4.parse({ b: '0' + '.'.repeat(41), t: 1, last: 0 }, 2)).toBeNull();
  });
});

describe('reversi', () => {
  it('move counts from the start (4, 12, 56, 244, 1396, 8200)', () => {
    expect([1, 2, 3, 4, 5, 6].map((d) => perft(reversi, reversi.init(2), d))).toEqual([4, 12, 56, 244, 1396, 8200]);
  });
  it('flips every line that is closed off, in all directions', () => {
    const s = reversi.play(reversi.init(2), { c: 19 })!; // d3
    expect(reversiCount(s.b)).toEqual([4, 1]);
    expect(s.b[27]).toBe('0');
    expect(reversi.play(reversi.init(2), { c: 0 })).toBeNull(); // flips nothing
    expect(reversi.play(reversi.init(2), { c: 27 })).toBeNull(); // taken
  });
  it('a player with no move passes automatically', () => {
    // Dark takes b1 from a1. Light's only disc (g8) can't close anything in, so light has no move, while
    // dark still has one (f8): it is dark's turn again.
    const before: ReversiState = { b: pic(
      '. 1 0 . . . . .',
      '. . . . . . . .',
      '. . . . . . . .',
      '. . . . . . . .',
      '. . . . . . . .',
      '. . . . . . . .',
      '. . . . . . . .',
      '. . . . . . 1 0'), t: 0, last: -1, passed: false };
    const after = reversi.play(before, { c: 0 })!; // a1 takes b1
    expect(after.b.slice(0, 3)).toBe('000');
    expect(after.t).toBe(0);
    expect(after.passed).toBe(true);
    expect(reversi.turn(after)).toBe(0);
    expect(reversi.moves(after)).toEqual([{ c: 61 }]);
  });
  it('ends when neither can move; most discs win', () => {
    const wiped: ReversiState = { b: pic(
      '. 1 0 . . . . .',
      '. . . . . . . .', '. . . . . . . .', '. . . . . . . .', '. . . . . . . .', '. . . . . . . .', '. . . . . . . .',
      '. . . . . . . .'), t: 0, last: -1, passed: false };
    const end = reversi.play(wiped, { c: 0 })!;
    expect(reversi.turn(end)).toBeNull();
    expect(reversi.outcome(end)).toEqual({ winner: 0, why: 'count' });
    expect(reversi.outcome({ b: '0'.repeat(32) + '1'.repeat(32), t: 0, last: -1, passed: false })).toEqual({ winner: null, why: 'count' });
  });
});

describe('checkers (English draughts)', () => {
  it('move counts from the start (7, 49, 302, 1469, 7361, 36768)', () => {
    expect([1, 2, 3, 4, 5, 6].map((d) => perft(checkers, checkers.init(2), d))).toEqual([7, 49, 302, 1469, 7361, 36768]);
  }, 60_000);
  const at = (r: number, c: number) => r * 8 + c;
  const pos = (pieces: Record<string, [number, number][]>, t: 0 | 1 = 0, q = 0): CheckersState => {
    const cells = Array<string>(64).fill('.');
    for (const [ch, list] of Object.entries(pieces)) for (const [r, c] of list) cells[at(r, c)] = ch;
    return { b: cells.join(''), t, q, last: [] };
  };
  const paths = (s: CheckersState) => checkers.moves(s).map((m) => m.p.join('-')).sort();

  it('captures are forced', () => {
    const s = pos({ b: [[5, 2], [5, 6]], w: [[4, 3]] });
    expect(paths(s)).toEqual([`${at(5, 2)}-${at(3, 4)}`]);
    expect(checkers.play(s, { p: [at(5, 6), at(4, 5)] })).toBeNull(); // a quiet move while a jump exists
    const after = checkers.play(s, { p: [at(5, 2), at(3, 4)] })!;
    expect(after.b[at(4, 3)]).toBe('.');
    expect(after.b[at(3, 4)]).toBe('b');
  });
  it('a multi-jump must be finished in the same turn, and any capture may be chosen', () => {
    const s = pos({ b: [[7, 0]], w: [[6, 1], [4, 3], [4, 1], [2, 5]] });
    // From a1: over b2 to c3, then either over d4 (and on over f6) or over b4.
    expect(paths(s)).toEqual([
      [at(7, 0), at(5, 2), at(3, 0)].join('-'),
      [at(7, 0), at(5, 2), at(3, 4), at(1, 6)].join('-'),
    ].sort());
    expect(checkers.play(s, { p: [at(7, 0), at(5, 2)] })).toBeNull(); // stopping half-way
    expect(checkers.play(s, { p: [at(7, 0), at(5, 2), at(3, 4)] })).toBeNull();
    const after = checkers.play(s, { p: [at(7, 0), at(5, 2), at(3, 4), at(1, 6)] })!;
    expect([...after.b].filter((ch) => ch === 'w')).toHaveLength(1);
    expect(after.t).toBe(1);
  });
  it('men do not capture backwards; kings do', () => {
    expect(paths(pos({ b: [[3, 2]], w: [[4, 3]] }))).toEqual([`${at(3, 2)}-${at(2, 1)}`, `${at(3, 2)}-${at(2, 3)}`].sort());
    expect(paths(pos({ B: [[3, 2]], w: [[4, 3]] }))).toEqual([`${at(3, 2)}-${at(5, 4)}`]);
  });
  it('a man reaching the far row is crowned and stops, even with another jump on', () => {
    const s = pos({ b: [[2, 1]], w: [[1, 2], [1, 4]] });
    expect(paths(s)).toEqual([`${at(2, 1)}-${at(0, 3)}`]);
    const after = checkers.play(s, { p: [at(2, 1), at(0, 3)] })!;
    expect(after.b[at(0, 3)]).toBe('B');
    expect(after.b[at(1, 4)]).toBe('w'); // not taken: the turn ended with the crowning
    expect(after.t).toBe(1);
    const step = checkers.play(pos({ w: [[6, 1]], b: [[0, 7]] }, 1), { p: [at(6, 1), at(7, 0)] })!;
    expect(step.b[at(7, 0)]).toBe('W');
  });
  it('kings move one square in every direction, and can jump round in a circle', () => {
    expect(checkers.moves(pos({ B: [[4, 3]], w: [[0, 1]] }))).toHaveLength(4);
    const ring = pos({ B: [[5, 2]], w: [[4, 3], [2, 3], [2, 1], [4, 1], [0, 7]] });
    const round = paths(ring).filter((p) => p.split('-').length === 5);
    expect(round).toHaveLength(2); // clockwise and anticlockwise, both ending where they began
    const after = checkers.play(ring, { p: round[0]!.split('-').map(Number) })!;
    expect(after.b[at(5, 2)]).toBe('B');
    expect([...after.b].filter((ch) => ch === 'w')).toHaveLength(1);
  });
  it('no legal move loses: no pieces left, or all blocked', () => {
    const last = checkers.play(pos({ b: [[5, 2]], w: [[4, 3]] }), { p: [at(5, 2), at(3, 4)] })!;
    expect(checkers.outcome(last)).toEqual({ winner: 0, why: 'blocked' });
    // Dark's only man is stuck behind two light men it can't jump (the squares behind them are taken).
    const blocked = pos({ b: [[7, 0]], w: [[6, 1], [5, 2]] });
    expect(checkers.moves(blocked)).toEqual([]);
    expect(checkers.outcome(blocked)).toEqual({ winner: 1, why: 'blocked' });
  });
  it('forty moves each without a capture or a man move is a draw', () => {
    let s = pos({ B: [[7, 0]], W: [[0, 7]] }, 0, CHECKERS_QUIET_LIMIT - 2);
    s = checkers.play(s, { p: [at(7, 0), at(6, 1)] })!;
    expect(checkers.outcome(s)).toBeNull();
    s = checkers.play(s, { p: [at(0, 7), at(1, 6)] })!;
    expect(checkers.outcome(s)).toEqual({ winner: null, why: 'quiet' });
    // A man move resets the count.
    expect(checkers.play(pos({ b: [[7, 0]], W: [[0, 7]] }, 0, 50), { p: [at(7, 0), at(6, 1)] })!.q).toBe(0);
  });
  it('parse refuses pieces on light squares and too many pieces', () => {
    const ok = checkers.init(2);
    expect(checkers.parse(JSON.parse(JSON.stringify(ok)), 2)).toEqual(ok);
    expect(checkers.parse({ ...ok, b: 'b' + ok.b.slice(1) }, 2)).toBeNull();
    expect(checkers.parse({ ...ok, b: ok.b.slice(0, 33) + 'b' + ok.b.slice(34) }, 2)).toBeNull(); // a thirteenth man
    expect(checkers.parseMove({ p: [1] })).toBeNull();
    expect(checkers.parseMove({ p: [1, 64] })).toBeNull();
  });
});

describe('gomoku', () => {
  const play = (cells: number[]) => cells.reduce<GomokuState>((st, c) => gomoku.play(st, { c })!, gomoku.init(2));
  it('five in a row wins, four does not, six counts too', () => {
    expect(gomoku.outcome(play([0, 15, 1, 16, 2, 17, 3, 18]))).toBeNull();
    expect(gomoku.outcome(play([0, 15, 1, 16, 2, 17, 3, 18, 4]))).toEqual({ winner: 0, why: 'line' });
    // 0-1-2 _ 4-5, then the gap: six in a row.
    expect(gomoku.outcome(play([0, 15, 1, 16, 2, 17, 4, 18, 5, 30, 3]))).toEqual({ winner: 0, why: 'line' });
    // A diagonal for the second player.
    expect(gomoku.outcome(play([1, 0, 2, 16, 3, 32, 5, 48, 6, 64]))).toEqual({ winner: 1, why: 'line' });
  });
  it('lines do not wrap round the edge of the board', () => {
    expect(gomoku.outcome(play([12, 100, 13, 101, 14, 102, 15, 103, 16]))).toBeNull();
  });
});

describe('dots and boxes', () => {
  it('the fourth side wins the box and another turn', () => {
    let s = dots.init(2);
    const [top, bottom, left, right] = dotsSides(0, 0);
    s = dots.play(s, { e: top })!;   // 0
    s = dots.play(s, { e: bottom })!; // 1
    s = dots.play(s, { e: left })!;   // 0
    expect(s.t).toBe(1);
    s = dots.play(s, { e: right })!;  // 1 closes the box
    expect(s.o[0]).toBe('1');
    expect(s.t).toBe(1);
    expect(dots.play(s, { e: right })).toBeNull();
  });
  it('one line can close two boxes', () => {
    let s: DotsState = dots.init(2);
    const a = dotsSides(0, 0), b = dotsSides(0, 1);
    const shared = a[3];
    expect(b[2]).toBe(shared);
    for (const e of [a[0], a[1], a[2], b[0], b[1], b[3]]) s = dots.play(s, { e })!;
    const t = s.t;
    s = dots.play(s, { e: shared })!;
    expect(dotsScore(s.o)).toEqual(t === 0 ? [2, 0] : [0, 2]);
    expect(s.t).toBe(t);
  });
  it('parse checks that owned boxes are exactly the closed ones', () => {
    const s = dots.init(2);
    expect(dots.parse({ ...s, o: '0' + s.o.slice(1) }, 2)).toBeNull();
  });
});

describe('mancala (Kalah)', () => {
  it('sows anticlockwise, skipping the other store; last seed in the own store moves again', () => {
    const s = mancala.play(mancala.init(2), { i: 2 })!;
    expect(s.p).toEqual([4, 4, 0, 5, 5, 5, 1, 4, 4, 4, 4, 4, 4, 0]);
    expect(s.t).toBe(0);
    expect(s.again).toBe(true);
    const lap: MancalaState = { p: [1, 1, 1, 0, 0, 10, 0, 3, 4, 4, 4, 3, 3, 14], t: 0, last: -1, again: false };
    // Ten seeds from the last pit: store, six pits opposite, NOT their store, then three of my own.
    const lapped = mancala.play(lap, { i: 5 })!;
    expect(lapped.p).toEqual([2, 2, 2, 0, 0, 0, 1, 4, 5, 5, 5, 4, 4, 14]);
    expect(lapped.t).toBe(1);
  });
  it('captures from an empty own pit when the opposite pit has seeds', () => {
    const s: MancalaState = { p: [1, 0, 3, 3, 3, 3, 0, 3, 3, 3, 3, 9, 3, 11], t: 0, last: -1, again: false };
    const after = mancala.play(s, { i: 0 })!;
    expect(after.p[1]).toBe(0);
    expect(after.p[11]).toBe(0);
    expect(after.p[6]).toBe(10);
    expect(after.t).toBe(1);
    // No capture when the opposite pit is empty.
    const none: MancalaState = { p: [1, 0, 3, 3, 3, 3, 9, 3, 3, 3, 3, 0, 3, 11], t: 0, last: -1, again: false };
    expect(mancala.play(none, { i: 0 })!.p[1]).toBe(1);
    expect(mancala.play(s, { i: 1 })).toBeNull(); // an empty pit
  });
  it('ends when one side is empty; the rest goes to its owner', () => {
    const s: MancalaState = { p: [0, 0, 0, 0, 0, 1, 20, 2, 0, 0, 0, 0, 5, 20], t: 0, last: -1, again: false };
    const end = mancala.play(s, { i: 5 })!;
    expect(end.p).toEqual([0, 0, 0, 0, 0, 0, 21, 0, 0, 0, 0, 0, 0, 27]);
    expect(mancala.turn(end)).toBeNull();
    expect(mancala.outcome(end)).toEqual({ winner: 1, why: 'count' });
    expect(mancala.parse({ ...s, p: [...s.p.slice(0, 13), 21] }, 2)).toBeNull(); // 49 seeds
  });
});

describe('every engine', () => {
  for (const kind of GAME_KINDS) {
    const e = engineOf(kind);
    if (e.dice) continue; // Ludo has its own tests (it needs rolls)
    it(`${kind}: random games stay well-formed and end`, () => {
      const rand = rng(kind.length * 7919);
      for (let g = 0; g < (kind === 'chess' ? 3 : 12); g++) {
        let s = e.init(2);
        let plies = 0;
        for (; plies < 1200; plies++) {
          expect(e.parse(JSON.parse(JSON.stringify(s)), 2), `${kind} round trip`).toEqual(s);
          const ms = e.moves(s);
          const turn = e.turn(s);
          if (!ms.length) { expect(turn).toBeNull(); break; }
          expect(turn === 0 || turn === 1).toBe(true);
          expect(e.outcome(s)).toBeNull();
          const m = ms[Math.floor(rand() * ms.length)]!;
          expect(e.parseMove(JSON.parse(JSON.stringify(m)))).toEqual(m);
          const next = e.play(s, m);
          expect(next).not.toBeNull();
          s = next!;
        }
        expect(e.outcome(s), `${kind} ended after ${plies} plies`).not.toBeNull();
      }
    }, 120_000);
  }
  it('tic-tac-toe states have the same shape on every device', () => {
    const s: TttState = tictactoe.init(2);
    expect(JSON.stringify(s)).toBe('{"b":".........","t":0}');
  });
});
