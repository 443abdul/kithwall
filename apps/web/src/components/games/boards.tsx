'use client';
// One board per game. Grid games only describe themselves (a GridSpec for Board.tsx); Dots and Boxes,
// Mancala and Ludo draw their own boards with the same keyboard handling. `BOARDS` is what the rest of
// the app uses: adding a game means adding its engine (lib/games) and one entry here.
import { useRef, type ComponentType, type ReactNode } from 'react';
import { useT, type MessageKey, type TFunction } from '@/i18n';
import type { GameKind } from '@/lib/games/types';
import { tttLine, type TttMove, type TttState } from '@/lib/games/tictactoe';
import { c4Landing, c4Line, C4_COLS, C4_ROWS, type C4Move, type C4State } from '@/lib/games/connect4';
import { reversiCount, type ReversiMove, type ReversiState } from '@/lib/games/reversi';
import { GOMOKU_SIZE, gomokuLine, type GomokuMove, type GomokuState } from '@/lib/games/gomoku';
import { type CheckersMove, type CheckersState } from '@/lib/games/checkers';
import { chess, chessCheckSquare, chessSquare, type ChessMove, type ChessState } from '@/lib/games/chess';
import { DOTS_N, dotsScore, type DotsMove, type DotsState } from '@/lib/games/dots';
import { type MancalaMove, type MancalaState } from '@/lib/games/mancala';
import { ludoCorner, ludoSquare, LUDO_HOME, LUDO_SAFE, type LudoMove, type LudoState } from '@/lib/games/ludo';
import { cx } from '@/components/ui/cx';
import { GridBoard, useArrowKeys, type BoardProps, type GridSpec } from './Board';
import { ChessPiece, Disc, LudoPiece, Mark, Star } from './pieces';

const cellName = (cols: number) => (i: number, t: TFunction) => t('games.cell', { row: Math.floor(i / cols) + 1, col: (i % cols) + 1 });

// ---------------------------------------------------------------------------------------------
// Grid games

const tttSpec: GridSpec<TttState, TttMove> = {
  rows: 3, cols: 3, look: 'paper', hints: false,
  piece: (s, i) => (s.b[i] === '.' ? null : <Mark seat={Number(s.b[i])} />),
  what: (s, i) => (s.b[i] === '.' ? '' : s.b[i] === '0' ? 'X' : 'O'),
  name: cellName(3),
  path: (m) => [m.c],
  marks: (s) => ({ win: tttLine(s) ?? [] }),
};

const c4Spec: GridSpec<C4State, C4Move> = {
  rows: C4_ROWS, cols: C4_COLS, look: 'well',
  piece: (s, i) => (s.b[i] === '.' ? null : <Disc seat={Number(s.b[i])} look="drop" />),
  what: (s, i, t) => (s.b[i] === '.' ? '' : t(s.b[i] === '0' ? 'games.piece.drop0' : 'games.piece.drop1')),
  name: cellName(C4_COLS),
  path: (m, s) => [c4Landing(s.b, m.c)],
  // A tap anywhere in a column drops the disc into it.
  alias: (s, i) => { const at = c4Landing(s.b, i % C4_COLS); return at < 0 ? i : at; },
  marks: (s) => ({ last: s.last >= 0 ? [s.last] : [], win: c4Line(s) ?? [] }),
};

const stone = (ch: string | undefined, t: TFunction) => (ch === '0' ? t('games.piece.stone0') : ch === '1' ? t('games.piece.stone1') : '');

const reversiSpec: GridSpec<ReversiState, ReversiMove> = {
  rows: 8, cols: 8, look: 'felt',
  piece: (s, i) => (s.b[i] === '.' ? null : <Disc seat={Number(s.b[i])} look="stone" />),
  what: (s, i, t) => stone(s.b[i], t),
  name: (i) => chessSquare(i),
  path: (m) => [m.c],
  marks: (s) => ({ last: s.last >= 0 ? [s.last] : [] }),
};

