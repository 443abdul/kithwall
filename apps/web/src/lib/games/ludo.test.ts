// Ludo rules, with the rolls given by the test (the dice protocol is tested in match.test.ts).
import { describe, expect, it } from 'vitest';
import { ludo, ludoSquare, LUDO_HOME, LUDO_SAFE, type LudoState } from './ludo';

const st = (over: Partial<LudoState> & { tok: number[][] }): LudoState => ({ n: over.tok.length, t: 0, six: 0, out: [], last: null, ...over });
const yard = [-1, -1, -1, -1];

describe('ludo', () => {
  it('needs a six to leave the yard; without a move the turn passes', () => {
    const s = ludo.init(3);
    for (const roll of [1, 2, 3, 4, 5]) {
      expect(ludo.moves(s, roll)).toEqual([{ k: -1 }]);
      expect(ludo.play(s, { k: 0 }, roll)).toBeNull();
      expect(ludo.play(s, { k: -1 }, roll)!.t).toBe(1);
    }
    expect(ludo.moves(s, 6)).toEqual([{ k: 0 }, { k: 1 }, { k: 2 }, { k: 3 }]);
    expect(ludo.play(s, { k: -1 }, 6)).toBeNull(); // a piece can move, so one must
    const out = ludo.play(s, { k: 2 }, 6)!;
    expect(out.tok[0]).toEqual([-1, -1, 0, -1]);
    expect(out.last).toEqual({ s: 0, r: 6, k: 2, hit: [] });
  });

  it('a six rolls again; the third six in a row moves nothing and passes the turn', () => {
    let s = ludo.play(ludo.init(2), { k: 0 }, 6)!;
    expect([s.t, s.six]).toEqual([0, 1]);
    s = ludo.play(s, { k: 0 }, 6)!;
    expect([s.t, s.six]).toEqual([0, 2]);
    expect(s.tok[0]![0]).toBe(6);
    expect(ludo.moves(s, 6)).toEqual([{ k: -1 }]);
    expect(ludo.play(s, { k: 0 }, 6)).toBeNull();
    const forfeited = ludo.play(s, { k: -1 }, 6)!;
    expect(forfeited.tok[0]![0]).toBe(6);
    expect([forfeited.t, forfeited.six]).toEqual([1, 0]);
    // Any other third roll is played normally.
    const normal = ludo.play(s, { k: 0 }, 3)!;
    expect(normal.tok[0]![0]).toBe(9);
    expect([normal.t, normal.six]).toEqual([1, 0]);
  });

  it('a six with no possible move still rolls again', () => {
    const s = st({ tok: [[LUDO_HOME, LUDO_HOME, LUDO_HOME, 53], yard] });
    expect(ludo.moves(s, 6)).toEqual([{ k: -1 }]);
    const next = ludo.play(s, { k: -1 }, 6)!;
    expect([next.t, next.six]).toEqual([0, 1]);
  });

  it('seats sit on corners; two players sit opposite', () => {
    expect([0, 1, 2, 3].map((seat) => ludoSquare(4, seat, 0))).toEqual([0, 13, 26, 39]);
    expect([0, 1].map((seat) => ludoSquare(2, seat, 0))).toEqual([0, 26]);
    expect(ludoSquare(4, 1, 50)).toBe(11); // the last shared square before the home column
  });

  it('landing on a single piece of another player sends it home', () => {
    // With two players seat 1 sits on the opposite corner (start square 26): put its piece where seat 0 lands.
    const two = st({ tok: [[10, -1, -1, -1], [40, -1, -1, -1]] }); // 26 + 40 = 66 → square 14
    expect(ludoSquare(2, 1, 40)).toBe(14);
    const hit = ludo.play(two, { k: 0 }, 4)!;
    expect(hit.tok[1]![0]).toBe(-1);
    expect(hit.last!.hit).toEqual([4]);
    expect(hit.t).toBe(1); // no extra turn for a capture in these rules
  });

  it('no capture on start and star squares, nor of two pieces together', () => {
    // Square 8 is a star: seat 1's piece there (position 34 with two players) is safe.
    expect(LUDO_SAFE).toContain(8);
    expect(ludoSquare(2, 1, 34)).toBe(8);
    const star = ludo.play(st({ tok: [[5, -1, -1, -1], [34, -1, -1, -1]] }), { k: 0 }, 3)!;
    expect(star.tok[1]![0]).toBe(34);
    expect(star.last!.hit).toEqual([]);
    // Two together on an ordinary square are safe.
    const pair = ludo.play(st({ tok: [[10, -1, -1, -1], [40, 40, -1, -1]] }), { k: 0 }, 4)!;
    expect(pair.tok[1]).toEqual([40, 40, -1, -1]);
    // A piece leaving the yard doesn't capture on its own start square.
    const start = ludo.play(st({ tok: [yard, [26, -1, -1, -1]] }), { k: 0 }, 6)!;
    expect(start.tok[1]![0]).toBe(26);
    // Pieces in a home column can't be reached by anyone else.
    const column = ludo.play(st({ tok: [[49, -1, -1, -1], [52, -1, -1, -1]] }), { k: 0 }, 3)!;
    expect(column.tok).toEqual([[52, -1, -1, -1], [52, -1, -1, -1]]);
  });

  it('with three or four players, single pieces of several players on one square all go home', () => {
    const s = st({ tok: [[10, -1, -1, -1], [1, -1, -1, -1], [40, -1, -1, -1], [27, 27, -1, -1]] });
    expect([ludoSquare(4, 1, 1), ludoSquare(4, 2, 40), ludoSquare(4, 3, 27)]).toEqual([14, 14, 14]);
    const hit = ludo.play(s, { k: 0 }, 4)!;
    expect(hit.tok[1]![0]).toBe(-1);
    expect(hit.tok[2]![0]).toBe(-1);
    expect(hit.tok[3]).toEqual([27, 27, -1, -1]); // the pair stays
    expect(hit.last!.hit).toEqual([4, 8]);
  });

  it('home needs the exact roll', () => {
    const s = st({ tok: [[53, 50, -1, -1], yard] });
    expect(ludo.moves(s, 4)).toEqual([{ k: 1 }]); // 53 + 4 overshoots
    expect(ludo.moves(s, 3)).toEqual([{ k: 0 }, { k: 1 }]);
    expect(ludo.play(s, { k: 0 }, 3)!.tok[0]![0]).toBe(LUDO_HOME);
    expect(ludo.play(s, { k: 0 }, 4)).toBeNull();
    // A piece that is home never moves again.
    expect(ludo.moves(st({ tok: [[LUDO_HOME, 50, -1, -1], yard] }), 2)).toEqual([{ k: 1 }]);
  });

  it('the first player with all four home wins and the game ends', () => {
    const s = st({ tok: [[LUDO_HOME, LUDO_HOME, LUDO_HOME, 55], [3, 4, 5, 6]] });
    const won = ludo.play(s, { k: 3 }, 1)!;
    expect(ludo.outcome(won)).toEqual({ winner: 0, why: 'home' });
    expect(ludo.turn(won)).toBeNull();
    expect(ludo.moves(won, 3)).toEqual([]);
    expect(ludo.play(won, { k: 0 }, 3)).toBeNull();
  });

  it('a player who leaves is skipped; the last one left wins', () => {
    let s = st({ tok: [[3, -1, -1, -1], [4, -1, -1, -1], [5, -1, -1, -1]], t: 1, six: 1 });
    s = ludo.drop!(s, 1);
    expect(s.out).toEqual([1]);
    expect(s.tok[1]).toEqual(yard);
    expect([s.t, s.six]).toEqual([2, 0]);
    expect(ludo.play(s, { k: 0 }, 2)!.t).toBe(0); // seat 1 is skipped from now on
    expect(ludo.outcome(s)).toBeNull();
    s = ludo.drop!(s, 2);
    expect(ludo.outcome(s)).toEqual({ winner: 0, why: 'left' });
    // A piece that left can't be captured or counted.
    expect(ludo.parse(JSON.parse(JSON.stringify(s)), 3)).toEqual(s);
  });

  it('refuses rolls and states that are not real', () => {
    const s = ludo.init(2);
    expect(ludo.moves(s, 0)).toEqual([]);
    expect(ludo.moves(s, 7)).toEqual([]);
    expect(ludo.moves(s)).toEqual([]);
    expect(ludo.play(s, { k: 0 }, 7)).toBeNull();
    expect(ludo.parse({ ...s, tok: [[57, -1, -1, -1], yard] }, 2)).toBeNull();
    expect(ludo.parse({ ...s, tok: [yard] }, 2)).toBeNull();
    expect(ludo.parse({ ...s, t: 2 }, 2)).toBeNull();
    expect(ludo.parse(s, 3)).toBeNull();
    expect(ludo.parse({ ...s, out: [0, 1] }, 2)).toBeNull();
    expect(ludo.parseMove({ k: 4 })).toBeNull();
  });

  it('random games for 2, 3 and 4 players always end with a winner', () => {
    let seed = 12345;
    const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    for (const n of [2, 3, 4]) {
      let s = ludo.init(n);
      let turns = 0;
      for (; !ludo.outcome(s) && turns < 20_000; turns++) {
        const roll = 1 + Math.floor(rand() * 6);
        const ms = ludo.moves(s, roll);
        expect(ms.length).toBeGreaterThan(0);
        s = ludo.play(s, ms[Math.floor(rand() * ms.length)]!, roll)!;
        expect(ludo.parse(JSON.parse(JSON.stringify(s)), n)).toEqual(s);
        expect(s.six).toBeLessThan(3);
      }
      expect(ludo.outcome(s)?.why, `${n} players, ${turns} turns`).toBe('home');
    }
  });
});
