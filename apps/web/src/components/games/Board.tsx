'use client';
// The shared board for games played on a grid of cells (tic-tac-toe, Connect Four, Reversi, Gomoku,
// checkers, chess). A game describes itself with a GridSpec; this component does the rest the same way
// for all of them:
//   - a move is a short path of cells to tap (one cell for most games, from → to for chess, from → every
//     landing square for a checkers jump); cells that continue a legal move are marked;
//   - touch, mouse and keyboard: every cell is a button, arrow keys move between cells, Enter or Space
//     taps; one cell is in the tab order (roving focus);
//   - every cell has a spoken name ("e4: white knight, you can move here");
//   - boards are not mirrored in right-to-left languages (a chess board has one orientation), and the
//     arrow keys follow what is on screen.
import { useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useT, type TFunction } from '@/i18n';
import { cx } from '@/components/ui/cx';

export interface BoardProps<S = unknown, M = unknown> {
  state: S;
  /** The seat this device plays; null when watching. The board is drawn from this seat's side. */
  me: number | null;
  /** The legal moves this device may send right now (empty when it isn't my turn). */
  moves: M[];
  onMove: (m: M) => void;
  /** A small picture for the chat card: nothing to tap, nothing read out. */
  mini?: boolean;
  /** Display names by seat. */
  names: string[];
  /** Dice games: the roll this device has made and not yet played. */
  roll?: number | null;
}

export interface GridSpec<S, M> {
  rows: number;
  cols: number;
  /** Turn the board round for the second player (chess, checkers). */
  flips?: boolean;
  /** Which board look from games.css. */
  look: 'check' | 'felt' | 'well' | 'paper' | 'goban';
  /** Letters and numbers along the edge (chess). */
  coords?: boolean;
  piece(s: S, i: number): ReactNode;
  /** Words for what stands on a cell; '' when it is empty. */
  what(s: S, i: number, t: TFunction): string;
  name(i: number, t: TFunction): string;
  /** The cells to tap, in order, to play this move. */
  path(m: M, s: S): number[];
  /** A tap on this cell counts as a tap on that one (Connect Four: anywhere in a column). */
  alias?(s: S, i: number): number;
  /** Mark the cells a move can start on while nothing is selected (off where every empty cell is legal). */
  hints?: boolean;
  /** Several moves along the same path (promotion): how to tell them apart. */
  option?(m: M, t: TFunction): { key: string; label: string; node: ReactNode };
  marks?(s: S): { last?: number[]; win?: number[]; alert?: number };
}

/**
 * Arrow keys between the buttons of a board. Buttons carry data-r / data-c (their place on screen); the
 * nearest one in the direction of the arrow gets the focus, straight lines first.
 */
export function useArrowKeys(ref: RefObject<HTMLElement | null>) {
  // One button of the board is in the tab order: the one that last had the focus.
  const hold = (el: HTMLElement) => {
    for (const x of ref.current?.querySelectorAll<HTMLElement>('button[data-r][tabindex="0"]') ?? []) x.tabIndex = -1;
    el.tabIndex = 0;
  };
  const onFocus = (e: FocusEvent) => {
    const el = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('button[data-r]') : null;
    if (el) hold(el);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const dir = e.key === 'ArrowUp' ? [-1, 0] : e.key === 'ArrowDown' ? [1, 0] : e.key === 'ArrowLeft' ? [0, -1] : e.key === 'ArrowRight' ? [0, 1] : null;
    const from = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-r]') : null;
    if (!dir || !from || !ref.current) return;
    const r0 = Number(from.dataset.r), c0 = Number(from.dataset.c);
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of ref.current.querySelectorAll<HTMLElement>('button[data-r]')) {
      const dr = Number(el.dataset.r) - r0, dc = Number(el.dataset.c) - c0;
      const along = dir[0] ? dr * dir[0] : dc * dir[1]!;
      const across = Math.abs(dir[0] ? dc : dr);
      if (along <= 0) continue;
      const score = along + across * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (!best) return;
    e.preventDefault();
    hold(best);
    best.focus();
  };
  return { onKeyDown, onFocus };
}

const startsWith = (path: number[], prefix: number[]) => prefix.every((x, i) => path[i] === x);