const gomokuSpec: GridSpec<GomokuState, GomokuMove> = {
  rows: GOMOKU_SIZE, cols: GOMOKU_SIZE, look: 'goban', hints: false,
  piece: (s, i) => (s.b[i] === '.' ? null : <Disc seat={Number(s.b[i])} look="stone" />),
  what: (s, i, t) => stone(s.b[i], t),
  name: cellName(GOMOKU_SIZE),
  path: (m) => [m.c],
  marks: (s) => ({ last: s.last >= 0 ? [s.last] : [], win: gomokuLine(s) ?? [] }),
};

const MAN: Record<string, MessageKey> = { b: 'games.piece.man0', B: 'games.piece.king0', w: 'games.piece.man1', W: 'games.piece.king1' };

const checkersSpec: GridSpec<CheckersState, CheckersMove> = {
  rows: 8, cols: 8, look: 'check', flips: true,
  piece: (s, i) => (s.b[i] === '.' ? null : <Disc seat={s.b[i]!.toLowerCase() === 'b' ? 0 : 1} look="man" king={s.b[i] === 'B' || s.b[i] === 'W'} />),
  what: (s, i, t) => (MAN[s.b[i]!] ? t(MAN[s.b[i]!]!) : ''),
  name: (i) => chessSquare(i),
  path: (m) => m.p,
  marks: (s) => ({ last: s.last }),
};

const chessSpec: GridSpec<ChessState, ChessMove> = {
  rows: 8, cols: 8, look: 'check', flips: true, coords: true,
  piece: (s, i) => (s.b[i] === '.' ? null : <ChessPiece piece={s.b[i]!} />),
  what: (s, i, t) => (s.b[i] === '.' ? '' : t(`games.piece.${s.b[i]! === s.b[i]!.toUpperCase() ? 'w' : 'b'}${s.b[i]!.toLowerCase()}` as MessageKey)),
  name: (i) => chessSquare(i),
  path: (m) => [m.f, m.t],
  option: (m, t) => ({ key: m.p ?? 'x', label: t(`games.promote.${m.p ?? 'q'}` as MessageKey), node: <ChessPiece piece={m.t < 8 ? (m.p ?? 'q').toUpperCase() : (m.p ?? 'q')} /> }),
  marks: (s) => ({ last: s.last, alert: chessCheckSquare(s) }),
};

function grid<S, M>(spec: GridSpec<S, M>, kind: GameKind): ComponentType<BoardProps> {
  function Game(props: BoardProps) {
    const t = useT();
    return <GridBoard {...(props as unknown as BoardProps<S, M>)} spec={spec} label={t('games.board.label', { game: t(`games.kind.${kind}` as MessageKey) })} />;
  }
  Game.displayName = `Board(${kind})`;
  return Game;
}

// ---------------------------------------------------------------------------------------------
// Dots and Boxes: dots, the lines between them (buttons while undrawn) and the boxes they close.

const dotName = (r: number, c: number) => `${'ABCDEF'[r]}${c + 1}`;

