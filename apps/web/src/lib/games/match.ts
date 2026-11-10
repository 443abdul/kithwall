// A game played over chat messages (docs/v2/11-games.md). Every game message is an ordinary end-to-end
// encrypted chat message whose payload carries one GameEvent:
//
//   { v, g, n, p, r, a, s }   g = the game (the id of its invite message)   n = message number in the game
//                             p = hash of the game message before it         r = a fresh public nonce
//                             a = what happened (invite, accept, move…)      s = the whole match afterwards
//
// `step` is the one rule book: given the match before, who sent the message and when the server stored it,
// it returns the match after, or refuses. Every device runs it on every message, so an illegal or
// out-of-turn move from anyone (a changed app included) is refused everywhere the same way. The match `s`
// that the sender wrote into the message must equal what `step` computes; it is only ever *used* by a
// device that can no longer see the messages before it (they disappeared), see lib/games/thread.ts.
//
// Pure: no DOM, no network, no clock of its own. Times are the server's `created_at` of the messages.
import { b64u, canonicalJson, diceCommit, diceOpens, diceRoll, diceSeed, gameLink, newGameNonce } from '@kithwall/crypto';
import { engineOf } from './registry';
import { isInt, isObj, type GameEngine, type GameKind, type Seat } from './types';

/** 'total': each player has this long for the whole game. 'move': this long for every move. */
export interface ClockSpec { k: 'total' | 'move'; ms: number }

/** The clocks people can choose (null = no clock, the default). */
export const CLOCKS: readonly (ClockSpec | null)[] = [
  null, { k: 'total', ms: 60_000 }, { k: 'total', ms: 300_000 }, { k: 'total', ms: 600_000 }, { k: 'move', ms: 86_400_000 },
];
export const MIN_CLOCK_MS = 10_000;
export const MAX_CLOCK_MS = 7 * 86_400_000;
/**
 * Games for more than two without a clock: a player who hasn't moved for this long can be taken out by the
 * others, so one person disappearing can't freeze the game (and the dice) for everyone.
 */
export const IDLE_DROP_MS = 86_400_000;

export interface Result {
  /** The winning seat; null for a draw, a declined or a cancelled game. */
  winner: Seat | null;
  /** The engine's reason ('checkmate', 'line'…) or 'resign', 'time', 'agreed', 'declined', 'cancelled'. */
  why: string;
}

export interface TimeState {
  /** Time left per seat (ms) as of `base`; empty without a 'total' clock. */
  left: number[];
  /** Server time the running turn started: the last move, or the start of the game. Null before the start. */
  base: string | null;
  /** Set by a message that ends a turn: this seat's clock ran from `base` until that message's own time. */
  tick: Seat | null;
}

export interface DiceState {
  /** Each seat's open commitment (null until they have made one) and the message number it was made in. */
  c: (string | null)[];
  cn: number[];
  /** Seed of the rolls of the turn in progress (null between turns) and how many of them are used. */
  seed: string | null;
  k: number;
  /** Hash and number of the newest game message NOT sent by the sender of this one. */
  e: string | null;
  en: number;
}

export interface Match {
  kind: GameKind;
  /** User ids in seat order: seat 0 moves first. */
  players: string[];
  /** Who sent the invite. */
  by: string;
  clock: ClockSpec | null;
  status: 'invited' | 'active' | 'over' | 'cancelled';
  /** Who has accepted so far (the inviter counts as accepted). */
  ok: string[];
  /** The engine's state. */
  state: unknown;
  result: Result | null;
  /** The seat with a draw offer on the table, or null. */
  offer: Seat | null;
  time: TimeState;
  dice: DiceState | null;
  /** Seats that left a game for more than two (resigned or ran out of time). */
  left: Seat[];
  /** The earlier game this one is a rematch of, or null. */
  from: string | null;
  /** Server time of the invite (known from the second message on). */
  t0: string | null;
  /** Moves played. */
  moves: number;
  /** The seat that sent this message. */
  who: Seat;
}

export type Action =
  | { t: 'invite' }
  | { t: 'accept'; c?: string }
  | { t: 'decline' }
  | { t: 'cancel' }
  | { t: 'move'; m: unknown; x?: string; c?: string }
  | { t: 'resign' }
  | { t: 'offer' }
  | { t: 'agree' }
  | { t: 'refuse' }
  | { t: 'claim' };

