// Chess with the full rules: legal move generation, check, checkmate, stalemate, castling on both sides
// (king and rook unmoved, squares between them empty, the king not in check and not passing through or
// landing on an attacked square), en passant, promotion to a chosen piece, and draws by threefold
// repetition, the fifty-move rule and insufficient material. Moves are recorded in algebraic notation.
//
// Decisions for play by message: threefold repetition and the fifty-move rule end the game by themselves
// (nobody has to claim them), so every device agrees on the result without a judge. Draws by agreement and
// resignation are handled one level up (lib/games/match.ts), the same for every game.
//
// Squares are numbered 0–63 in FEN order: a8 = 0, h8 = 7, a1 = 56, h1 = 63 (row 0 is rank 8). Pieces use
// the FEN letters (upper case white, lower case black) and '.' for an empty square.
import { isBoard, isInt, isObj, type GameEngine, type Outcome } from './types';

export type Promotion = 'q' | 'r' | 'b' | 'n';
export interface ChessMove { f: number; t: number; p?: Promotion }

export interface ChessState {
  b: string;
  /** 0 = White to move, 1 = Black. */
  t: 0 | 1;
  /** Castling rights still held: a subset of "KQkq", in that order. */
  c: string;
  /** The square a pawn just skipped with a two-square move (the en passant target), or -1. */
  e: number;
  /** Half-moves since the last capture or pawn move (fifty-move rule: draw at 100). */
  h: number;
  /** Full-move number, starting at 1. */
  f: number;
  /** Fingerprints of the positions since the last capture or pawn move, this one included (repetition). */
  r: string[];
  /** The moves so far in algebraic notation. */
  san: string[];
  /** From and to squares of the last move ([] before the first). */
  last: number[];
}

interface Pos { sq: string[]; white: boolean; c: string; e: number }

const FILES = 'abcdefgh';
export const chessSquare = (i: number) => `${FILES[i & 7]}${8 - (i >> 3)}`;

const isWhite = (ch: string) => ch >= 'A' && ch <= 'Z';
const isBlack = (ch: string) => ch >= 'a' && ch <= 'z';
const mine = (ch: string, white: boolean) => (white ? isWhite(ch) : isBlack(ch));
const theirs = (ch: string, white: boolean) => (white ? isBlack(ch) : isWhite(ch));

type Delta = readonly [number, number];
const KNIGHT: readonly Delta[] = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const DIAG: readonly Delta[] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ORTH: readonly Delta[] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const ALL: readonly Delta[] = [...DIAG, ...ORTH];
const PROMOS: readonly Promotion[] = ['q', 'r', 'b', 'n'];

/** Is square `at` attacked by a piece of the given colour? */
function attacked(sq: string[], at: number, byWhite: boolean): boolean {
  const r = at >> 3, c = at & 7;
  // A white pawn attacks one row up the board (towards row 0), so it sits one row below its target.
  const pr = byWhite ? r + 1 : r - 1;
  if (pr >= 0 && pr <= 7) {
    const pawn = byWhite ? 'P' : 'p';
    if (c > 0 && sq[pr * 8 + c - 1] === pawn) return true;
    if (c < 7 && sq[pr * 8 + c + 1] === pawn) return true;
  }
  const knight = byWhite ? 'N' : 'n';
  for (const [dr, dc] of KNIGHT) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7 && sq[rr * 8 + cc] === knight) return true;
  }
  const king = byWhite ? 'K' : 'k';
  for (const [dr, dc] of ALL) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7 && sq[rr * 8 + cc] === king) return true;
  }
  const queen = byWhite ? 'Q' : 'q';
  const slide = (dirs: readonly Delta[], piece: string) => {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7) {
        const ch = sq[rr * 8 + cc]!;
        if (ch !== '.') { if (ch === piece || ch === queen) return true; break; }
        rr += dr; cc += dc;
      }
    }
    return false;
  };
  return slide(DIAG, byWhite ? 'B' : 'b') || slide(ORTH, byWhite ? 'R' : 'r');
}

const kingSquare = (sq: string[], white: boolean) => sq.indexOf(white ? 'K' : 'k');
const inCheck = (p: Pos) => { const k = kingSquare(p.sq, p.white); return k >= 0 && attacked(p.sq, k, !p.white); };