function DotsBoard({ state, moves, onMove, mini, names }: BoardProps<DotsState, DotsMove>) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const keys = useArrowKeys(root);
  const open = new Set(moves.map((m) => m.e));
  const size = 2 * DOTS_N + 1;
  const cells: ReactNode[] = [];
  let first = true;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const key = `${r}-${c}`;
      if (r % 2 === 0 && c % 2 === 0) { cells.push(<span key={key} className="k-gm-dots-dot" />); continue; }
      if (r % 2 === 1 && c % 2 === 1) {
        const o = state.o[((r - 1) / 2) * DOTS_N + (c - 1) / 2];
        cells.push(<span key={key} className={cx('k-gm-dots-box', o === '0' && 'is-0', o === '1' && 'is-1')}>{o === '.' || mini ? null : Array.from(names[Number(o)] ?? '')[0]?.toLocaleUpperCase()}</span>);
        continue;
      }
      const horizontal = r % 2 === 0;
      const e = horizontal ? (r / 2) * DOTS_N + (c - 1) / 2 : (DOTS_N + 1) * DOTS_N + ((r - 1) / 2) * (DOTS_N + 1) + c / 2;
      const by = state.l[e];
      const cls = cx('k-gm-dots-line', horizontal ? 'is-h' : 'is-v', by === '0' && 'is-0', by === '1' && 'is-1', state.last === e && 'is-last');
      if (mini || by !== '.') { cells.push(<span key={key} className={cls} />); continue; }
      const label = horizontal
        ? t('games.dots.line', { a: dotName(r / 2, (c - 1) / 2), b: dotName(r / 2, (c + 1) / 2) })
        : t('games.dots.line', { a: dotName((r - 1) / 2, c / 2), b: dotName((r + 1) / 2, c / 2) });
      cells.push(
        <button key={key} type="button" className={cx(cls, open.has(e) && 'is-open')} data-r={r} data-c={c} tabIndex={first ? 0 : -1}
          aria-label={label} aria-disabled={!open.has(e) || undefined} onClick={() => { if (open.has(e)) onMove({ e }); }} />,
      );
      first = false;
    }
  }
  return (
    <div ref={root} className={cx('k-gm-dots', mini && 'is-mini')} dir="ltr" role={mini ? undefined : 'group'} aria-hidden={mini || undefined}
      aria-label={mini ? undefined : t('games.board.label', { game: t('games.kind.dots') })} onKeyDown={mini ? undefined : keys.onKeyDown} onFocus={mini ? undefined : keys.onFocus}>
      {cells}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Mancala: my six pits along the bottom (sowing goes to the right, into my store), the other
// player's along the top.

function Seeds({ n }: { n: number }) {
  return <span className="k-gm-seeds" aria-hidden>{Array.from({ length: Math.min(n, 12) }, (_, i) => <i key={i} />)}</span>;
}

function MancalaBoard({ state, me, moves, onMove, mini, names }: BoardProps<MancalaState, MancalaMove>) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const keys = useArrowKeys(root);
  const mine = me === 1 ? 1 : 0;
  const other = 1 - mine;
  const can = new Set(moves.map((m) => m.i));
  const store = (side: number) => (
    <div className={cx('k-gm-store', side === mine ? 'is-mine' : 'is-theirs', `is-${side}`)}
      role={mini ? undefined : 'img'} aria-label={mini ? undefined : t('games.mancala.store', { name: names[side] ?? '', count: state.p[side * 7 + 6]! })}>
      <b aria-hidden>{state.p[side * 7 + 6]}</b>
    </div>
  );
  const pit = (side: number, i: number, row: number, col: number) => {
    const at = side * 7 + i;
    const n = state.p[at]!;
    const cls = cx('k-gm-pit', `is-${side}`, state.last === at && 'is-last', side === mine && can.has(i) && 'is-next');
    const inner = <><b aria-hidden>{n}</b>{mini ? null : <Seeds n={n} />}</>;
    if (mini) return <span key={at} className={cls}>{inner}</span>;
    const label = t('games.mancala.pit', { name: names[side] ?? '', n: i + 1, count: n });
    const playable = side === mine && can.has(i);
    return (
      <button key={at} type="button" className={cls} data-r={row} data-c={col} tabIndex={row === 1 && col === 0 ? 0 : -1}
        aria-label={playable ? t('games.sq.target', { label }) : label} aria-disabled={!playable || undefined}
        onClick={() => { if (playable) onMove({ i }); }}>{inner}</button>
    );
  };
  return (
    <div ref={root} className={cx('k-gm-mancala', mini && 'is-mini')} dir="ltr" role={mini ? undefined : 'group'} aria-hidden={mini || undefined}
      aria-label={mini ? undefined : t('games.board.label', { game: t('games.kind.mancala') })} onKeyDown={mini ? undefined : keys.onKeyDown} onFocus={mini ? undefined : keys.onFocus}>
      {store(other)}
      <div className="k-gm-pits">
        {[5, 4, 3, 2, 1, 0].map((i, col) => pit(other, i, 0, col))}
        {[0, 1, 2, 3, 4, 5].map((i, col) => pit(mine, i, 1, col))}
      </div>
      {store(mine)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Ludo: the classic cross on a 15 × 15 grid. Track square 0 is the first corner's start square;
// squares run clockwise.

const TRACK: readonly (readonly [number, number])[] = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 7], [0, 8],
  [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14], [7, 14], [8, 14],
  [8, 13], [8, 12], [8, 11], [8, 10], [8, 9], [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], [14, 7], [14, 6],
  [13, 6], [12, 6], [11, 6], [10, 6], [9, 6], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0], [7, 0], [6, 0],
];
/** Home columns by corner, from the track inwards, ending on the home triangle. */
const COLUMN: readonly (readonly (readonly [number, number])[])[] = [
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6.1]],
  [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6.1, 7]],
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 7.9]],
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [7.9, 7]],
];
const YARD: readonly (readonly [number, number])[] = [[0, 0], [0, 9], [9, 9], [9, 0]];
const SPOT: readonly (readonly [number, number])[] = [[1.5, 1.5], [1.5, 3.5], [3.5, 1.5], [3.5, 3.5]];

