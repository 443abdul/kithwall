// Words for games: the one-line status ("Your move", "Ann won"), the reason a game ended, clock names and
// the conversation-list preview ("Chess: your move"). Shared by the chat card, the game screen, the games
// list and the conversation list, so they always say the same thing.
import type { MessageKey, TFunction } from '@/i18n';
import { engineOf } from '@/lib/games/registry';
import type { ClockSpec, Match } from '@/lib/games/match';
import type { GameKind } from '@/lib/games/types';

export type NameOf = (id: string) => string;
type ListOf = (xs: string[]) => string;

export const gameTitle = (kind: GameKind, t: TFunction): string => t(`games.kind.${kind}` as MessageKey);

/** First names keep the lines short ("Ann vs Ben"). */
export const firstName = (nameOf: NameOf, id: string): string => nameOf(id).split(' ')[0] || nameOf(id);

/** "Ann vs Ben", or a list for more than two. `me` is shown as "You". */
export function playersLine(m: Match, me: string | null, nameOf: NameOf, t: TFunction, list: ListOf): string {
  const names = m.players.map((p) => (p === me ? t('messages.you') : firstName(nameOf, p)));
  return names.length === 2 ? t('games.vs', { a: names[0]!, b: names[1]! }) : list(names);
}

export function clockLabel(clock: ClockSpec | null, t: TFunction): string {
  if (!clock) return t('games.clock.none');
  if (clock.k === 'total') return t('games.clock.total', { count: Math.max(1, Math.round(clock.ms / 60_000)) });
  if (clock.ms >= 86_400_000) return t('games.clock.moveDays', { count: Math.round(clock.ms / 86_400_000) });
  if (clock.ms >= 3_600_000) return t('games.clock.moveHours', { count: Math.round(clock.ms / 3_600_000) });
  return t('games.clock.moveMinutes', { count: Math.max(1, Math.round(clock.ms / 60_000)) });
}

/** 4:05, 1:02:03 or, from a day up, 26:00:00 style hours: digits read the same in every language. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

const WHY = new Set(['checkmate', 'stalemate', 'material', 'repetition', 'fifty', 'line', 'full', 'count', 'blocked', 'quiet', 'home', 'left', 'resign', 'time', 'agreed', 'declined', 'cancelled']);

/** Why the game ended ("Checkmate", "On time"), or null while it is on. */
export function whyText(m: Match, t: TFunction): string | null {
  if (!m.result) return null;
  return WHY.has(m.result.why) ? t(`games.why.${m.result.why}` as MessageKey) : null;
}

/** Whose turn it is in a running game (a user id), or null. */
export function toMove(m: Match): string | null {
  if (m.status !== 'active') return null;
  const seat = engineOf(m.kind).turn(m.state);
  return seat === null ? null : m.players[seat] ?? null;
}

/** The one line that says where a game stands, from the point of view of `me`. */
export function statusText(m: Match, me: string | null, nameOf: NameOf, t: TFunction, list: ListOf): string {
  const name = (id: string) => firstName(nameOf, id);
  if (m.status === 'invited') {
    const waiting = m.players.filter((p) => !m.ok.includes(p));
    if (me && waiting.includes(me)) return t('games.status.invitedYou', { name: name(m.by) });
    if (me && m.players.includes(me)) return t('games.status.waiting', { names: list(waiting.map(name)) });
    return t('games.status.invitedOthers', { name: name(m.by), names: list(m.players.filter((p) => p !== m.by).map(name)) });
  }
  if (m.status === 'cancelled') return t(m.result?.why === 'declined' ? 'games.status.declined' : 'games.status.cancelled');
  if (m.status === 'over') {
    const w = m.result?.winner;
    if (w === null || w === undefined) return t('games.status.draw');
    return m.players[w] === me ? t('games.status.youWon') : t('games.status.won', { name: name(m.players[w] ?? '') });
  }
  if (m.offer !== null && me && m.players.includes(me)) {
    return m.players[m.offer] === me ? t('games.status.youOffered') : t('games.status.offered', { name: name(m.players[m.offer] ?? '') });
  }
  const turn = toMove(m);
  if (!turn) return '';
  if (turn === me) return t(engineOf(m.kind).dice ? 'games.status.yourRoll' : 'games.status.yourMove');
  return t('games.status.theirMove', { name: name(turn) });
}

/** Conversation-list preview: "Chess: your move". */
export function gamePreview(m: Match, me: string | null, nameOf: NameOf, t: TFunction, list: ListOf): string {
  return t('games.preview', { game: gameTitle(m.kind, t), status: statusText(m, me, nameOf, t, list) });
}