/** Moves that follow how the pieces move, before checking that the mover's king is left safe. */
function pseudoMoves(p: Pos): ChessMove[] {
  const { sq, white } = p;
  const out: ChessMove[] = [];
  const add = (f: number, t: number) => { out.push({ f, t }); };
  for (let f = 0; f < 64; f++) {
    const ch = sq[f]!;
    if (!mine(ch, white)) continue;
    const r = f >> 3, c = f & 7;
    const kind = ch.toLowerCase();
    if (kind === 'p') {
      const dir = white ? -1 : 1;
      const nr = r + dir;
      if (nr < 0 || nr > 7) continue;
      const pawnTo = (t: number) => { if (nr === (white ? 0 : 7)) for (const pr of PROMOS) out.push({ f, t, p: pr }); else add(f, t); };
      if (sq[nr * 8 + c] === '.') {
        pawnTo(nr * 8 + c);
        if (r === (white ? 6 : 1) && sq[(r + 2 * dir) * 8 + c] === '.') add(f, (r + 2 * dir) * 8 + c);
      }
      for (const dc of [-1, 1]) {
        const cc = c + dc;
        if (cc < 0 || cc > 7) continue;
        const t = nr * 8 + cc;
        if (theirs(sq[t]!, white) || (t === p.e && sq[t] === '.')) pawnTo(t);
      }
    } else if (kind === 'n' || kind === 'k') {
      for (const [dr, dc] of kind === 'n' ? KNIGHT : ALL) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7 && !mine(sq[rr * 8 + cc]!, white)) add(f, rr * 8 + cc);
      }
    } else {
      for (const [dr, dc] of kind === 'b' ? DIAG : kind === 'r' ? ORTH : ALL) {
        let rr = r + dr, cc = c + dc;
        while (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7) {
          const t = rr * 8 + cc;
          if (mine(sq[t]!, white)) break;
          add(f, t);
          if (sq[t] !== '.') break;
          rr += dr; cc += dc;
        }
      }
    }
  }
  // Castling: the king's square, the square it crosses and the square it lands on must not be attacked.
  const home = white ? 60 : 4;
  if (sq[home] === (white ? 'K' : 'k') && !attacked(sq, home, !white)) {
    const rook = white ? 'R' : 'r';
    if (p.c.includes(white ? 'K' : 'k') && sq[home + 3] === rook && sq[home + 1] === '.' && sq[home + 2] === '.'
      && !attacked(sq, home + 1, !white) && !attacked(sq, home + 2, !white)) add(home, home + 2);
    if (p.c.includes(white ? 'Q' : 'q') && sq[home - 4] === rook && sq[home - 1] === '.' && sq[home - 2] === '.' && sq[home - 3] === '.'
      && !attacked(sq, home - 1, !white) && !attacked(sq, home - 2, !white)) add(home, home - 2);
  }
  return out;
}

/** The position after a (pseudo-legal) move. `info` reports what the move did, for the clocks and notation. */
function make(p: Pos, m: ChessMove, info?: { capture: boolean; pawn: boolean }): Pos {
  const sq = [...p.sq];
  const piece = sq[m.f]!;
  const kind = piece.toLowerCase();
  const white = p.white;
  let capture = sq[m.t] !== '.';
  let c = p.c;
  let e = -1;
  sq[m.f] = '.';
  if (kind === 'p') {
    if (m.t === p.e && !capture) { sq[m.t + (white ? 8 : -8)] = '.'; capture = true; } // en passant
    if (Math.abs(m.t - m.f) === 16) e = (m.f + m.t) / 2;
    sq[m.t] = m.p ? (white ? m.p.toUpperCase() : m.p) : piece;
  } else {
    sq[m.t] = piece;
    if (kind === 'k') {
      c = c.replace(white ? /[KQ]/g : /[kq]/g, '');
      if (m.t - m.f === 2) { sq[m.t - 1] = sq[m.t + 1]!; sq[m.t + 1] = '.'; } // king side: the rook jumps over
      if (m.f - m.t === 2) { sq[m.t + 1] = sq[m.t - 2]!; sq[m.t - 2] = '.'; } // queen side
    }
  }
  // A rook that moves, or is captured, on its corner ends that castling right.
  for (const [corner, right] of [[63, 'K'], [56, 'Q'], [7, 'k'], [0, 'q']] as const) {
    if (m.f === corner || m.t === corner) c = c.replace(right, '');
  }
  if (info) { info.capture = capture; info.pawn = kind === 'p'; }
  return { sq, white: !white, c, e };
}

function legalMoves(p: Pos): ChessMove[] {
  return pseudoMoves(p).filter((m) => {
    const next = make(p, m);
    const k = kingSquare(next.sq, p.white);
    return k >= 0 && !attacked(next.sq, k, !p.white);
  });
}

const posOf = (s: ChessState): Pos => ({ sq: [...s.b], white: s.t === 0, c: s.c, e: s.e });

