// Games inside chats (docs/v2/11-games.md): the small interface every game implements. An engine is pure
// and deterministic (no DOM, no clock, no randomness of its own): the same state and move give the same
// next state on every device, which is what lets each device check everyone else's moves.
//
// States and moves are plain JSON (strings, numbers, arrays, plain objects, no undefined), because they
// travel inside encrypted chat messages and are compared as canonical JSON. `parse` and `parseMove` are the
// only way a value from a message enters an engine: they must reject anything malformed.

export type GameKind = 'tictactoe' | 'chess' | 'checkers' | 'connect4' | 'reversi' | 'ludo' | 'gomoku' | 'dots' | 'mancala';

/** A player's place in the game: 0 moves first. */
export type Seat = number;

/** How a game ended: the winning seat (null = draw) and an engine-specific reason ('checkmate', 'line'…). */
export interface Outcome { winner: Seat | null; why: string }

export interface GameEngine<S = unknown, M = unknown> {
  kind: GameKind;
  players: { min: number; max: number };
  /** Sides of the die rolled before every move (Ludo: 6). Absent for games without chance. */
  dice?: number;
  /** The starting position for this many players. */
  init(players: number): S;
  /** A state taken from a message, or null when it isn't a well-formed state of this game. */
  parse(x: unknown, players: number): S | null;
  /** A move taken from a message (shape only; legality is `play`), or null. */
  parseMove(x: unknown): M | null;
  /** Whose turn it is; null when the game is over. */
  turn(s: S): Seat | null;
  /** Every legal move for the player to move (with this roll, for dice games). */
  moves(s: S, roll?: number): M[];
  /** The state after a legal move; null when the move isn't legal here. */
  play(s: S, m: M, roll?: number): S | null;
  /** The result once the game is over, else null. */
  outcome(s: S): Outcome | null;
  /** Dice games: the move to send without asking when the roll leaves nothing to choose (a pass). */
  forced?(moves: M[]): M | null;
  /** Dice games: the last roll and who made it, for showing the die. */
  rolled?(s: S): { seat: Seat; roll: number } | null;
  /** Games for more than two: take a player out (they resigned or ran out of time) and carry on. */
  drop?(s: S, seat: Seat): S;
}

export const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export const isInt = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;

/** A board string: exactly `len` characters, all from `alphabet`. */
export function isBoard(x: unknown, len: number, alphabet: string): x is string {
  if (typeof x !== 'string' || x.length !== len) return false;
  for (const ch of x) if (!alphabet.includes(ch)) return false;
  return true;
}

export const setAt = (b: string, i: number, ch: string) => b.slice(0, i) + ch + b.slice(i + 1);

/** The four line directions on a grid (right, down, down-right, down-left) as [dRow, dCol]. */
const LINES: readonly (readonly [number, number])[] = [[0, 1], [1, 0], [1, 1], [1, -1]];

/**
 * The first run of `need` (or more) equal non-empty cells on a rows × cols board, as cell indexes; null
 * when there is none. Shared by tic-tac-toe, Connect Four and Gomoku.
 */
export function findLine(b: string, rows: number, cols: number, need: number): number[] | null {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = b[r * cols + c]!;
      if (ch === '.') continue;
      for (const [dr, dc] of LINES) {
        // Only start a run at its first cell, so a line of six is reported whole.
        const pr = r - dr, pc = c - dc;
        if (pr >= 0 && pr < rows && pc >= 0 && pc < cols && b[pr * cols + pc] === ch) continue;
        const run: number[] = [];
        for (let rr = r, cc = c; rr >= 0 && rr < rows && cc >= 0 && cc < cols && b[rr * cols + cc] === ch; rr += dr, cc += dc) run.push(rr * cols + cc);
        if (run.length >= need) return run;
      }
    }
  }
  return null;
}
