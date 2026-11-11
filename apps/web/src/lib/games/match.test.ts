// The match protocol: invitations, moves checked by every device, draw offers, resigning, clocks measured
// on the server's time, and the dice (commit, reveal, verify).
import { describe, expect, it } from 'vitest';
import { b64u, canonicalJson, diceCommit } from '@kithwall/crypto';
import { IDLE_DROP_MS, inviteEvent, linkOf, nextEvent, nextRoll, parseEvent, step, timeLeft, validInvite, type GameEvent, type Match } from './match';
import { ludo, type LudoState } from './ludo';
import type { TttState } from './tictactoe';
import { ANN, BEN, CAT, Chat, DAN, EVE, newId, secretsOf } from './testkit';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('starting a game', () => {
  it('invite, accept: the game is on and the first player is to move', () => {
    const chat = new Chat();
    const g = chat.invite(ANN, 'tictactoe', [BEN, ANN]);
    let v = chat.view(BEN);
    expect(v.match.status).toBe('invited');
    expect(v.match.ok).toEqual([ANN]);
    expect(v.complete).toBe(true);
    chat.act(BEN, g, { t: 'accept' });
    v = chat.view(ANN);
    expect(v.match.status).toBe('active');
    expect(v.match.players).toEqual([BEN, ANN]); // Ann chose to let Ben start
    expect(v.match.t0).toBe(Date.parse(chat.rows[0]!.at));
    expect(v.refused).toEqual([]);
  });

  it('the invite must be well-formed and come from the inviter, in the message that names the game', () => {
    const id = newId();
    const ev = inviteEvent(id, { kind: 'chess', players: [ANN, BEN], by: ANN, clock: null }, secretsOf(ANN, id))!;
    expect(validInvite(ev, ANN, id)).toBe(true);
    expect(validInvite(ev, BEN, id)).toBe(false);
    expect(validInvite(ev, ANN, newId())).toBe(false);
    expect(validInvite({ ...ev, s: { ...ev.s, moves: 3 } }, ANN, id)).toBe(false);
    expect(validInvite({ ...ev, s: { ...ev.s, status: 'active' } }, ANN, id)).toBe(false);
    // A head start smuggled into the invite is refused.
    const state = { ...(ev.s.state as { b: string }), b: (ev.s.state as { b: string }).b.replace('q', '.') };
    expect(validInvite({ ...ev, s: { ...ev.s, state } }, ANN, id)).toBe(false);
    expect(inviteEvent(id, { kind: 'chess', players: [ANN, ANN], by: ANN, clock: null }, secretsOf(ANN, id))).toBeNull();
    expect(inviteEvent(id, { kind: 'chess', players: [ANN, BEN, CAT], by: ANN, clock: null }, secretsOf(ANN, id))).toBeNull();
    expect(inviteEvent(id, { kind: 'chess', players: [BEN, CAT], by: ANN, clock: null }, secretsOf(ANN, id))).toBeNull();
    expect(inviteEvent(id, { kind: 'chess', players: [ANN, BEN], by: ANN, clock: { k: 'total', ms: 5 } }, secretsOf(ANN, id))).toBeNull();
    // Dice games: the inviter rolls first, so that their commitment comes before everyone else's nonces.
    expect(inviteEvent(id, { kind: 'ludo', players: [BEN, ANN], by: ANN, clock: null }, secretsOf(ANN, id))).toBeNull();
    expect(inviteEvent(id, { kind: 'ludo', players: [ANN, BEN, CAT], by: ANN, clock: { k: 'total', ms: 60_000 } }, secretsOf(ANN, id))).toBeNull();
  });

  it('declining or cancelling ends an invitation; nobody else can answer it', () => {
    const chat = new Chat();
    const g = chat.invite(ANN, 'chess', [ANN, BEN]);
    expect(() => chat.act(CAT, g, { t: 'accept' })).toThrow();
    expect(() => chat.act(ANN, g, { t: 'accept' })).toThrow();
    expect(() => chat.act(BEN, g, { t: 'cancel' })).toThrow();
    expect(() => chat.move(ANN, g, { f: 52, t: 36 })).toThrow(); // not started
    chat.act(BEN, g, { t: 'decline' });
    expect(chat.view(ANN).match).toMatchObject({ status: 'cancelled', result: { winner: null, why: 'declined' } });
    expect(() => chat.act(BEN, g, { t: 'accept' })).toThrow();

    const g2 = chat.invite(ANN, 'chess', [ANN, BEN]);
    chat.act(ANN, g2, { t: 'cancel' });
    expect(chat.view(BEN, g2).match.result).toEqual({ winner: null, why: 'cancelled' });
  });
});

