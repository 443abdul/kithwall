// The games Kithwall knows, in the order the "Play a game" picker shows them. Adding a game is one engine
// module (lib/games/<name>.ts), one line here, and one board component (components/games/boards.tsx).
import type { GameEngine, GameKind } from './types';
import { tictactoe } from './tictactoe';
import { chess } from './chess';
import { checkers } from './checkers';
import { connect4 } from './connect4';
import { reversi } from './reversi';
import { ludo } from './ludo';
import { gomoku } from './gomoku';
import { dots } from './dots';
import { mancala } from './mancala';

const ENGINES = { tictactoe, chess, checkers, connect4, reversi, ludo, gomoku, dots, mancala } satisfies Record<GameKind, unknown>;

export const GAME_KINDS = Object.keys(ENGINES) as GameKind[];

export const isGameKind = (x: unknown): x is GameKind => typeof x === 'string' && Object.prototype.hasOwnProperty.call(ENGINES, x);

/** The engine for a kind of game; throws for a kind this app doesn't know. */
export function engineOf(kind: GameKind): GameEngine {
  if (!isGameKind(kind)) throw new Error('unknown game');
  return ENGINES[kind] as unknown as GameEngine;
}
