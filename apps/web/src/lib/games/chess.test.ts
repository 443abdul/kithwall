// Chess rules: move generation against the standard perft counts (chessprogramming.org "Perft Results"),
// the tricky rules one by one, notation, and whole games. Run: npx vitest run src/lib/games
import { describe, expect, it } from 'vitest';
import { chess, chessCheckSquare, chessFen, chessFromFen, chessPerft, chessSquare, type ChessMove, type ChessState } from './chess';

const sq = (name: string) => 'abcdefgh'.indexOf(name[0]!) + (8 - Number(name[1])) * 8;
const mv = (text: string): ChessMove => ({ f: sq(text.slice(0, 2)), t: sq(text.slice(2, 4)), ...(text[4] ? { p: text[4] as 'q' | 'r' | 'b' | 'n' } : {}) });
const has = (s: ChessState, text: string) => chess.moves(s).some((m) => m.f === mv(text).f && m.t === mv(text).t);

/** Play moves given in algebraic notation (as the engine itself writes them). */
function playSan(s: ChessState, sans: string): ChessState {
  for (const san of sans.split(/\s+/).filter(Boolean)) {
    const next = chess.moves(s).map((m) => chess.play(s, m)!).find((n) => n.san[n.san.length - 1] === san);
    if (!next) throw new Error(`no move ${san} in ${chessFen(s)}`);
    s = next;
  }
  return s;
}
function playAll(s: ChessState, moves: string): ChessState {
  for (const text of moves.split(/\s+/).filter(Boolean)) {
    const next = chess.play(s, mv(text));
    if (!next) throw new Error(`illegal ${text} in ${chessFen(s)}`);
    s = next;
  }
  return s;
}