describe('playing', () => {
  function ttt() {
    const chat = new Chat();
    const g = chat.invite(ANN, 'tictactoe', [ANN, BEN]);
    chat.act(BEN, g, { t: 'accept' });
    return { chat, g };
  }

  it('a whole game of tic-tac-toe, seen the same by both players and a spectator', () => {
    const { chat, g } = ttt();
    const order: [string, number][] = [[ANN, 4], [BEN, 0], [ANN, 2], [BEN, 6], [ANN, 3], [BEN, 5], [ANN, 1], [BEN, 7], [ANN, 8]];
    for (const [who, c] of order) chat.move(who, g, { c });
    for (const viewer of [ANN, BEN, CAT, null]) {
      const v = chat.view(viewer);
      expect(v.match.status).toBe('over');
      expect(v.match.result).toEqual({ winner: null, why: 'full' });
      expect((v.match.state as TttState).b).toBe('100001110');
      expect(v.match.moves).toBe(9);
      expect(v.chain).toHaveLength(11);
      expect(v.refused).toEqual([]);
    }
    expect(() => chat.move(ANN, g, { c: 0 })).toThrow();
  });

  it('refuses a move out of turn, an illegal move and a move by someone who is not playing', () => {
    const { chat, g } = ttt();
    const head = chat.view(ANN).head;
    const ctx = (sender: string) => ({ g, n: head.ev.n + 1, sender, link: head.link, prevAt: Date.parse(head.at), at: chat.now + 1 });
    expect(step(head.ev.s, ctx(BEN), { t: 'move', m: { c: 4 } })).toEqual({ ok: false, why: 'illegal' });
    expect(step(head.ev.s, ctx(CAT), { t: 'move', m: { c: 4 } })).toEqual({ ok: false, why: 'illegal' });
    expect(step(head.ev.s, ctx(ANN), { t: 'move', m: { c: 9 } })).toEqual({ ok: false, why: 'illegal' });
    expect(step(head.ev.s, ctx(ANN), { t: 'move', m: 'x' })).toEqual({ ok: false, why: 'illegal' });
    expect(step(head.ev.s, ctx(ANN), { t: 'move', m: { c: 4 }, x: 'a'.repeat(43) })).toEqual({ ok: false, why: 'illegal' });
    expect(step(head.ev.s, ctx(ANN), { t: 'move', m: { c: 4 } }).ok).toBe(true);
    chat.move(ANN, g, { c: 4 });
    expect(() => chat.move(ANN, g, { c: 5 })).toThrow(); // twice in a row
    expect(() => chat.move(BEN, g, { c: 4 })).toThrow(); // taken
  });

  it('a changed app that sends an illegal move is ignored by every device and reported', () => {
    const { chat, g } = ttt();
    chat.move(ANN, g, { c: 4 });
    // Ben's changed app claims a board where his mark replaced Ann's.
    const honest = chat.compose(BEN, g, { t: 'move', m: { c: 0 } });
    const forged = clone(honest);
    (forged.s.state as TttState).b = '....1....';
    forged.a = { t: 'move', m: { c: 4 } };
    const bad = chat.store(BEN, forged);
    for (const viewer of [ANN, BEN, CAT]) {
      const v = chat.view(viewer);
      expect((v.match.state as TttState).b).toBe('....0....');
      expect(v.refused).toEqual([{ id: bad.id, sender: BEN, at: bad.at }]);
      expect(v.match.moves).toBe(1);
    }
    // A legal move with a wrong account of the result is refused too (it would mislead devices later).
    const lying = clone(honest);
    lying.s.moves = 7;
    chat.store(BEN, lying);
    expect(chat.view(ANN).refused).toHaveLength(2);
    // The game goes on from the last good position.
    chat.store(BEN, honest);
    expect((chat.view(ANN).match.state as TttState).b).toBe('1...0....');
    expect(chat.view(ANN).refused).toHaveLength(2);
  });

  it('resigning gives the other player the win', () => {
    const { chat, g } = ttt();
    chat.move(ANN, g, { c: 0 });
    chat.act(ANN, g, { t: 'resign' }); // also when it isn't your turn
    expect(chat.view(BEN).match.result).toEqual({ winner: 1, why: 'resign' });
    expect(() => chat.act(BEN, g, { t: 'resign' })).toThrow();
  });

  it('draw offers: agree, refuse, or answer by moving', () => {
    const { chat, g } = ttt();
    expect(() => chat.act(ANN, g, { t: 'agree' })).toThrow();
    chat.act(ANN, g, { t: 'offer' });
    expect(chat.view(BEN).match.offer).toBe(0);
    expect(() => chat.act(ANN, g, { t: 'agree' })).toThrow(); // not your own offer
    expect(() => chat.act(BEN, g, { t: 'offer' })).toThrow(); // one at a time
    chat.act(BEN, g, { t: 'refuse' });
    expect(chat.view(ANN).match.offer).toBeNull();
    chat.act(BEN, g, { t: 'offer' });
    chat.move(ANN, g, { c: 4 }); // moving on says no
    expect(chat.view(BEN).match.offer).toBeNull();
    chat.act(BEN, g, { t: 'offer' });
    chat.move(BEN, g, { c: 0 }); // the offer stays while the other player thinks
    expect(chat.view(ANN).match.offer).toBe(1);
    chat.act(ANN, g, { t: 'agree' });
    expect(chat.view(BEN).match).toMatchObject({ status: 'over', result: { winner: null, why: 'agreed' } });
  });

  it('chess by message: check, mate and the result', () => {
    const chat = new Chat();
    const g = chat.invite(BEN, 'chess', [ANN, BEN]);
    chat.act(ANN, g, { t: 'accept' });
    const sq = (name: string) => 'abcdefgh'.indexOf(name[0]!) + (8 - Number(name[1])) * 8;
    for (const [who, text] of [[ANN, 'f2f3'], [BEN, 'e7e5'], [ANN, 'g2g4'], [BEN, 'd8h4']] as const) {
      chat.move(who, g, { f: sq(text.slice(0, 2)), t: sq(text.slice(2)) });
    }
    const v = chat.view(CAT);
    expect(v.match.result).toEqual({ winner: 1, why: 'checkmate' });
    expect((v.match.state as { san: string[] }).san).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
  });
});