export interface GameEvent { v: 1; g: string; n: number; p: string; r: string; a: Action; s: Match }

/** What a newly sent game needs: chosen by the inviter. */
export interface NewGame { kind: GameKind; players: string[]; by: string; clock: ClockSpec | null; from?: string | null }

/** The secret behind the commitment made in message number `seq` of this game (lib/games/secrets.ts). */
export type Secrets = (seq: number) => Uint8Array;

export interface StepCtx {
  g: string;
  /** Number of the message being applied. */
  n: number;
  sender: string;
  /** Hash of the game message before this one, and the server time it was stored. */
  link: string;
  prevAt: string;
  /** Server time of this message in ms (an estimate while it is still being sent). */
  at: number;
}

/** 'illegal': not allowed (shown as such). 'early': a claim that came before the time was up (ignored). */
export type StepResult = { ok: true; match: Match } | { ok: false; why: 'illegal' | 'early' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64_32 = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const ILLEGAL: StepResult = { ok: false, why: 'illegal' };

const isTime = (x: unknown): x is string => typeof x === 'string' && x.length <= 40 && Number.isFinite(Date.parse(x));

// ---------------------------------------------------------------------------------------------
// Clocks

/**
 * The clock as of the moment the message that carries match `m` was stored (`at`): the mover's time is
 * taken off, and the next turn starts at `at`.
 */
export function settle(m: Match, at: string): TimeState {
  const t = m.time;
  if (m.status !== 'active') return { left: [...t.left], base: t.base, tick: null };
  if (t.base === null) return { left: [...t.left], base: at, tick: null }; // the game starts with this message
  if (t.tick === null) return { left: [...t.left], base: t.base, tick: null };
  const left = [...t.left];
  if (m.clock?.k === 'total') left[t.tick] = Math.max(0, (left[t.tick] ?? 0) - Math.max(0, Date.parse(at) - Date.parse(t.base)));
  return { left, base: at, tick: null };
}

/** How long a seat may still think before the others can claim: null when no limit applies. */
function limitFor(m: Match, t: TimeState, seat: Seat): number | null {
  if (m.clock?.k === 'total') return t.left[seat] ?? 0;
  if (m.clock?.k === 'move') return m.clock.ms;
  return m.players.length - m.left.length > 2 ? IDLE_DROP_MS : null;
}

/**
 * Time the player to move has left at server time `now` (ms), for the match carried by a message stored
 * at `at`. Null when no limit applies or nobody is to move. Zero or less: the others may claim.
 */
export function timeLeft(m: Match, at: string, now: number): { seat: Seat; ms: number } | null {
  if (m.status !== 'active') return null;
  const seat = engineOf(m.kind).turn(m.state);
  if (seat === null) return null;
  const t = settle(m, at);
  const limit = limitFor(m, t, seat);
  if (limit === null || t.base === null) return null;
  return { seat, ms: limit - (now - Date.parse(t.base)) };
}

// ---------------------------------------------------------------------------------------------
// Starting a game

function blankDice(n: number): DiceState {
  return { c: Array<string | null>(n).fill(null), cn: Array<number>(n).fill(0), seed: null, k: 0, e: null, en: 0 };
}

/** The match an invite carries. `commit` is the inviter's dice commitment (dice games only). */
function invited(g: NewGame, commit: string | null): Match | null {
  const engine = engineOf(g.kind);
  const n = g.players.length;
  if (n < engine.players.min || n > engine.players.max || new Set(g.players).size !== n || !g.players.every((p) => UUID.test(p))) return null;
  const seat = g.players.indexOf(g.by);
  if (seat < 0) return null;
  let dice: DiceState | null = null;
  if (engine.dice) {
    // The inviter rolls first: their commitment is made before anyone else has added anything to the chain.
    if (seat !== 0 || !commit || !B64_32.test(commit)) return null;
    dice = blankDice(n);
    dice.c[0] = commit;
  }
  if (g.clock && !(isInt(g.clock.ms, MIN_CLOCK_MS, MAX_CLOCK_MS) && (g.clock.k === 'total' || g.clock.k === 'move'))) return null;
  // A clock for the whole game only makes sense for two.
  if (g.clock?.k === 'total' && n !== 2) return null;
  return {
    kind: g.kind, players: [...g.players], by: g.by, clock: g.clock ? { k: g.clock.k, ms: g.clock.ms } : null,
    status: 'invited', ok: [g.by], state: engine.init(n), result: null, offer: null,
    time: { left: g.clock?.k === 'total' ? g.players.map(() => g.clock!.ms) : [], base: null, tick: null },
    dice, left: [], from: g.from ?? null, t0: null, moves: 0, who: seat,
  };
}

/** The invite message for a new game. `id` is the id the chat message will be sent with. */
export function inviteEvent(id: string, g: NewGame, secrets: Secrets): GameEvent | null {
  const engine = engineOf(g.kind);
  const s = invited(g, engine.dice ? diceCommit(id, secrets(0)) : null);
  return s ? { v: 1, g: id, n: 0, p: '', r: newGameNonce(), a: { t: 'invite' }, s } : null;
}

/** Is this a well-formed invite from `sender`, carried by the message with this id? */
export function validInvite(ev: GameEvent, sender: string, messageId: string): boolean {
  if (ev.n !== 0 || ev.p !== '' || ev.a.t !== 'invite' || ev.g !== messageId || ev.s.by !== sender) return false;
  const want = invited({ kind: ev.s.kind, players: ev.s.players, by: sender, clock: ev.s.clock, from: ev.s.from }, ev.s.dice?.c[0] ?? null);
  return !!want && canonicalJson(want) === canonicalJson(ev.s);
}

// ---------------------------------------------------------------------------------------------
// The rules of a match

const others = (m: Match) => m.players.length - m.left.length;

/** Take a seat out of a game for more than two; the game ends when one player is left. */
function dropSeat(engine: GameEngine, prev: Match, base: Match, seat: Seat, why: string): Match {
  const state = engine.drop ? engine.drop(prev.state, seat) : prev.state;
  const left = [...prev.left, seat].sort((a, b) => a - b);
  const out = engine.outcome(state);
  return {
    ...base, state, left,
    status: out ? 'over' : 'active',
    result: out ? { winner: out.winner, why } : null,
    dice: base.dice ? { ...base.dice, seed: null, k: 0 } : null,
  };
}

export function step(prev: Match, ctx: StepCtx, a: Action): StepResult {
  const engine = engineOf(prev.kind);
  const seat = prev.players.indexOf(ctx.sender);
  if (seat < 0 || prev.left.includes(seat)) return ILLEGAL;
  const time = settle(prev, ctx.prevAt);
  const dice: DiceState | null = prev.dice && {
    ...prev.dice, c: [...prev.dice.c], cn: [...prev.dice.cn],
    ...(prev.who !== seat ? { e: ctx.link, en: ctx.n - 1 } : {}),
  };
  const base: Match = {
    ...prev, players: [...prev.players], ok: [...prev.ok], left: [...prev.left],
    clock: prev.clock && { ...prev.clock }, result: prev.result && { ...prev.result },
    time, dice, t0: prev.t0 ?? (ctx.n === 1 ? ctx.prevAt : null), who: seat,
  };

  if (prev.status === 'invited') {
    if (a.t === 'cancel') {
      if (ctx.sender !== prev.by) return ILLEGAL;
      return { ok: true, match: { ...base, status: 'cancelled', result: { winner: null, why: 'cancelled' } } };
    }
    if (prev.ok.includes(ctx.sender)) return ILLEGAL;
    if (a.t === 'accept') {
      if (dice) {
        if (typeof a.c !== 'string' || !B64_32.test(a.c)) return ILLEGAL;
        dice.c[seat] = a.c; dice.cn[seat] = ctx.n;
      } else if (a.c !== undefined) return ILLEGAL;
      const ok = [...prev.ok, ctx.sender];
      return { ok: true, match: { ...base, ok, status: ok.length === prev.players.length ? 'active' : 'invited' } };
    }
    if (a.t === 'decline') {
      const players = prev.players.filter((p) => p !== ctx.sender);
      if (players.length < engine.players.min) return { ok: true, match: { ...base, status: 'cancelled', result: { winner: null, why: 'declined' } } };
      // The game goes ahead without them: seats close up (nothing has been played yet).
      const keep = prev.players.map((_, i) => i).filter((i) => i !== seat);
      return {
        ok: true,
        match: {
          // `who` has to be a seat: the message counts as the inviter's, which only means the inviter's first
          // roll doesn't mix it in.
          ...base, players, state: engine.init(players.length), who: 0,
          status: prev.ok.length === players.length ? 'active' : 'invited',
          dice: dice && { ...dice, c: keep.map((i) => dice.c[i]!), cn: keep.map((i) => dice.cn[i]!) },
        },
      };
    }
    return ILLEGAL;
  }
  if (prev.status !== 'active') return ILLEGAL;
  const toMove = engine.turn(prev.state);

  switch (a.t) {
    case 'move': {
      if (toMove !== seat) return ILLEGAL;
      const m = engine.parseMove(a.m);
      if (m === null) return ILLEGAL;
      let roll: number | undefined;
      if (dice && engine.dice) {
        if (dice.seed === null) {
          // A new turn: open the commitment made earlier, and commit to the next secret.
          // What the rolls mix in is the newest message this player didn't send; it must be newer than the
          // commitment, or the player could have picked the secret knowing it.
          const commit = dice.c[seat];
          if (!dice.e || !commit || dice.en <= dice.cn[seat]! || typeof a.x !== 'string' || !diceOpens(ctx.g, a.x, commit)) return ILLEGAL;
          if (typeof a.c !== 'string' || !B64_32.test(a.c)) return ILLEGAL;
          dice.seed = diceSeed(ctx.g, b64u.decode(a.x), dice.e);
          dice.k = 0;
          dice.c[seat] = a.c; dice.cn[seat] = ctx.n;
        } else if (a.x !== undefined || a.c !== undefined) return ILLEGAL;
        roll = diceRoll(dice.seed, dice.k, engine.dice);
      } else if (a.x !== undefined || a.c !== undefined) return ILLEGAL;
      const state = engine.play(prev.state, m, roll);
      if (state === null) return ILLEGAL;
      const out = engine.outcome(state);
      // The same player rolls again (a six): the next roll comes from the same seed.
      if (dice) { if (!out && engine.turn(state) === seat) dice.k += 1; else { dice.seed = null; dice.k = 0; } }
      return {
        ok: true,
        match: {
          ...base, state, moves: prev.moves + 1,
          // A move answers a draw offer from the other player with "no".
          offer: prev.offer === seat ? seat : null,
          time: { ...time, tick: seat },
          status: out ? 'over' : 'active', result: out ? { winner: out.winner, why: out.why } : null,
        },
      };
    }
    case 'resign': {
      if (prev.players.length === 2) return { ok: true, match: { ...base, status: 'over', offer: null, result: { winner: 1 - seat, why: 'resign' } } };
      return { ok: true, match: dropSeat(engine, prev, { ...base, time: { ...time, tick: toMove === seat ? seat : null } }, seat, 'resign') };
    }
    case 'offer':
      if (prev.players.length !== 2 || engine.dice || prev.offer !== null) return ILLEGAL;
      return { ok: true, match: { ...base, offer: seat } };
    case 'agree':
      if (prev.offer === null || prev.offer === seat) return ILLEGAL;
      return { ok: true, match: { ...base, status: 'over', offer: null, result: { winner: null, why: 'agreed' } } };
    case 'refuse':
      if (prev.offer === null || prev.offer === seat) return ILLEGAL;
      return { ok: true, match: { ...base, offer: null } };
    case 'claim': {
      if (toMove === null || toMove === seat || time.base === null) return ILLEGAL;
      const limit = limitFor(prev, time, toMove);
      if (limit === null) return ILLEGAL;
      if (ctx.at - Date.parse(time.base) < limit) return { ok: false, why: 'early' };
      if (others(prev) === 2) return { ok: true, match: { ...base, status: 'over', offer: null, result: { winner: seat, why: 'time' } } };
      return { ok: true, match: dropSeat(engine, prev, { ...base, time: { ...time, tick: toMove } }, toMove, 'time') };
    }
    default:
      return ILLEGAL;
  }
}

// ---------------------------------------------------------------------------------------------
// Writing the next message

/** A game message as a device sees it: the event, its hash, and when the server stored it. */
export interface Head { ev: GameEvent; link: string; at: string }

export const linkOf = (ev: GameEvent): string => gameLink(ev);

/**
 * The roll the player to move gets next (dice games), worked out from their own secret: what the "Roll"
 * button shows. Null when it isn't this seat's turn or the game has no dice.
 */
export function nextRoll(head: Head, seat: Seat, secrets: Secrets): number | null {
  const m = head.ev.s;
  const engine = engineOf(m.kind);
  if (!m.dice || !engine.dice || m.status !== 'active' || engine.turn(m.state) !== seat) return null;
  if (m.dice.seed !== null) return diceRoll(m.dice.seed, m.dice.k, engine.dice);
  // The message to be written follows `head`, so what it mixes in is `head` itself unless this seat sent it.
  const mix = m.who !== seat ? head.link : m.dice.e;
  if (!mix) return null;
  return diceRoll(diceSeed(head.ev.g, secrets(m.dice.cn[seat]!), mix), 0, engine.dice);
}

/** Complete an action with what the dice protocol needs from the sender (reveal and next commitment). */
function withDice(head: Head, seat: Seat, a: Action, secrets: Secrets): Action {
  const m = head.ev.s;
  if (!m.dice) return a;
  const n = head.ev.n + 1;
  if (a.t === 'accept') return { t: 'accept', c: diceCommit(head.ev.g, secrets(n)) };
  if (a.t === 'move' && m.dice.seed === null) {
    return { t: 'move', m: a.m, x: b64u.encode(secrets(m.dice.cn[seat]!)), c: diceCommit(head.ev.g, secrets(n)) };
  }
  return a;
}

/**
 * The next message of a game: `a` applied on top of `head` by `sender`. `now` is the server time as well as
 * this device can tell (it only matters for a time claim, which the server's own clock decides in the end).
 */
export function nextEvent(head: Head, sender: string, a: Action, secrets: Secrets, now: number): { ok: true; ev: GameEvent } | { ok: false; why: 'illegal' | 'early' } {
  const seat = head.ev.s.players.indexOf(sender);
  if (seat < 0) return ILLEGAL as { ok: false; why: 'illegal' };
  const action = withDice(head, seat, a, secrets);
  const n = head.ev.n + 1;
  const res = step(head.ev.s, { g: head.ev.g, n, sender, link: head.link, prevAt: head.at, at: now }, action);
  if (!res.ok) return res;
  return { ok: true, ev: { v: 1, g: head.ev.g, n, p: head.link, r: newGameNonce(), a: action, s: res.match } };
}

// ---------------------------------------------------------------------------------------------
// Reading a message: nothing in it is trusted until it has the right shape.

function parseAction(x: unknown): Action | null {
  if (!isObj(x) || typeof x.t !== 'string') return null;
  const str = (v: unknown) => v === undefined || (typeof v === 'string' && B64_32.test(v));
  const keys = Object.keys(x);
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  switch (x.t) {
    case 'invite': case 'decline': case 'cancel': case 'resign': case 'offer': case 'agree': case 'refuse': case 'claim':
      return only('t') ? { t: x.t } : null;
    case 'accept':
      return only('t', 'c') && str(x.c) ? { t: 'accept', ...(x.c !== undefined ? { c: x.c as string } : {}) } : null;
    case 'move':
      if (!only('t', 'm', 'x', 'c') || !isObj(x.m) || !str(x.x) || !str(x.c)) return null;
      return { t: 'move', m: x.m, ...(x.x !== undefined ? { x: x.x as string } : {}), ...(x.c !== undefined ? { c: x.c as string } : {}) };
    default:
      return null;
  }
}

function parseMatch(x: unknown): Match | null {
  if (!isObj(x) || typeof x.kind !== 'string') return null;
  let engine: GameEngine;
  try { engine = engineOf(x.kind as GameKind); } catch { return null; }
  if (!Array.isArray(x.players) || !x.players.every((p) => typeof p === 'string' && UUID.test(p))) return null;
  const players = [...(x.players as string[])];
  const n = players.length;
  if (n < engine.players.min || n > engine.players.max || new Set(players).size !== n) return null;
  const seat = (v: unknown): v is Seat => isInt(v, 0, n - 1);
  if (typeof x.by !== 'string' || !players.includes(x.by)) return null;
  let clock: ClockSpec | null = null;
  if (x.clock !== null) {
    if (!isObj(x.clock) || (x.clock.k !== 'total' && x.clock.k !== 'move') || !isInt(x.clock.ms, MIN_CLOCK_MS, MAX_CLOCK_MS)) return null;
    clock = { k: x.clock.k, ms: x.clock.ms };
  }
  if (x.status !== 'invited' && x.status !== 'active' && x.status !== 'over' && x.status !== 'cancelled') return null;
  if (!Array.isArray(x.ok) || !x.ok.every((p) => typeof p === 'string' && players.includes(p)) || new Set(x.ok).size !== x.ok.length) return null;
  const state = engine.parse(x.state, n);
  if (state === null) return null;
  let result: Result | null = null;
  if (x.result !== null) {
    if (!isObj(x.result) || !(x.result.winner === null || seat(x.result.winner)) || typeof x.result.why !== 'string' || !/^[a-z]{1,16}$/.test(x.result.why)) return null;
    result = { winner: x.result.winner, why: x.result.why };
  }
  if ((x.status === 'over' || x.status === 'cancelled') !== (result !== null)) return null;
  if (!(x.offer === null || seat(x.offer))) return null;
  const t = x.time;
  if (!isObj(t) || !Array.isArray(t.left) || !(t.left.length === 0 || t.left.length === n) || !t.left.every((v) => isInt(v, 0, MAX_CLOCK_MS))) return null;
  if (!(t.base === null || isTime(t.base)) || !(t.tick === null || seat(t.tick))) return null;
  if ((clock?.k === 'total') !== (t.left.length === n)) return null;
  let dice: DiceState | null = null;
  if (engine.dice) {
    const d = x.dice;
    if (!isObj(d) || !Array.isArray(d.c) || d.c.length !== n || !d.c.every((v) => v === null || (typeof v === 'string' && B64_32.test(v)))) return null;
    if (!Array.isArray(d.cn) || d.cn.length !== n || !d.cn.every((v) => isInt(v, 0, 1_000_000))) return null;
    if (!(d.seed === null || (typeof d.seed === 'string' && B64_32.test(d.seed))) || !isInt(d.k, 0, 8)) return null;
    if (!(d.e === null || (typeof d.e === 'string' && B64_32.test(d.e))) || !isInt(d.en, 0, 1_000_000)) return null;
    dice = { c: [...(d.c as (string | null)[])], cn: [...(d.cn as number[])], seed: d.seed, k: d.k, e: d.e, en: d.en };
  } else if (x.dice !== null) return null;
  if (!Array.isArray(x.left) || x.left.length >= n || !x.left.every((v, i, arr) => seat(v) && (i === 0 || (arr[i - 1] as number) < v))) return null;
  if (!(x.from === null || (typeof x.from === 'string' && UUID.test(x.from))) || !(x.t0 === null || isTime(x.t0))) return null;
  if (!isInt(x.moves, 0, 1_000_000) || !seat(x.who)) return null;
  return {
    kind: engine.kind, players, by: x.by, clock, status: x.status, ok: [...(x.ok as string[])], state, result,
    offer: x.offer, time: { left: [...(t.left as number[])], base: t.base, tick: t.tick }, dice,
    left: [...(x.left as number[])], from: x.from, t0: x.t0, moves: x.moves, who: x.who,
  };
}

/** The game event in a decrypted chat payload, or null when it isn't a well-formed one. */
export function parseEvent(x: unknown): GameEvent | null {
  if (!isObj(x) || x.v !== 1 || typeof x.g !== 'string' || !UUID.test(x.g) || !isInt(x.n, 0, 1_000_000)) return null;
  if (typeof x.p !== 'string' || !(x.n === 0 ? x.p === '' : B64_32.test(x.p)) || typeof x.r !== 'string' || !NONCE.test(x.r)) return null;
  const a = parseAction(x.a);
  const s = parseMatch(x.s);
  if (!a || !s) return null;
  return { v: 1, g: x.g, n: x.n, p: x.p, r: x.r, a, s };
}