/** A short fingerprint of a position for the repetition rule: the same for every device. */
function fingerprint(p: Pos, legal: ChessMove[]): string {
  // The en passant square only makes a position different when the capture can really be played.
  const ep = p.e >= 0 && legal.some((m) => m.t === p.e && p.sq[m.f]!.toLowerCase() === 'p') ? p.e : -1;
  const text = `${p.sq.join('')}${p.white ? 'w' : 'b'}${p.c}|${ep}`;
  let a = 0x811c9dc5, b = 5381;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    a = Math.imul(a ^ ch, 0x01000193) >>> 0;
    b = (Math.imul(b, 33) + ch) >>> 0;
  }
  return a.toString(36) + '.' + b.toString(36);
}

function insufficient(sq: string[]): boolean {
  const minors: number[] = [];
  for (let i = 0; i < 64; i++) {
    const k = sq[i]!.toLowerCase();
    if (k === '.' || k === 'k') continue;
    if (k !== 'b' && k !== 'n') return false;
    minors.push(i);
  }
  if (minors.length <= 1) return true; // bare kings, or one knight or bishop
  // Only bishops, all on squares of one colour: nobody can ever be mated.
  if (minors.some((i) => sq[i]!.toLowerCase() !== 'b')) return false;
  const shade = (i: number) => ((i >> 3) + (i & 7)) % 2;
  return minors.every((i) => shade(i) === shade(minors[0]!));
}

function outcome(s: ChessState): Outcome | null {
  const p = posOf(s);
  if (!legalMoves(p).length) return inCheck(p) ? { winner: 1 - s.t, why: 'checkmate' } : { winner: null, why: 'stalemate' };
  if (insufficient(p.sq)) return { winner: null, why: 'material' };
  const now = s.r[s.r.length - 1];
  if (now !== undefined && s.r.filter((k) => k === now).length >= 3) return { winner: null, why: 'repetition' };
  if (s.h >= 100) return { winner: null, why: 'fifty' };
  return null;
}

/** Algebraic notation for a legal move in position `p` (without the check or mate mark). */
function notation(p: Pos, m: ChessMove, legal: ChessMove[], capture: boolean): string {
  const piece = p.sq[m.f]!;
  const kind = piece.toLowerCase();
  if (kind === 'k' && Math.abs(m.t - m.f) === 2) return m.t > m.f ? 'O-O' : 'O-O-O';
  const to = chessSquare(m.t);
  if (kind === 'p') return `${capture ? `${FILES[m.f & 7]}x` : ''}${to}${m.p ? `=${m.p.toUpperCase()}` : ''}`;
  // Name the file, the rank or both when another piece of the same kind could go to the same square.
  const rivals = legal.filter((x) => x.t === m.t && x.f !== m.f && p.sq[x.f] === piece);
  let from = '';
  if (rivals.length) {
    if (!rivals.some((x) => (x.f & 7) === (m.f & 7))) from = FILES[m.f & 7]!;
    else if (!rivals.some((x) => (x.f >> 3) === (m.f >> 3))) from = String(8 - (m.f >> 3));
    else from = chessSquare(m.f);
  }
  return `${kind.toUpperCase()}${from}${capture ? 'x' : ''}${to}`;
}

const sameMove = (a: ChessMove, b: ChessMove) => a.f === b.f && a.t === b.t && (a.p ?? '') === (b.p ?? '');

function play(s: ChessState, m: ChessMove): ChessState | null {
  if (outcome(s)) return null;
  const p = posOf(s);
  const legal = legalMoves(p);
  if (!legal.some((x) => sameMove(x, m))) return null;
  const info = { capture: false, pawn: false };
  const next = make(p, m, info);
  const replies = legalMoves(next);
  const san = notation(p, m, legal, info.capture) + (inCheck(next) ? (replies.length ? '+' : '#') : '');
  const irreversible = info.capture || info.pawn;
  return {
    b: next.sq.join(''), t: next.white ? 0 : 1, c: next.c, e: next.e,
    h: irreversible ? 0 : s.h + 1,
    f: s.t === 1 ? s.f + 1 : s.f,
    r: [...(irreversible ? [] : s.r), fingerprint(next, replies)],
    san: [...s.san, san],
    last: [m.f, m.t],
  };
}

/** A state from a FEN string (for tests and for setting up positions); throws on a malformed one. */
export function chessFromFen(fen: string): ChessState {
  const [board = '', turn = 'w', castle = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/);
  const rows = board.split('/');
  if (rows.length !== 8) throw new Error('bad FEN');
  const b = rows.map((row) => row.replace(/\d/g, (d) => '.'.repeat(Number(d)))).join('');
  const e = ep === '-' ? -1 : FILES.indexOf(ep[0]!) + (8 - Number(ep[1])) * 8;
  const c = castle === '-' ? '' : [...'KQkq'].filter((x) => castle.includes(x)).join('');
  const s = chess.parse({ b, t: turn === 'w' ? 0 : 1, c, e, h: Number(half), f: Number(full), r: [], san: [], last: [] }, 2);
  if (!s) throw new Error('bad FEN');
  const p = posOf(s);
  return { ...s, r: [fingerprint(p, legalMoves(p))] };
}