describe('clocks', () => {
  function timed(clock: { k: 'total' | 'move'; ms: number }) {
    const chat = new Chat();
    const g = chat.invite(ANN, 'tictactoe', [ANN, BEN], clock);
    chat.act(BEN, g, { t: 'accept' });
    return { chat, g };
  }
  const left = (chat: Chat, at = chat.now) => { const h = chat.view(null).head; return timeLeft(h.ev.s, Date.parse(h.at), at); };

  it('time for the whole game runs on the server times of the moves', () => {
    const { chat, g } = timed({ k: 'total', ms: 60_000 });
    expect(left(chat)).toEqual({ seat: 0, ms: 60_000 }); // starts when the game is accepted
    chat.move(ANN, g, { c: 0 }, 10_000);
    expect(left(chat)).toEqual({ seat: 1, ms: 60_000 });
    expect(left(chat, chat.now + 5000)).toEqual({ seat: 1, ms: 55_000 });
    chat.move(BEN, g, { c: 1 }, 20_000);
    chat.move(ANN, g, { c: 2 }, 30_000);
    expect(left(chat)).toEqual({ seat: 1, ms: 40_000 });
    chat.move(BEN, g, { c: 3 }, 1000);
    expect(left(chat)).toEqual({ seat: 0, ms: 20_000 });
    // Offers and refusals don't stop or restart anyone's clock.
    chat.act(BEN, g, { t: 'offer' }, 5000);
    chat.act(ANN, g, { t: 'refuse' }, 5000);
    expect(left(chat)).toEqual({ seat: 0, ms: 10_000 });
  });

  it('the other player can claim the win once the time is up, not a moment before', () => {
    const { chat, g } = timed({ k: 'total', ms: 60_000 });
    chat.move(ANN, g, { c: 0 }, 1000);
    // Ben thinks. Ann's device believes the time is up, but the server stores her claim too early.
    const early = chat.compose(ANN, g, { t: 'claim' }, chat.now + 61_000);
    const stored = chat.store(ANN, early, 59_000);
    let v = chat.view(BEN);
    expect(v.match.status).toBe('active');
    expect(v.refused).toEqual([]); // an early claim is ignored, not an offence
    expect(v.rows).toContain(stored.id);
    // Ben can't claim against himself, and Ann can't claim while composing with an honest clock.
    expect(() => chat.act(BEN, g, { t: 'claim' })).toThrow();
    expect(() => chat.compose(ANN, g, { t: 'claim' }, chat.now + 500)).toThrow(/early/);
    chat.act(ANN, g, { t: 'claim' }, 1000);
    v = chat.view(BEN);
    expect(v.match).toMatchObject({ status: 'over', result: { winner: 0, why: 'time' } });
  });

  it('a late move is still a move if nobody claimed first; the flag stays down', () => {
    const { chat, g } = timed({ k: 'total', ms: 60_000 });
    chat.move(ANN, g, { c: 0 }, 70_000); // Ann overran, Ben didn't claim
    expect(chat.view(BEN).match.status).toBe('active');
    chat.move(BEN, g, { c: 1 }, 1000);
    expect(left(chat)).toEqual({ seat: 0, ms: 0 });
    chat.act(BEN, g, { t: 'claim' }, 10);
    expect(chat.view(ANN).match.result).toEqual({ winner: 1, why: 'time' });
  });

  it('time per move starts again with every move', () => {
    const { chat, g } = timed({ k: 'move', ms: 86_400_000 });
    chat.move(ANN, g, { c: 0 }, 80_000_000);
    chat.move(BEN, g, { c: 1 }, 80_000_000);
    expect(left(chat)).toEqual({ seat: 0, ms: 86_400_000 });
    expect(() => chat.act(BEN, g, { t: 'claim' }, 86_000_000)).toThrow(/early/);
    chat.act(BEN, g, { t: 'claim' }, 86_400_000);
    expect(chat.view(ANN).match.result).toEqual({ winner: 1, why: 'time' });
  });

  it('without a clock, a two-player game can never be claimed', () => {
    const chat = new Chat();
    const g = chat.invite(ANN, 'tictactoe', [ANN, BEN]);
    chat.act(BEN, g, { t: 'accept' });
    expect(left(chat, chat.now + 1e12)).toBeNull();
    expect(() => chat.act(BEN, g, { t: 'claim' }, 1e10)).toThrow(/illegal/);
  });
});