/** Where a piece stands on the 15 × 15 board, as [row, column] of its cell. */
function ludoPlace(n: number, seat: number, k: number, pos: number): readonly [number, number] {
  const corner = ludoCorner(n, seat);
  if (pos < 0) return [YARD[corner]![0] + SPOT[k]![0], YARD[corner]![1] + SPOT[k]![1]];
  if (pos <= 50) return TRACK[ludoSquare(n, seat, pos)]!;
  return COLUMN[corner]![pos - 51]!;
}

function LudoBoard({ state, me, moves, onMove, mini, names, roll }: BoardProps<LudoState, LudoMove>) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const keys = useArrowKeys(root);
  const can = new Set(moves.map((m) => m.k));
  const corners = Array.from({ length: state.n }, (_, seat) => ludoCorner(state.n, seat));
  // Pieces that share a cell are drawn smaller, side by side.
  const pieces: { seat: number; k: number; pos: number; at: readonly [number, number] }[] = [];
  state.tok.forEach((row, seat) => { if (!state.out.includes(seat)) row.forEach((pos, k) => pieces.push({ seat, k, pos, at: ludoPlace(state.n, seat, k, pos) })); });
  const crowd = new Map<string, number>();
  const where = (p: { at: readonly [number, number] }) => `${p.at[0]},${p.at[1]}`;
  for (const p of pieces) crowd.set(where(p), (crowd.get(where(p)) ?? 0) + 1);
  const seenAt = new Map<string, number>();
  const posText = (pos: number) => (pos < 0 ? t('games.ludo.at.yard') : pos === LUDO_HOME ? t('games.ludo.at.home') : pos > 50 ? t('games.ludo.at.column', { n: LUDO_HOME - pos }) : t('games.ludo.at.track', { n: pos + 1 }));
  let first = true;
  return (
    <div ref={root} className={cx('k-gm-ludo-board', mini && 'is-mini')} dir="ltr" role={mini ? undefined : 'group'} aria-hidden={mini || undefined}
      aria-label={mini ? undefined : t('games.board.label', { game: t('games.kind.ludo') })} onKeyDown={mini ? undefined : keys.onKeyDown} onFocus={mini ? undefined : keys.onFocus}>
      <svg className="k-gm-ludo-art" viewBox="0 0 15 15" aria-hidden focusable="false">
        <rect className="k-gm-ludo-bg" x="0" y="0" width="15" height="15" rx="0.5" />
        {YARD.map(([r, c], corner) => (
          <g key={corner} className={cx(`is-c${corner}`, !corners.includes(corner) && 'is-off')}>
            <rect className="k-gm-ludo-yard" x={c + 0.25} y={r + 0.25} width="5.5" height="5.5" rx="0.7" />
            <rect className="k-gm-ludo-pad" x={c + 1.1} y={r + 1.1} width="3.8" height="3.8" rx="0.5" />
          </g>
        ))}
        {TRACK.map(([r, c], i) => (
          <rect key={i} className={cx('k-gm-ludo-sq', i % 13 === 0 && `is-c${i / 13}`)} x={c + 0.04} y={r + 0.04} width="0.92" height="0.92" rx="0.12" />
        ))}
        {COLUMN.map((col, corner) => col.slice(0, 5).map(([r, c]) => (
          <rect key={`${corner}-${r}-${c}`} className={cx('k-gm-ludo-sq', `is-c${corner}`)} x={c + 0.04} y={r + 0.04} width="0.92" height="0.92" rx="0.12" />
        )))}
        <path className="is-c0 k-gm-ludo-tri" d="M6 6 7.5 7.5 6 9z" /><path className="is-c1 k-gm-ludo-tri" d="M6 6h3L7.5 7.5z" />
        <path className="is-c2 k-gm-ludo-tri" d="M9 6v3L7.5 7.5z" /><path className="is-c3 k-gm-ludo-tri" d="M6 9h3L7.5 7.5z" />
      </svg>
      {LUDO_SAFE.filter((sq) => sq % 13 !== 0).map((sq) => (
        <span key={sq} className="k-gm-ludo-star" style={{ ['--r' as string]: TRACK[sq]![0], ['--c' as string]: TRACK[sq]![1] }}><Star /></span>
      ))}
      {pieces.map((p) => {
        const key = where(p);
        const many = crowd.get(key)!;
        const nth = seenAt.get(key) ?? 0;
        seenAt.set(key, nth + 1);
        const style = { ['--r' as string]: p.at[0], ['--c' as string]: p.at[1], ['--n' as string]: nth, ['--of' as string]: many };
        const cls = cx('k-gm-ludo-tok', many > 1 && 'is-crowd', p.seat === me && can.has(p.k) && 'is-next', state.last?.s === p.seat && state.last.k === p.k && 'is-last');
        const piece = <LudoPiece corner={ludoCorner(state.n, p.seat)} />;
        if (mini || p.seat !== me || !can.has(p.k)) return <span key={`${p.seat}-${p.k}`} className={cls} style={style}>{piece}</span>;
        const to = p.pos < 0 ? 0 : p.pos + (roll ?? 0);
        const tab = first ? 0 : -1;
        first = false;
        return (
          <button key={`${p.seat}-${p.k}`} type="button" className={cls} style={style} data-r={Math.round(p.at[0])} data-c={Math.round(p.at[1])} tabIndex={tab}
            aria-label={t('games.ludo.move', { n: p.k + 1, from: posText(p.pos), to: posText(to) })} onClick={() => onMove({ k: p.k })}>{piece}</button>
        );
      })}
      {mini ? null : (
        <ul className="k-sr-only">
          {state.tok.map((row, seat) => (state.out.includes(seat) ? null : row.map((pos, k) => (
            <li key={`${seat}-${k}`}>{t('games.ludo.where', { name: names[seat] ?? '', n: k + 1, where: posText(pos) })}</li>
          ))))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** A line under the board for what the picture alone doesn't say: scores, a forced pass, check. */
type Note = (state: never, names: string[], t: TFunction, me: number | null) => string | null;

const score = (names: string[], a: number, b: number, t: TFunction) => `${t('games.score', { name: names[0] ?? '', count: a })} · ${t('games.score', { name: names[1] ?? '', count: b })}`;

export const BOARDS: Record<GameKind, { Board: ComponentType<BoardProps>; note?: Note }> = {
  tictactoe: { Board: grid(tttSpec, 'tictactoe') },
  // "Check." while the game is on; at the end the status line already says "Checkmate".
  chess: { Board: grid(chessSpec, 'chess'), note: ((s: ChessState, _n: string[], t: TFunction) => (chessCheckSquare(s) >= 0 && chess.turn(s) !== null ? t('games.check') : null)) as Note },
  checkers: { Board: grid(checkersSpec, 'checkers') },
  connect4: { Board: grid(c4Spec, 'connect4') },
  reversi: {
    Board: grid(reversiSpec, 'reversi'),
    note: ((s: ReversiState, names: string[], t: TFunction) => {
      const [d, l] = reversiCount(s.b);
      return (s.passed ? `${t('games.passed', { name: names[1 - s.t] ?? '' })} ` : '') + score(names, d, l, t);
    }) as Note,
  },
  ludo: { Board: LudoBoard as unknown as ComponentType<BoardProps> },
  gomoku: { Board: grid(gomokuSpec, 'gomoku') },
  dots: {
    Board: DotsBoard as unknown as ComponentType<BoardProps>,
    note: ((s: DotsState, names: string[], t: TFunction) => { const [a, b] = dotsScore(s.o); return score(names, a, b, t); }) as Note,
  },
  mancala: {
    Board: MancalaBoard as unknown as ComponentType<BoardProps>,
    note: ((s: MancalaState, names: string[], t: TFunction) => (s.again ? `${t('games.again', { name: names[s.t] ?? '' })} ` : '') + score(names, s.p[6]!, s.p[13]!, t)) as Note,
  },
};
