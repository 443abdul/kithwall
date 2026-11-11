'use client';
// What the app adds to the pure game code (docs/v2/11-games.md): this account's dice secrets, a running
// estimate of the server's clock, and turning the messages of a chat into the items lib/games/thread.ts
// works on.
import { deriveGameKey, diceSecret } from '@kithwall/crypto';
import { amk } from '../keys/session';
import type { ChatPayload } from '../messages';
import type { MessageRow } from '../types';
import { parseEvent, type GameEvent, type Secrets } from './match';
import type { GameItem } from './thread';

/**
 * This account's dice secrets for one game. They are derived from the account's master key each time
 * (never stored), so any of my devices can open a commitment another of them made.
 */
export function secretsFor(game: string): Secrets {
  return (seq) => {
    const key = deriveGameKey(amk());
    try { return diceSecret(key, game, seq); } finally { key.fill(0); }
  };
}

// ---------------------------------------------------------------------------------------------
// The server's clock. Game clocks run on the `created_at` the server gives each move, never on a device's
// own clock. To show a countdown (and to know when "Claim win on time" may be sent) the device needs to
// know roughly what the server's time is now: every stored message it sees says "the server's clock had
// reached at least this when I arrived", so the largest such difference is the best estimate. It never
// runs ahead of the server, so a claim based on it is never early.
let offset: number | null = null;

export function noteServerTime(iso: string | null | undefined): void {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return;
  const o = at - Date.now();
  if (offset === null || o > offset) offset = o;
}

/** The server's time now (ms), as well as this device can tell. */
export const serverNow = (): number => Date.now() + (offset ?? 0);

// ---------------------------------------------------------------------------------------------

export interface GameLine { id: string; sender: string; at: string; row: Pick<MessageRow, 'edited_at'>; payload: ChatPayload | null }

// Decrypted payloads are cached per message (lib/messages.ts), so the check of a game event's shape is done
// once per message, not on every render.
const parsed = new WeakMap<object, GameEvent | 'bad'>();

/** The game event a decrypted message carries: null when it has none, 'bad' when it is malformed. */
export function gameOf(payload: ChatPayload | null | undefined): GameEvent | 'bad' | null {
  if (!payload || payload.game === undefined) return null;
  let ev = parsed.get(payload);
  if (!ev) { ev = parseEvent(payload.game) ?? 'bad'; parsed.set(payload, ev); }
  return ev;
}

/** The game messages among a chat's decrypted messages. */
export function gameItems(lines: GameLine[]): GameItem[] {
  const out: GameItem[] = [];
  for (const l of lines) {
    const ev = gameOf(l.payload);
    if (ev && ev !== 'bad') out.push({ id: l.id, sender: l.sender, at: l.at, edited: !!l.row.edited_at, ev });
  }
  return out;
}