describe('dice (Ludo)', () => {
  /** Send the turn message of whoever is to move, picking among the legal moves with `pick`. */
  function turn(chat: Chat, g: string, pick: (n: number) => number = () => 0, ms = 1000): { who: string; roll: number; before: Match } | null {
    const v = chat.view(null, g);
    if (v.match.status !== 'active') return null;
    const state = v.match.state as LudoState;
    const who = v.match.players[state.t]!;
    const roll = nextRoll(v.head, state.t, secretsOf(who, g))!;
    const options = ludo.moves(state, roll);
    chat.actOn(v.head, who, { t: 'move', m: options[pick(options.length) % options.length] }, ms);
    return { who, roll, before: v.match };
  }

  it('three players: every roll is fixed by the roller’s commitment and the others’ messages, and verified by all', () => {
    const chat = new Chat();
    const g = chat.invite(ANN, 'ludo', [ANN, BEN, CAT]);
    chat.act(BEN, g, { t: 'accept' });
    chat.act(CAT, g, { t: 'accept' });
    const counts = [0, 0, 0, 0, 0, 0];
    let i = 0;
    let rolled: number | null = null;
    for (; i < 5000; i++) {
      const t = turn(chat, g, (n) => (i * 7) % n);
      // The roll every device derived for the last turn is the one its roller saw before sending.
      if (rolled !== null) expect((t ? t.before : chat.view(null, g).match).state).toMatchObject({ last: { r: rolled } });
      if (!t) break;
      rolled = t.roll;
      counts[t.roll - 1]!++;
    }
    const v = chat.view(DAN, g); // a spectator checks the whole game from the invite
    expect(v.complete).toBe(true);
    expect(v.refused).toEqual([]);
    expect(v.chain).toHaveLength(i + 3);
    expect(v.match).toMatchObject({ status: 'over', result: { why: 'home' } });
    // Fair enough over a whole game: every face came up.
    expect(Math.min(...counts)).toBeGreaterThan(i / 12);
  }, 180_000);

  it('a roller cannot use a different secret, keep the old commitment, or skip the reveal', () => {
    const chat = new Chat();
    const g = chat.invite(ANN, 'ludo', [ANN, BEN]);
    chat.act(BEN, g, { t: 'accept' });
    const head = chat.view(ANN, g).head;
    const roll = nextRoll(head, 0, secretsOf(ANN, g))!;
    const legal = ludo.moves(head.ev.s.state as LudoState, roll)[0]!;
    const ctx = { g, n: head.ev.n + 1, sender: ANN, link: head.link, prevAt: Date.parse(head.at), at: chat.now + 1 };
    const real = nextEvent(head, ANN, { t: 'move', m: legal }, secretsOf(ANN, g), chat.now + 1);
    expect(real.ok).toBe(true);
    const a = (real as { ev: GameEvent }).ev.a as { t: 'move'; m: unknown; x: string; c: string };
    expect(step(head.ev.s, ctx, a).ok).toBe(true);
    // Another secret (to get another roll): doesn't open the commitment.
    const other = b64u.encode(secretsOf(ANN, g)(99));
    expect(step(head.ev.s, ctx, { ...a, x: other })).toEqual({ ok: false, why: 'illegal' });
    // No reveal, or no new commitment.
    expect(step(head.ev.s, ctx, { t: 'move', m: legal, c: a.c })).toEqual({ ok: false, why: 'illegal' });
    expect(step(head.ev.s, ctx, { t: 'move', m: legal, x: a.x })).toEqual({ ok: false, why: 'illegal' });
    // Someone else's secret is useless too.
    expect(step(head.ev.s, ctx, { ...a, x: b64u.encode(secretsOf(BEN, g)(1)) })).toEqual({ ok: false, why: 'illegal' });
  });

  it('claiming a roll that was not rolled is refused by every device', () => {
    // Find a turn where the real roll isn't a six and the player has nothing out, then claim a piece left the
    // yard anyway. When both players roll an early six there is no such turn for a long time (about one game
    // in thirty): start a fresh game instead of giving up.
    for (let game = 0; game < 200; game++) {
      const chat = new Chat();
      const g = chat.invite(ANN, 'ludo', [ANN, BEN]);
      chat.act(BEN, g, { t: 'accept' });
      for (let i = 0; i < 4; i++) {
        const v = chat.view(null, g);
        const state = v.match.state as LudoState;
        const who = v.match.players[state.t]!;
        const roll = nextRoll(chat.view(who, g).head, state.t, secretsOf(who, g))!;
        if (roll === 6 || state.tok[state.t]!.some((p) => p >= 0)) { turn(chat, g); continue; }
        const honest = chat.compose(who, g, { t: 'move', m: { k: -1 } });
        const forged = clone(honest);
        forged.a = { ...(honest.a as object), m: { k: 0 } } as GameEvent['a'];
        (forged.s.state as LudoState).tok[state.t]![0] = 0;
        (forged.s.state as LudoState).last = { s: state.t, r: 6, k: 0, hit: [] };
        const bad = chat.store(who, forged);
        const seen = chat.view(who === ANN ? BEN : ANN, g);
        expect(seen.refused.map((r) => r.id)).toEqual([bad.id]);
        expect((seen.match.state as LudoState).tok).toEqual(state.tok);
        return;
      }
    }
    throw new Error('no such turn in 200 games');
  });

  it('a six rolls again from the same seed; the next turn needs a fresh reveal', () => {
    const chat = new Chat();
    const g = chat.invite(ANN, 'ludo', [ANN, BEN]);
    chat.act(BEN, g, { t: 'accept' });
    let sawSix = false;
    for (let i = 0; i < 400 && !sawSix; i++) {
      const t = turn(chat, g);
      if (!t) break;
      const { before, who, roll } = t;
      const head = chat.view(null, g).head;
      const after = head.ev.s;
      const ev = head.ev;
      const seat = before.players.indexOf(who);
      if (before.dice!.seed === null) {
        expect(ev.a).toHaveProperty('x');
        expect(after.dice!.c[seat]).toBe(diceCommit(g, secretsOf(who, g)(ev.n)));
        expect(after.dice!.cn[seat]).toBe(ev.n);
      } else {
        expect(ev.a).not.toHaveProperty('x'); // same turn: nothing new to reveal
        sawSix = true;
      }
      if (roll === 6 && (before.state as LudoState).six < 2 && after.status === 'active') {
        expect((after.state as LudoState).t).toBe(seat);
        expect(after.dice!.seed).not.toBeNull();
        expect(after.dice!.k).toBe((before.dice!.seed === null ? 0 : before.dice!.k) + 1);
      } else expect(after.dice!.seed).toBeNull();
    }
    expect(sawSix).toBe(true);
  });

  it('the rolls depend on what the other players sent after the commitment', () => {
    // Same game, same secrets; only Ben's accept differs (its nonce). Ann's first roll is not fixed by Ann.
    const rolls = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const chat = new Chat();
      const id = uidFixed;
      const ev = inviteEvent(id, { kind: 'ludo', players: [ANN, BEN], by: ANN, clock: null }, secretsOf(ANN, id))!;
      chat.store(ANN, ev, 1000, id);
      chat.act(BEN, id, { t: 'accept' });
      rolls.add(nextRoll(chat.view(ANN, id).head, 0, secretsOf(ANN, id))!);
    }
    expect(rolls.size).toBeGreaterThan(3);
  });
  const uidFixed = newId();

  it('four players: one declines, one resigns, one disappears and is taken out after a day; the dice go on', () => {
    const chat = new Chat();
    const g = chat.invite(ANN, 'ludo', [ANN, BEN, CAT, DAN, EVE].slice(0, 4));
    chat.act(BEN, g, { t: 'accept' });
    chat.act(DAN, g, { t: 'decline' });
    expect(chat.view(null, g).match.players).toEqual([ANN, BEN, CAT]);
    expect(chat.view(null, g).match.status).toBe('invited');
    expect(() => chat.act(DAN, g, { t: 'accept' })).toThrow();
    chat.act(CAT, g, { t: 'accept' });
    expect(chat.view(null, g).match.status).toBe('active');
    for (let i = 0; i < 12; i++) turn(chat, g);
    // Whoever is to move now goes quiet.
    const m = chat.view(null, g).match;
    const quiet = m.players[(m.state as LudoState).t]!;
    const [first, second] = m.players.filter((p) => p !== quiet) as [string, string];
    expect(() => chat.act(quiet, g, { t: 'claim' })).toThrow(/illegal/);
    expect(() => chat.act(first, g, { t: 'claim' }, IDLE_DROP_MS - 5000)).toThrow(/early/);
    chat.act(first, g, { t: 'claim' }, IDLE_DROP_MS);
    let v = chat.view(null, g);
    expect(v.match.status).toBe('active');
    expect(v.match.left).toEqual([m.players.indexOf(quiet)]);
    expect(() => chat.move(quiet, g, { k: -1 })).toThrow();
    // Two are left: now there is no limit any more (no clock was chosen), and play goes on with fair dice.
    for (let i = 0; i < 12; i++) turn(chat, g);
    expect(() => chat.act(first, g, { t: 'claim' }, IDLE_DROP_MS * 3)).toThrow();
    v = chat.view(null, g);
    expect(v.refused).toEqual([]);
    expect(v.complete).toBe(true);
    chat.act(second, g, { t: 'resign' });
    v = chat.view(EVE, g);
    expect(v.match).toMatchObject({ status: 'over', result: { winner: m.players.indexOf(first), why: 'resign' } });
  });

  it('with a clock per move, a slow player is taken out and the game continues', () => {
    const chat = new Chat();
    const g = chat.invite(ANN, 'ludo', [ANN, BEN, CAT], { k: 'move', ms: 120_000 });
    chat.act(BEN, g, { t: 'accept' });
    chat.act(CAT, g, { t: 'accept' });
    turn(chat, g, undefined, 100_000);
    const m = chat.view(null, g).match;
    const slow = m.players[(m.state as LudoState).t]!;
    const other = m.players.find((p) => p !== slow)!;
    chat.act(other, g, { t: 'claim' }, 120_000);
    const after = chat.view(null, g).match;
    expect(after.left).toEqual([m.players.indexOf(slow)]);
    expect(after.status).toBe('active');
    for (let i = 0; i < 6; i++) turn(chat, g);
    expect(chat.view(null, g).refused).toEqual([]);
  });
});

