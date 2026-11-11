// From messages to games: the same result whatever order messages arrive in, with duplicates, races
// between devices, edited and deleted moves, made-up moves, disappearing messages and moves still on
// their way from this device.
import { describe, expect, it } from 'vitest';
import { newGameNonce } from '@kithwall/crypto';
import { buildGames, tally, type GameItem } from './thread';
import type { GameEvent } from './match';
import type { TttState } from './tictactoe';
import { ANN, BEN, CAT, Chat, newId } from './testkit';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const board = (chat: Chat, me: string | null, g?: string) => (chat.view(me, g).match.state as TttState).b;

function started(kind: 'tictactoe' | 'chess' = 'tictactoe') {
  const chat = new Chat();
  const g = chat.invite(ANN, kind, [ANN, BEN]);
  chat.act(BEN, g, { t: 'accept' });
  return { chat, g };
}

describe('games from chat messages', () => {
  it('gives the same game whatever order the messages arrive in', () => {
    const { chat, g } = started();
    for (const [who, c] of [[ANN, 4], [BEN, 0], [ANN, 8], [BEN, 2], [ANN, 1]] as const) chat.move(who, g, { c });
    const want = chat.view(CAT);
    let seed = 7;
    const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 20; i++) {
      const rows = [...chat.rows];
      for (let k = rows.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [rows[k], rows[j]] = [rows[j]!, rows[k]!]; }
      const [v] = buildGames(rows, CAT);
      expect(v!.match).toEqual(want.match);
      expect(v!.chain.map((n) => n.id)).toEqual(want.chain.map((n) => n.id));
    }
    expect(want.cardRow).toBe(chat.rows[chat.rows.length - 1]!.id);
    expect(want.rows).toEqual(chat.rows.map((r) => r.id));
  });

  it('the same message twice, or the same event sent again, counts once', () => {
    const { chat, g } = started();
    const first = chat.move(ANN, g, { c: 4 });
    chat.store(ANN, clone(first.ev)); // a retry that got a new message id
    chat.rows.push({ ...first }); // the very same row delivered twice
    const v = chat.view(BEN);
    expect(v.match.moves).toBe(1);
    expect(v.refused).toEqual([]);
    chat.move(BEN, g, { c: 0 });
    expect(board(chat, ANN)).toBe('1...0....');
  });

  it('two devices of one person: the move the server stored first stands, the other is dropped quietly', () => {
    const { chat, g } = started();
    const phone = chat.compose(ANN, g, { t: 'move', m: { c: 4 } });
    const laptop = chat.compose(ANN, g, { t: 'move', m: { c: 0 } });
    chat.store(ANN, laptop);
    chat.store(ANN, phone);
    for (const me of [ANN, BEN, CAT]) {
      expect(board(chat, me)).toBe('0........');
      expect(chat.view(me).refused).toEqual([]);
      // The loser is known as long as nothing else has happened (the device that sent it may send it again).
      expect(chat.view(me).dropped.map((d) => d.ev.a)).toEqual([{ t: 'move', m: { c: 4 } }]);
    }
    chat.move(BEN, g, { c: 8 });
    expect(chat.view(ANN).dropped).toEqual([]);
    chat.move(ANN, g, { c: 1 });
    // A move written offline that arrives after the other player resigned: the game was already over.
    const late = chat.compose(BEN, g, { t: 'move', m: { c: 7 } });
    chat.act(ANN, g, { t: 'resign' });
    chat.store(BEN, late);
    expect(chat.view(BEN).match.result).toEqual({ winner: 1, why: 'resign' });
    expect(chat.view(BEN).refused).toEqual([]);
  });

  it('an edited game message is refused: the move it carried no longer counts for anyone who loads it', () => {
    const { chat, g } = started();
    const m = chat.move(ANN, g, { c: 4 });
    m.edited = true;
    const v = chat.view(BEN);
    expect(v.match.moves).toBe(0);
    expect(v.refused.map((r) => r.id)).toEqual([m.id]);
    // Ann has to move again; the game is not stuck.
    chat.move(ANN, g, { c: 0 });
    expect(board(chat, BEN)).toBe('0........');
  });

  it('a move cannot be taken back once it has been answered', () => {
    const { chat, g } = started();
    chat.move(ANN, g, { c: 4 });
    const answered = chat.move(BEN, g, { c: 0 });
    const reply = chat.move(ANN, g, { c: 8 });
    // Ben's changed app unsends his move and plays another one in its place.
    chat.rows = chat.rows.filter((r) => r !== answered);
    const ann = chat.view(ANN);
    expect(ann.match.moves).toBe(3);
    expect(board(chat, ANN)).toBe('1...0...0');
    expect(ann.complete).toBe(false); // her own reply is now the oldest message she can build on
    expect(ann.head.id).toBe(reply.id);
    const head = buildGames(chat.rows, BEN)[0]!.head; // Ben's device sees the game one move back
    expect(head.ev.s.moves).toBe(1);
    const other = chat.actOn(head, BEN, { t: 'move', m: { c: 2 } });
    // Ann's device keeps the game she played. Ben can only go on from there.
    expect(board(chat, ANN)).toBe('1...0...0');
    expect(chat.view(ANN).head.id).toBe(reply.id);
    expect(chat.view(ANN).rows).toContain(other.id);
    chat.actOn(chat.view(ANN).head, BEN, { t: 'move', m: { c: 2 } });
    expect(board(chat, ANN)).toBe('1.1.0...0');
  });

  it('a made-up later position is refused by the other player and by spectators', () => {
    const { chat, g } = started();
    chat.move(ANN, g, { c: 4 });
    // Ben skips ahead to a board he would like better.
    const fake = clone(chat.compose(BEN, g, { t: 'move', m: { c: 0 } }));
    fake.n += 2;
    fake.p = 'A'.repeat(43);
    (fake.s.state as TttState).b = '111.0....';
    fake.s.status = 'over';
    fake.s.result = { winner: 1, why: 'line' };
    const bad = chat.store(BEN, fake);
    for (const me of [ANN, CAT, null]) {
      const v = chat.view(me);
      expect(v.match.status).toBe('active');
      expect(board(chat, me)).toBe('....0....');
      expect(v.refused.map((r) => r.id)).toEqual([bad.id]);
    }
    // While some messages can't be decrypted yet, a message without its neighbours isn't reported.
    expect(buildGames(chat.rows, ANN, true)[0]!.refused).toEqual([]);
  });

  it('when the first messages have disappeared, the game goes on from the oldest one left', () => {
    const { chat, g } = started('chess');
    const sq = (name: string) => 'abcdefgh'.indexOf(name[0]!) + (8 - Number(name[1])) * 8;
    const play = (who: string, text: string) => chat.move(who, g, { f: sq(text.slice(0, 2)), t: sq(text.slice(2)) });
    play(ANN, 'e2e4'); play(BEN, 'e7e5'); play(ANN, 'g1f3'); play(BEN, 'b8c6');
    const full = chat.view(CAT);
    chat.rows = chat.rows.slice(4); // the invite, the accept and the first two moves have expired
    for (const me of [ANN, BEN, CAT]) {
      const v = chat.view(me);
      expect(v.complete).toBe(false);
      expect(v.match).toEqual(full.match);
      expect(v.chain).toHaveLength(2);
      expect(v.refused).toEqual([]);
    }
    play(ANN, 'f1b5');
    play(BEN, 'a7a6');
    expect((chat.view(CAT).match.state as { san: string[] }).san).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
    // Illegal moves are still caught from there on.
    expect(() => play(ANN, 'b5b6')).toThrow();
    // Only the newest message is left: everyone still has the position.
    chat.rows = chat.rows.slice(-1);
    expect((chat.view(ANN).match.state as { san: string[] }).san).toHaveLength(6);
  });

  it('a finished game that names me but holds nothing I sent is not taken on trust', () => {
    const { chat, g } = started();
    chat.move(ANN, g, { c: 4 });
    const last = clone(chat.rows[chat.rows.length - 1]!.ev);
    last.s.status = 'over';
    last.s.result = { winner: 0, why: 'line' };
    const forged: GameItem = { id: newId(), sender: ANN, at: '2026-11-11T12:00:00.000Z', edited: false, ev: { ...last, g: newId(), r: newGameNonce() } };
    expect(buildGames([forged], BEN)).toEqual([]);
    // Someone who isn't named in it can't tell, and sees what the message says.
    expect(buildGames([forged], CAT)).toHaveLength(1);
    // A message from someone who isn't the player it claims to be starts nothing.
    expect(buildGames([{ ...forged, sender: CAT }], null)).toEqual([]);
    expect(forged.ev.g).not.toBe(g);
  });

  it('an invite only counts in the message that carries its own id, once', () => {
    const { chat, g } = started();
    const invite = chat.rows[0]!;
    expect(buildGames([{ ...invite, id: newId() }], BEN)).toEqual([]);
    const again: GameItem = { ...invite, at: '2026-11-11T13:00:00.000Z', ev: { ...invite.ev, r: newGameNonce() } };
    const v = buildGames([...chat.rows, again], BEN)[0]!;
    expect(v.match.status).toBe('active');
    expect(v.id).toBe(g);
  });

  it('my move shows at once while it is being sent, and gives way if the server stored something else first', () => {
    const { chat, g } = started();
    const ev = chat.compose(ANN, g, { t: 'move', m: { c: 4 } });
    const pending: GameItem = { id: newId(), sender: ANN, at: new Date(chat.now + 5).toISOString(), edited: false, ev, pending: true };
    let v = buildGames([pending, ...chat.rows], ANN)[0]!;
    expect((v.match.state as TttState).b).toBe('....0....');
    expect(v.pending).toBe(true);
    expect(v.cardRow).toBe(chat.rows[1]!.id); // the card stays on the newest stored message
    expect(v.rows).not.toContain(pending.id);
    // Ben resigned in the meantime: his message was stored first.
    chat.act(BEN, g, { t: 'resign' });
    v = buildGames([pending, ...chat.rows], ANN)[0]!;
    expect(v.pending).toBe(false);
    expect(v.match.result).toEqual({ winner: 0, why: 'resign' });
    // A new game that exists only on this device so far has no stored message to stand on.
    const fresh = new Chat();
    const inviteOnly = fresh.invite(ANN, 'reversi', [ANN, BEN]);
    const row = { ...fresh.rows[0]!, pending: true };
    const only = buildGames([row], ANN)[0]!;
    expect([only.id, only.cardRow, only.pending]).toEqual([inviteOnly, null, true]);
  });

  it('the format of a timestamp does not matter, only the instant (to the microsecond)', () => {
    const { chat, g } = started();
    chat.move(ANN, g, { c: 4 });
    const want = chat.view(BEN).match;
    // The same rows as another API might hand them over: "Z" instead of "+00:00", or with microseconds.
    const z = chat.rows.map((r) => ({ ...r, at: r.at.replace('Z', '+00:00') }));
    const micro = chat.rows.map((r) => ({ ...r, at: r.at.replace('Z', '000+00:00') }));
    expect(buildGames(z, BEN)[0]!.match).toEqual(want);
    expect(buildGames(micro, BEN)[0]!.match).toEqual(want);
    // Two messages in the same millisecond are ordered by their microseconds: the earlier one wins the place.
    const phone = chat.compose(BEN, g, { t: 'move', m: { c: 0 } });
    const laptop = chat.compose(BEN, g, { t: 'move', m: { c: 8 } });
    const rows = [...chat.rows,
      { id: newId(), sender: BEN, at: '2026-11-11T11:00:00.123900+00:00', edited: false, ev: phone },
      { id: newId(), sender: BEN, at: '2026-11-11T11:00:00.123456+00:00', edited: false, ev: laptop }];
    expect((buildGames(rows, ANN)[0]!.match.state as TttState).b).toBe('....0...1');
  });

  it('several games in one chat are kept apart', () => {
    const chat = new Chat();
    const a = chat.invite(ANN, 'tictactoe', [ANN, BEN]);
    const b = chat.invite(BEN, 'connect4', [BEN, ANN]);
    chat.act(BEN, a, { t: 'accept' });
    chat.act(ANN, b, { t: 'accept' });
    chat.move(BEN, b, { c: 3 });
    chat.move(ANN, a, { c: 4 });
    const all = buildGames(chat.rows, ANN);
    expect(all.map((v) => v.id)).toEqual([b, a]); // newest activity last
    expect(all.map((v) => v.match.moves)).toEqual([1, 1]);
    // A message can't join another game by naming it: the chain values don't match.
    const cross: GameEvent = { ...clone(chat.compose(ANN, b, { t: 'move', m: { c: 0 } })), g: a };
    chat.store(ANN, cross);
    expect(chat.view(BEN, a).match.moves).toBe(1);
  });

  it('scores are counted from the finished games', () => {
    const chat = new Chat();
    const win = (first: string, second: string) => {
      const g = chat.invite(first, 'tictactoe', [first, second]);
      chat.act(second, g, { t: 'accept' });
      for (const [who, c] of [[first, 0], [second, 3], [first, 1], [second, 4], [first, 2]] as const) chat.move(who, g, { c });
    };
    win(ANN, BEN); win(ANN, BEN); win(BEN, ANN);
    const g = chat.invite(ANN, 'tictactoe', [ANN, BEN]);
    chat.act(BEN, g, { t: 'accept' });
    chat.act(ANN, g, { t: 'offer' });
    chat.act(BEN, g, { t: 'agree' });
    const declined = chat.invite(ANN, 'chess', [ANN, BEN]);
    chat.act(BEN, declined, { t: 'decline' });
    chat.invite(ANN, 'chess', [ANN, CAT]); // still open
    expect(tally(buildGames(chat.rows, CAT))).toEqual([
      { player: ANN, won: 2, lost: 1, drawn: 1 },
      { player: BEN, won: 1, lost: 2, drawn: 1 },
    ]);
  });
});