export function chessFen(s: ChessState): string {
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) rows.push(s.b.slice(r * 8, r * 8 + 8).replace(/\.+/g, (d) => String(d.length)));
  return `${rows.join('/')} ${s.t === 0 ? 'w' : 'b'} ${s.c || '-'} ${s.e < 0 ? '-' : chessSquare(s.e)} ${s.h} ${s.f}`;
}

/** Number of move sequences of this length from the position (the standard move-generator test). */
export function chessPerft(s: ChessState, depth: number): number {
  const walk = (p: Pos, d: number): number => {
    const legal = legalMoves(p);
    if (d === 1) return legal.length;
    let n = 0;
    for (const m of legal) n += walk(make(p, m), d - 1);
    return n;
  };
  return depth <= 0 ? 1 : walk(posOf(s), depth);
}

/** The square of the king that is in check right now, or -1. */
export function chessCheckSquare(s: ChessState): number {
  const p = posOf(s);
  return inCheck(p) ? kingSquare(p.sq, p.white) : -1;
}

const START = 'rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR';

export const chess: GameEngine<ChessState, ChessMove> = {
  kind: 'chess',
  players: { min: 2, max: 2 },
  init() {
    const p: Pos = { sq: [...START], white: true, c: 'KQkq', e: -1 };
    return { b: START, t: 0, c: 'KQkq', e: -1, h: 0, f: 1, r: [fingerprint(p, legalMoves(p))], san: [], last: [] };
  },
  parse(x) {
    if (!isObj(x) || !isBoard(x.b, 64, '.PNBRQKpnbrqk') || (x.t !== 0 && x.t !== 1)) return null;
    if (typeof x.c !== 'string' || !/^K?Q?k?q?$/.test(x.c)) return null;
    if (!isInt(x.e, -1, 63) || !isInt(x.h, 0, 100) || !isInt(x.f, 1, 100_000)) return null;
    if (!Array.isArray(x.r) || x.r.length > 101 || !x.r.every((k) => typeof k === 'string' && k.length <= 20)) return null;
    if (!Array.isArray(x.san) || x.san.length > 20_000 || !x.san.every((k) => typeof k === 'string' && /^[a-hKQRBNO1-8x=+#-]{2,8}$/.test(k))) return null;
    if (!Array.isArray(x.last) || !(x.last.length === 0 || x.last.length === 2) || !x.last.every((v) => isInt(v, 0, 63))) return null;
    const b = x.b;
    // Exactly one king each, no pawns on the first or last rank.
    if (b.split('K').length !== 2 || b.split('k').length !== 2 || /[Pp]/.test(b.slice(0, 8) + b.slice(56))) return null;
    // Castling rights need the king and rook at home.
    const at = (i: number, ch: string) => b[i] === ch;
    if ((x.c.includes('K') && !(at(60, 'K') && at(63, 'R'))) || (x.c.includes('Q') && !(at(60, 'K') && at(56, 'R')))
      || (x.c.includes('k') && !(at(4, 'k') && at(7, 'r'))) || (x.c.includes('q') && !(at(4, 'k') && at(0, 'r')))) return null;
    // An en passant square sits behind a pawn of the side that just moved, on an empty square.
    if (x.e >= 0) {
      const row = x.e >> 3;
      if (row !== (x.t === 0 ? 2 : 5) || b[x.e] !== '.' || b[x.e + (x.t === 0 ? 8 : -8)] !== (x.t === 0 ? 'p' : 'P')) return null;
    }
    const s: ChessState = { b, t: x.t, c: x.c, e: x.e, h: x.h, f: x.f, r: [...(x.r as string[])], san: [...(x.san as string[])], last: [...(x.last as number[])] };
    // The side that just moved can't have left its own king in check.
    const p = posOf(s);
    if (attacked(p.sq, kingSquare(p.sq, !p.white), p.white)) return null;
    return s;
  },
  parseMove(x) {
    if (!isObj(x) || !isInt(x.f, 0, 63) || !isInt(x.t, 0, 63)) return null;
    if (x.p === undefined) return { f: x.f, t: x.t };
    return typeof x.p === 'string' && (PROMOS as readonly string[]).includes(x.p) ? { f: x.f, t: x.t, p: x.p as Promotion } : null;
  },
  turn: (s) => (outcome(s) ? null : s.t),
  moves: (s) => (outcome(s) ? [] : legalMoves(posOf(s))),
  play,
  outcome,
};