describe('reading messages', () => {
  it('accepts what the app writes and nothing malformed', () => {
    const chat = new Chat();
    const g = chat.invite(ANN, 'ludo', [ANN, BEN], { k: 'move', ms: 86_400_000 });
    chat.act(BEN, g, { t: 'accept' });
    for (const row of chat.rows) {
      const wire = clone(row.ev);
      expect(parseEvent(wire)).toEqual(row.ev);
      expect(canonicalJson(parseEvent(wire))).toBe(canonicalJson(row.ev));
      expect(linkOf(parseEvent(wire)!)).toBe(linkOf(row.ev));
    }
    const ev = clone(chat.rows[1]!.ev) as unknown as Record<string, unknown> & { s: Record<string, unknown>; a: Record<string, unknown> };
    const bad: unknown[] = [
      null, 'x', [], { ...ev, v: 2 }, { ...ev, g: 'not-a-uuid' }, { ...ev, n: -1 }, { ...ev, n: 1.5 }, { ...ev, p: '' }, { ...ev, r: 'short' },
      { ...ev, a: { t: 'win' } }, { ...ev, a: { t: 'accept', extra: 1 } }, { ...ev, a: { t: 'move', m: 1 } },
      { ...ev, s: { ...ev.s, kind: 'poker' } }, { ...ev, s: { ...ev.s, players: [ANN] } }, { ...ev, s: { ...ev.s, players: [ANN, ANN] } },
      { ...ev, s: { ...ev.s, by: CAT } }, { ...ev, s: { ...ev.s, status: 'won' } }, { ...ev, s: { ...ev.s, ok: [CAT] } },
      { ...ev, s: { ...ev.s, state: { n: 2 } } }, { ...ev, s: { ...ev.s, result: { winner: 5, why: 'x' } } },
      { ...ev, s: { ...ev.s, result: { winner: 0, why: 'home' } } }, // a result while the game is still on
      { ...ev, s: { ...ev.s, clock: { k: 'total', ms: 1 } } }, { ...ev, s: { ...ev.s, time: { left: [1], base: null, tick: null } } },
      { ...ev, s: { ...ev.s, time: { left: [], base: 'yesterday', tick: null } } }, { ...ev, s: { ...ev.s, dice: null } },
      { ...ev, s: { ...ev.s, left: [0, 1] } }, { ...ev, s: { ...ev.s, who: 2 } }, { ...ev, s: { ...ev.s, moves: -1 } },
    ];
    for (const x of bad) expect(parseEvent(x), JSON.stringify(x)?.slice(0, 120)).toBeNull();
  });

  it('the match in a message is plain canonical JSON (it is covered by the franking commitment)', () => {
    const chat = new Chat();
    const g = chat.invite(ANN, 'chess', [ANN, BEN], { k: 'total', ms: 300_000 });
    chat.act(BEN, g, { t: 'accept' });
    chat.move(ANN, g, { f: 52, t: 36 });
    for (const row of chat.rows) expect(() => canonicalJson(row.ev)).not.toThrow();
    const m: Match = chat.view(null).match;
    expect(Object.keys(m).sort()).toEqual(['by', 'clock', 'dice', 'from', 'kind', 'left', 'moves', 'offer', 'ok', 'players', 'result', 'state', 'status', 't0', 'time', 'who']);
  });
});
