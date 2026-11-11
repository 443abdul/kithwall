// Test helper (used by the *.test.ts files here only): a pretend chat. Messages get an id and a server
// time when they are "stored", and every player has their own dice secrets, exactly as in the app.
import { deriveGameKey, diceSecret } from '@kithwall/crypto';
import { inviteEvent, nextEvent, type Action, type ClockSpec, type GameEvent, type Head, type Secrets } from './match';
import { buildGames, type GameItem, type GameView } from './thread';
import type { GameKind } from './types';

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ANN = uid(1), BEN = uid(2), CAT = uid(3), DAN = uid(4), EVE = uid(5);

const keys = new Map<string, Uint8Array>();
/** A player's dice secrets for one game, derived from a per-player key like the app derives them. */
export function secretsOf(user: string, game: string): Secrets {
  let key = keys.get(user);
  if (!key) { key = deriveGameKey(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + user.charCodeAt(user.length - 1)) & 255)); keys.set(user, key); }
  return (seq) => diceSecret(key!, game, seq);
}

let counter = 100;
export const newId = () => uid(++counter);

export class Chat {
  rows: GameItem[] = [];
  now = Date.parse('2026-11-11T10:00:00.000Z');

  /** Store a message `ms` after the previous one. */
  store(sender: string, ev: GameEvent, ms = 1000, id = newId()): GameItem {
    this.now += ms;
    const item: GameItem = { id, sender, at: new Date(this.now).toISOString(), edited: false, ev };
    this.rows.push(item);
    return item;
  }

  view(me: string | null, game?: string): GameView {
    const all = buildGames(this.rows, me);
    const v = game ? all.find((x) => x.id === game) : all[all.length - 1];
    if (!v) throw new Error('no game');
    return v;
  }

  invite(by: string, kind: GameKind, players: string[], clock: ClockSpec | null = null, from: string | null = null): string {
    const id = newId();
    const ev = inviteEvent(id, { kind, players, by, clock, from }, secretsOf(by, id));
    if (!ev) throw new Error('bad invite');
    this.store(by, ev, 1000, id);
    return id;
  }

  /** What `sender`'s device would send next in `game` (not stored yet). */
  compose(sender: string, game: string, a: Action, at = this.now + 1000): GameEvent {
    const head = this.view(sender, game).head;
    const res = nextEvent(head, sender, a, secretsOf(sender, game), at);
    if (!res.ok) throw new Error(`refused: ${res.why}`);
    return res.ev;
  }

  /** Compose and store. */
  act(sender: string, game: string, a: Action, ms = 1000): GameItem {
    return this.store(sender, this.compose(sender, game, a, this.now + ms), ms);
  }

  /** Compose on top of a head already at hand and store (saves working the game out again). */
  actOn(head: Head, sender: string, a: Action, ms = 1000): GameItem {
    const res = nextEvent(head, sender, a, secretsOf(sender, head.ev.g), this.now + ms);
    if (!res.ok) throw new Error(`refused: ${res.why}`);
    return this.store(sender, res.ev, ms);
  }

  move(sender: string, game: string, m: unknown, ms = 1000): GameItem {
    return this.act(sender, game, { t: 'move', m }, ms);
  }
}