export function GridBoard<S, M>({ spec, state, me, moves, onMove, mini, label }: BoardProps<S, M> & { spec: GridSpec<S, M>; label: string }) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const keys = useArrowKeys(root);
  // The cells tapped so far of a move that needs more than one, and the moves to choose between at the end.
  const [sel, setSel] = useState<number[]>([]);
  const [choice, setChoice] = useState<M[] | null>(null);
  // A new position clears a half-made move (render-time reset, as React recommends for derived state).
  // Compared by value: the same position arrives as a new object whenever the chat's messages are re-read.
  const position = useMemo(() => JSON.stringify(state), [state]);
  const [seen, setSeen] = useState(position);
  if (seen !== position) { setSeen(position); setSel([]); setChoice(null); }

  const n = spec.rows * spec.cols;
  const flipped = !!spec.flips && me === 1;
  const paths = useMemo(() => moves.map((m) => ({ m, path: spec.path(m, state) })), [moves, spec, state]);
  const marks = spec.marks?.(state) ?? {};
  // Where the move in hand can go next; with nothing in hand, `starts` are the cells a move can begin on.
  const next = new Set(sel.length ? paths.filter((p) => startsWith(p.path, sel) && p.path.length > sel.length).map((p) => p.path[sel.length]!) : []);
  const starts = new Set(spec.hints === false ? [] : paths.map((p) => p.path[0]!));

  function tap(raw: number) {
    const i = spec.alias ? spec.alias(state, raw) : raw;
    setChoice(null);
    for (const prefix of [[...sel, i], [i]]) {
      const hits = paths.filter((p) => startsWith(p.path, prefix));
      if (!hits.length) continue;
      const done = hits.filter((p) => p.path.length === prefix.length);
      if (done.length === hits.length) {
        if (done.length === 1) { setSel([]); onMove(done[0]!.m); } else { setSel(prefix); setChoice(done.map((p) => p.m)); }
      } else setSel(prefix);
      return;
    }
    setSel([]);
  }

  const cells: ReactNode[] = [];
  for (let d = 0; d < n; d++) {
    const i = flipped ? n - 1 - d : d;
    const r = Math.floor(d / spec.cols), c = d % spec.cols;
    const piece = spec.piece(state, i);
    const cls = cx('k-gm-cell',
      spec.look === 'check' && ((Math.floor(i / spec.cols) + (i % spec.cols)) % 2 ? 'is-dark' : 'is-light'),
      marks.last?.includes(i) && 'is-last', marks.win?.includes(i) && 'is-win', marks.alert === i && 'is-alert',
      sel.includes(i) && 'is-sel', next.has(i) && 'is-next', !sel.length && starts.has(i) && 'is-start');
    const edge = spec.coords && !mini ? (
      <>
        {c === 0 ? <span className="k-gm-rank" aria-hidden>{spec.rows - Math.floor(i / spec.cols)}</span> : null}
        {r === spec.rows - 1 ? <span className="k-gm-file" aria-hidden>{'abcdefgh'[i % spec.cols]}</span> : null}
      </>
    ) : null;
    if (mini) { cells.push(<span key={i} className={cls}>{piece}</span>); continue; }
    const what = spec.what(state, i, t);
    let name = what ? t('games.sq.piece', { square: spec.name(i, t), piece: what }) : t('games.sq.empty', { square: spec.name(i, t) });
    if (sel.includes(i)) name = t('games.sq.selected', { label: name });
    else if (next.has(i) || (!sel.length && starts.has(i) && paths.some((p) => p.path.length === 1 && p.path[0] === i))) name = t('games.sq.target', { label: name });
    else if (marks.last?.includes(i)) name = t('games.sq.last', { label: name });
    cells.push(
      <button key={i} type="button" className={cls} data-r={r} data-c={c} tabIndex={d === 0 ? 0 : -1}
        aria-label={name} aria-pressed={sel.includes(i) || undefined} onClick={() => tap(i)}>
        {piece}{edge}
        {next.has(i) || (!sel.length && starts.has(i) && !piece) ? <span className="k-gm-dot" aria-hidden /> : null}
      </button>,
    );
  }

  const grid = (
    <div ref={root} className={cx('k-gm-grid', `is-${spec.look}`, mini && 'is-mini')} dir="ltr"
      style={{ ['--gm-cols' as string]: spec.cols, ['--gm-rows' as string]: spec.rows }}
      role={mini ? undefined : 'group'} aria-label={mini ? undefined : label} aria-hidden={mini || undefined}
      onKeyDown={mini ? undefined : keys.onKeyDown} onFocus={mini ? undefined : keys.onFocus}>
      {cells}
    </div>
  );
  if (mini) return grid;
  return (
    <div className="k-gm-boardwrap">
      {grid}
      {choice && spec.option ? (
        <div className="k-gm-choice" role="group" aria-label={t('games.promote.title')}>
          <span className="k-small k-muted">{t('games.promote.title')}</span>
          {choice.map((m) => {
            const o = spec.option!(m, t);
            return <button key={o.key} type="button" className="k-gm-choice-btn" aria-label={o.label} title={o.label} onClick={() => { setChoice(null); setSel([]); onMove(m); }}>{o.node}</button>;
          })}
        </div>
      ) : null}
    </div>
  );
}
