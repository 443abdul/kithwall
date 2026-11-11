// Game pieces, drawn here as inline SVG (no images, no fonts, nothing downloaded): chess men, draughts,
// discs, marks, dice and Ludo pieces. Shapes are Kithwall's own. Colours come from styles/v2/games.css.
// Every piece is decorative (aria-hidden): the square it stands on carries the words.
import type { ReactElement } from 'react';
import { cx } from '@/components/ui/cx';

function Svg({ className, children, box = 100 }: { className?: string; children: ReactElement | ReactElement[]; box?: number }) {
  return <svg className={className} viewBox={`0 0 ${box} ${box}`} aria-hidden focusable="false">{children}</svg>;
}

// ---------------------------------------------------------------------------------------------
// Chess: one outline per piece, on a 100 × 100 grid, standing on a common base.

const BASE = <path d="M24 90h52a4 4 0 0 0 4-4v-2a8 8 0 0 0-8-8H28a8 8 0 0 0-8 8v2a4 4 0 0 0 4 4z" />;

const CHESS: Record<string, ReactElement> = {
  p: <><circle cx="50" cy="30" r="13" /><path d="M39 44h22l-3 6c2 10 6 17 12 24H30c6-7 10-14 12-24z" />{BASE}</>,
  r: <><path d="M27 16h11v9h7v-9h10v9h7v-9h11v20l-8 7v19l7 12H28l7-12V43l-8-7z" />{BASE}</>,
  n: <><path d="M31 74c1-17 7-26 18-33l-11 3-8 7-7-8 12-17 6-13 8 9c19 3 27 20 26 52z" /><circle className="k-gm-eye" cx="45" cy="30" r="2.6" />{BASE}</>,
  b: <><circle cx="50" cy="13" r="6" /><path d="M50 20c14 11 19 24 11 36l5 6v5H34v-5l5-6c-8-12-3-25 11-36z" /><path className="k-gm-cut" d="M56 30 46 44" /><path d="M36 74l3-7h22l3 7z" />{BASE}</>,
  q: <><circle cx="20" cy="27" r="5.5" /><circle cx="36" cy="18" r="5.5" /><circle cx="50" cy="15" r="5.5" /><circle cx="64" cy="18" r="5.5" /><circle cx="80" cy="27" r="5.5" /><path d="M21 33l13 18 3-27 13 25 13-25 3 27 13-18-8 41H29z" />{BASE}</>,
  k: <><path d="M46 6h8v8h8v8h-8v9h-8v-9h-8v-8h8z" /><path d="M50 33c9-9 30-7 30 9 0 9-5 17-10 32H30c-5-15-10-23-10-32 0-16 21-18 30-9z" /><path className="k-gm-cut" d="M50 36v36" />{BASE}</>,
};

/** A chess piece by its FEN letter (upper case white, lower case black). */
export function ChessPiece({ piece }: { piece: string }) {
  const kind = piece.toLowerCase();
  const shape = CHESS[kind];
  if (!shape) return null;
  return <Svg className={cx('k-gm-piece', piece === kind ? 'is-b' : 'is-w')}>{shape}</Svg>;
}

// ---------------------------------------------------------------------------------------------
// Round pieces. Besides the colour, each side has its own inner mark, so the two can be told apart
// without seeing colour.

/** A disc for seat 0 or 1: `look` picks the palette (draughts, reversi stones, Connect Four). */
export function Disc({ seat, look, king }: { seat: number; look: 'stone' | 'drop' | 'man'; king?: boolean }) {
  return (
    <Svg className={cx('k-gm-disc', `is-${look}`, seat === 0 ? 'is-0' : 'is-1')}>
      <circle cx="50" cy="50" r="41" />
      {look === 'stone' ? <></> : seat === 0 ? <circle className="k-gm-mark" cx="50" cy="50" r="27" /> : <circle className="k-gm-mark" cx="50" cy="50" r="14" />}
      {king ? <path className="k-gm-crown" d="M27 64V38l12 12 11-17 11 17 12-12v26z" /> : <></>}
    </Svg>
  );
}

/** Tic-tac-toe marks. */
export function Mark({ seat }: { seat: number }) {
  return (
    <Svg className={cx('k-gm-ttt', seat === 0 ? 'is-0' : 'is-1')}>
      {seat === 0 ? <path d="M24 24l52 52M76 24 24 76" /> : <circle cx="50" cy="50" r="28" />}
    </Svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Dice and Ludo

const PIPS: Record<number, [number, number][]> = {
  1: [[50, 50]], 2: [[30, 30], [70, 70]], 3: [[28, 28], [50, 50], [72, 72]], 4: [[30, 30], [70, 30], [30, 70], [70, 70]],
  5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]], 6: [[30, 26], [70, 26], [30, 50], [70, 50], [30, 74], [70, 74]],
};

/** A die face (1–6); with no value, a blank die. */
export function Die({ value }: { value: number | null }) {
  return (
    <Svg className="k-gm-die">
      <rect x="8" y="8" width="84" height="84" rx="18" />
      <>{(value ? PIPS[value] ?? [] : []).map(([x, y]) => <circle key={`${x}-${y}`} className="k-gm-pip" cx={x} cy={y} r="8" />)}</>
    </Svg>
  );
}

/** The marks that tell the four Ludo colours apart without colour: dot, ring, bar, cross. */
const LUDO_MARK: ReactElement[] = [
  <circle key="m" className="k-gm-mark" cx="50" cy="42" r="9" />,
  <circle key="m" className="k-gm-mark is-ring" cx="50" cy="42" r="10" />,
  <path key="m" className="k-gm-mark is-line" d="M36 42h28" />,
  <path key="m" className="k-gm-mark is-line" d="M40 32l20 20M60 32 40 52" />,
];

/** A Ludo piece of one of the four corners (0–3). */
export function LudoPiece({ corner }: { corner: number }) {
  return (
    <Svg className={cx('k-gm-ludo', `is-c${corner}`)}>
      <path d="M50 8c17 0 30 13 30 30 0 20-19 34-30 54C39 72 20 58 20 38 20 21 33 8 50 8z" />
      {LUDO_MARK[corner] ?? <></>}
    </Svg>
  );
}

/** The star that marks a safe square. */
export function Star() {
  return <Svg className="k-gm-star"><path d="M50 12l11 25 27 3-20 18 6 27-24-14-24 14 6-27-20-18 27-3z" /></Svg>;
}