describe('chess move generation (perft)', () => {
  const cases: [string, string, number[]][] = [
    ['start position', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
    ['Kiwipete (castling, pins, en passant)', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
    ['position 3 (en passant pins, checks)', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
    ['position 4 (promotions, castling through attack)', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
    ['position 4 mirrored', 'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1', [6, 264, 9467]],
    ['position 5 (promotion with check, castling rights)', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
    ['position 6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
  ];
  for (const [name, fen, counts] of cases) {
    it(name, () => {
      const s = chessFromFen(fen);
      counts.forEach((n, i) => expect(chessPerft(s, i + 1), `depth ${i + 1}`).toBe(n));
    }, 120_000);
  }
});

describe('castling', () => {
  const open = 'r3k2r/8/8/8/8/8/8/R3K2R';
  it('both sides, both colours, moves the rook too', () => {
    const w = chessFromFen(`${open} w KQkq - 0 1`);
    expect(chessFen(chess.play(w, mv('e1g1'))!)).toBe('r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');
    expect(chessFen(chess.play(w, mv('e1c1'))!)).toBe('r3k2r/8/8/8/8/8/8/2KR3R b kq - 1 1');
    const b = chessFromFen(`${open} b KQkq - 0 1`);
    expect(chessFen(chess.play(b, mv('e8g8'))!)).toBe('r4rk1/8/8/8/8/8/8/R3K2R w KQ - 1 2');
    expect(chessFen(chess.play(b, mv('e8c8'))!)).toBe('2kr3r/8/8/8/8/8/8/R3K2R w KQ - 1 2');
    expect(chess.play(w, mv('e1g1'))!.san).toEqual(['O-O']);
    expect(chess.play(w, mv('e1c1'))!.san).toEqual(['O-O-O']);
  });
  it('needs the right: gone after the king or that rook has moved, even if they come back', () => {
    const s = chessFromFen(`${open} w KQkq - 0 1`);
    const kingMoved = playAll(s, 'e1e2 a8b8 e2e1 b8a8');
    expect(has(kingMoved, 'e1g1')).toBe(false);
    expect(has(kingMoved, 'e1c1')).toBe(false);
    expect(has(playAll(kingMoved, 'a1b1'), 'e8c8')).toBe(false); // Black's a-rook moved too
    expect(has(playAll(kingMoved, 'a1b1'), 'e8g8')).toBe(true);
    const rookMoved = playAll(s, 'h1g1 h8g8 g1h1 g8h8');
    expect(has(rookMoved, 'e1g1')).toBe(false);
    expect(has(rookMoved, 'e1c1')).toBe(true);
  });
  it('a captured rook ends the right', () => {
    const s = chessFromFen('r3k2r/8/8/8/8/8/6b1/R3K2R b KQkq - 0 1');
    const after = chess.play(s, mv('g2h1'))!;
    expect(after.c).toBe('Qkq');
    expect(has(after, 'e1g1')).toBe(false);
  });
  it('not out of check, not through an attacked square, not onto one', () => {
    expect(has(chessFromFen('4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1'), 'e1g1')).toBe(false); // in check
    expect(has(chessFromFen('4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1'), 'e1c1')).toBe(false);
    const through = chessFromFen('4k3/8/8/8/8/5r2/8/R3K2R w KQ - 0 1'); // f1 attacked
    expect(has(through, 'e1g1')).toBe(false);
    expect(has(through, 'e1c1')).toBe(true);
    const onto = chessFromFen('4k3/8/8/8/8/2r5/8/R3K2R w KQ - 0 1'); // c1 attacked
    expect(has(onto, 'e1c1')).toBe(false);
    expect(has(onto, 'e1g1')).toBe(true);
  });
  it('the rook may pass an attacked square (b1), and may itself be attacked', () => {
    expect(has(chessFromFen('4k3/8/8/8/8/1r6/8/R3K2R w KQ - 0 1'), 'e1c1')).toBe(true);
    expect(has(chessFromFen('4k3/8/8/8/8/8/8/R3K2r w Q - 0 1'), 'e1c1')).toBe(false); // that one is check
    expect(has(chessFromFen('4k3/8/8/8/r7/8/8/R3K2R w KQ - 0 1'), 'e1c1')).toBe(true); // a1 rook attacked
  });
  it('not with a piece in between', () => {
    const s = chessFromFen('r3k2r/8/8/8/8/8/8/RN2K1NR w KQkq - 0 1');
    expect(has(s, 'e1g1')).toBe(false);
    expect(has(s, 'e1c1')).toBe(false);
  });
});

describe('en passant', () => {
  it('only right after the two-square move, and removes the pawn', () => {
    let s = playAll(chess.init(2), 'e2e4 a7a6 e4e5 d7d5');
    expect(s.e).toBe(sq('d6'));
    expect(has(s, 'e5d6')).toBe(true);
    const took = chess.play(s, mv('e5d6'))!;
    expect(took.b[sq('d5')]).toBe('.');
    expect(took.b[sq('d6')]).toBe('P');
    expect(took.san[took.san.length - 1]).toBe('exd6');
    // Wait a move and the chance is gone.
    s = playAll(s, 'h2h3 h7h6');
    expect(has(s, 'e5d6')).toBe(false);
  });
  it('not when it would uncover check on the own king', () => {
    // White king a5, pawn b5; Black pawn c7 plays c5; rook h5 would then see the king.
    const s = chess.play(chessFromFen('8/2p5/8/KP5r/8/8/8/7k b - - 0 1'), mv('c7c5'))!;
    expect(s.e).toBe(sq('c6'));
    expect(has(s, 'b5c6')).toBe(false);
  });
});

describe('promotion', () => {
  it('offers queen, rook, bishop and knight and needs a choice', () => {
    const s = chessFromFen('3n4/4P3/8/8/8/8/8/K6k w - - 0 1');
    const to = chess.moves(s).filter((m) => m.f === sq('e7'));
    expect(to.map((m) => `${chessSquare(m.t)}${m.p}`).sort()).toEqual(['d8b', 'd8n', 'd8q', 'd8r', 'e8b', 'e8n', 'e8q', 'e8r']);
    expect(chess.play(s, mv('e7e8'))).toBeNull();
    expect(chess.play(s, mv('e7e8n'))!.b[sq('e8')]).toBe('N');
    expect(chess.play(s, mv('e7d8r'))!.san).toEqual(['exd8=R']);
    expect(chess.play(chessFromFen('8/8/8/8/8/8/4p3/K6k b - - 0 1'), mv('e2e1q'))!.b[sq('e1')]).toBe('q');
    // A promotion piece on a move that isn't a promotion is refused.
    expect(chess.play(chess.init(2), mv('e2e4q'))).toBeNull();
  });
});

describe('how games end', () => {
  it("fool's mate", () => {
    const s = playSan(chess.init(2), 'f3 e5 g4 Qh4#');
    expect(chess.outcome(s)).toEqual({ winner: 1, why: 'checkmate' });
    expect(chess.turn(s)).toBeNull();
    expect(chess.moves(s)).toEqual([]);
    expect(chess.play(s, mv('a2a3'))).toBeNull();
  });
  it('stalemate', () => {
    const s = chess.play(chessFromFen('7k/5K2/8/6Q1/8/8/8/8 w - - 0 1'), mv('g5g6'))!;
    expect(chessCheckSquare(s)).toBe(-1);
    expect(chess.outcome(s)).toEqual({ winner: null, why: 'stalemate' });
  });
  it('threefold repetition ends the game by itself', () => {
    let s = playAll(chess.init(2), 'g1f3 g8f6 f3g1 f6g8');
    expect(chess.outcome(s)).toBeNull(); // the start position has now occurred twice
    s = playAll(s, 'g1f3 g8f6 f3g1');
    expect(chess.outcome(s)).toBeNull();
    s = playAll(s, 'f6g8');
    expect(chess.outcome(s)).toEqual({ winner: null, why: 'repetition' });
  });
  it('a position with different castling rights is not the same position', () => {
    // The kings step out and back: same squares, but the rights are gone, so the count starts again.
    let s = playAll(chessFromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'), 'e1e2 e8e7 e2e1 e7e8');
    s = playAll(s, 'e1e2 e8e7 e2e1 e7e8');
    expect(chess.outcome(s)).toBeNull(); // with rights: once; without: twice
    // Third time round. After Ke2 the position has only occurred twice without Black's rights…
    s = playAll(s, 'e1e2');
    expect(chess.outcome(s)).toBeNull();
    // …but this one (kings on e2 and e7, White to move, no rights left) now occurs for the third time.
    s = playAll(s, 'e8e7');
    expect(chess.outcome(s)).toEqual({ winner: null, why: 'repetition' });
  });
  it('fifty-move rule: a hundred half-moves without a pawn move or capture', () => {
    let s = chessFromFen('7k/8/8/8/8/8/8/KQ6 w - - 98 80');
    s = chess.play(s, mv('b1b2'))!;
    expect(s.h).toBe(99);
    expect(chess.outcome(s)).toBeNull();
    s = chess.play(s, mv('h8g8'))!;
    expect(chess.outcome(s)).toEqual({ winner: null, why: 'fifty' });
    // A capture or a pawn move resets the count.
    expect(chess.play(chessFromFen('7k/8/8/8/8/8/P7/K7 w - - 99 80'), mv('a2a3'))!.h).toBe(0);
    expect(chess.play(chessFromFen('7k/8/8/8/8/8/p7/K7 w - - 99 80'), mv('a1a2'))!.h).toBe(0);
  });
  it('mate on the hundredth half-move still wins', () => {
    const s = chess.play(chessFromFen('7k/8/5K2/6Q1/8/8/8/8 w - - 99 80'), mv('g5g7'))!;
    expect(chess.outcome(s)).toEqual({ winner: 0, why: 'checkmate' });
  });
  it('insufficient material', () => {
    const dead = ['8/8/8/8/8/8/8/K6k w - - 0 1', '8/8/8/8/8/8/8/KN5k w - - 0 1', '8/8/8/8/8/8/8/KB5k b - - 0 1', '1b6/8/8/8/8/8/8/K1B4k w - - 0 1', '8/8/8/8/8/8/8/KB1B1b1k w - - 0 1'];
    for (const fen of dead) expect(chess.outcome(chessFromFen(fen)), fen).toEqual({ winner: null, why: 'material' });
    const alive = ['b7/8/8/8/8/8/8/K1B4k w - - 0 1', '8/8/8/8/8/8/8/KNN4k w - - 0 1', '8/8/8/8/8/8/8/KBB4k w - - 0 1', '8/8/8/8/8/8/8/KBn4k w - - 0 1', '8/8/8/8/8/8/P7/K6k w - - 0 1', '8/8/8/8/8/8/R7/K6k w - - 0 1'];
    for (const fen of alive) expect(chess.outcome(chessFromFen(fen)), fen).toBeNull();
    // Capturing the last pawn leaves bare kings.
    expect(chess.outcome(chess.play(chessFromFen('8/8/8/8/8/8/p7/K6k w - - 0 1'), mv('a1a2'))!)).toEqual({ winner: null, why: 'material' });
  });
});

describe('legality', () => {
  it('pinned pieces stay, checks must be answered', () => {
    const pinned = chessFromFen('4k3/4r3/8/8/8/8/4B3/4K3 w - - 0 1');
    expect(chess.moves(pinned).filter((m) => m.f === sq('e2')).map((m) => chessSquare(m.t)).sort()).toEqual([]);
    const check = chessFromFen('4k3/8/8/8/8/8/3PrP2/3QKB2 w - - 0 1');
    expect(chessCheckSquare(check)).toBe(sq('e1'));
    expect(chess.moves(check).map((m) => chessSquare(m.f) + chessSquare(m.t)).sort()).toEqual(['d1e2', 'e1e2', 'f1e2']);
  });
  it('refuses moves out of turn and moves that are not moves', () => {
    const s = chess.init(2);
    expect(chess.play(s, mv('e7e5'))).toBeNull();
    expect(chess.play(s, mv('e2e5'))).toBeNull();
    expect(chess.play(s, mv('a1a3'))).toBeNull();
    expect(chess.parseMove({ f: 12, t: 28, p: 'k' })).toBeNull();
    expect(chess.parseMove({ f: -1, t: 28 })).toBeNull();
    expect(chess.parseMove({ f: 1.5, t: 28 })).toBeNull();
    expect(chess.parseMove('e2e4')).toBeNull();
  });
  it('parse refuses malformed and impossible states', () => {
    const ok = chess.init(2);
    expect(chess.parse(JSON.parse(JSON.stringify(ok)), 2)).toEqual(ok);
    expect(chess.parse({ ...ok, b: ok.b.slice(1) }, 2)).toBeNull();
    expect(chess.parse({ ...ok, b: ok.b.replace('k', 'q') }, 2)).toBeNull(); // no black king
    expect(chess.parse({ ...ok, b: ok.b.replace('.', 'K') }, 2)).toBeNull(); // two white kings
    expect(chess.parse({ ...ok, c: 'KQkqx' }, 2)).toBeNull();
    expect(chess.parse({ ...ok, b: ok.b.replace(/R$/, '.') }, 2)).toBeNull(); // right without the rook
    expect(chess.parse({ ...ok, e: 20 }, 2)).toBeNull(); // no pawn in front of the en passant square
    expect(chess.parse({ ...ok, t: 2 }, 2)).toBeNull();
    expect(chess.parse({ ...ok, san: ['<b>'] }, 2)).toBeNull();
    // The side that just moved is in check: can't be a real position.
    expect(chess.parse({ ...chessFromFen('4k3/8/8/8/8/8/8/4K2r w - - 0 1'), t: 1 }, 2)).toBeNull();
    expect(chess.parse(null, 2)).toBeNull();
  });
});

describe('notation', () => {
  it('disambiguates by file, rank or both', () => {
    expect(chess.play(chessFromFen('7k/8/8/8/8/8/8/KN3N2 w - - 0 1'), mv('b1d2'))!.san).toEqual(['Nbd2']);
    expect(chess.play(chessFromFen('7k/8/8/R7/8/8/8/R5K1 w - - 0 1'), mv('a1a3'))!.san).toEqual(['R1a3']);
    expect(chess.play(chessFromFen('6k1/8/8/8/4Q2Q/8/8/K6Q w - - 0 1'), mv('h4e1'))!.san).toEqual(['Qh4e1']);
    // A pinned twin can't go there, so no hint is needed.
    expect(chess.play(chessFromFen('4r2k/8/8/8/8/8/4N3/4K1N1 w - - 0 1'), mv('g1f3'))!.san).toEqual(['Nf3']);
  });
  it('marks captures, checks and mate', () => {
    const s = playAll(chess.init(2), 'e2e4 d7d5 e4d5 d8d5 b1c3 d5e5');
    expect(s.san).toEqual(['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qe5+']);
  });
});

describe('whole games', () => {
  it('the Opera Game (Morphy, 1858)', () => {
    const s = playSan(chess.init(2), `e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5
      Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#`);
    expect(chess.outcome(s)).toEqual({ winner: 0, why: 'checkmate' });
    expect(chessFen(s)).toBe('1n1Rkb1r/p4ppp/4q3/4p1B1/4P3/8/PPP2PPP/2K5 b k - 1 17');
    expect(s.san).toHaveLength(33);
  });
  it('a game with castling by both sides, en passant and promotions by both sides', () => {
    const s = playSan(chess.init(2), `e4 a6 e5 d5 exd6 Nc6 dxc7 Nf6 Nf3 e6 Bc4 Be7 O-O O-O cxd8=N a5 Nxc6 bxc6 d4 a4 Bg5 a3
      Bxf6 axb2 Bxe7 bxa1=Q Bxf8 Kxf8 Qd3 Qxb1 Rxb1 Ke7 Rb8 Ra3 Rxc8 Rxd3 cxd3 Kd6 Ne5 f6 Nf7+ Ke7 Rc7+ Kf8 Bxe6 g6 Rc8+ Kg7`);
    expect(chess.outcome(s)).toBeNull();
    expect(chessFen(s)).toBe('2R5/5Nkp/2p1Bpp1/8/3P4/3P4/P4PPP/6K1 w - - 2 25');
    expect(s.san.filter((x) => x === 'O-O')).toHaveLength(2);
    expect(s.san).toContain('exd6');
    expect(s.san).toContain('cxd8=N');
    expect(s.san).toContain('bxa1=Q');
  });
  it('states are plain JSON and survive a round trip at every move', () => {
    let s = chess.init(2);
    for (const san of 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7'.split(' ')) {
      s = playSan(s, san);
      expect(chess.parse(JSON.parse(JSON.stringify(s)), 2)).toEqual(s);
    }
  });
});
