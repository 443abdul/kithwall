'use client';
// A game in the conversation: ONE card per game, standing where its newest message is. It shows a small
// picture of the board, who is playing, and where the game stands; it changes in place as moves arrive.
// Tapping it opens the full board (GameDialog). An invitation can be answered right on the card.
import { useFormat, useT } from '@/i18n';
import type { Action } from '@/lib/games/match';
import type { GameView } from '@/lib/games/thread';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useNameOf } from '@/components/messages/look';
import { BOARDS } from './boards';
import { clockLabel, firstName, gameTitle, playersLine, statusText, toMove, whyText } from './labels';

/** A move of mine that is on its way: being sent, waiting for a connection, or refused by the server. */
export type SendState = 'sending' | 'queued' | 'failed' | null;

export function GameCard({ view, me, sending, onOpen, onAct }: {
  view: GameView; me: string | null; sending: SendState;
  onOpen: () => void; onAct: (a: Action) => void;
}) {
  const t = useT();
  const f = useFormat();
  const nameOf = useNameOf();
  const m = view.match;
  const list = (xs: string[]) => f.list(xs);
  const title = gameTitle(m.kind, t);
  const status = statusText(m, me, nameOf, t, list);
  const why = whyText(m, t);
  const names = m.players.map((p) => firstName(nameOf, p));
  const seat = me ? m.players.indexOf(me) : -1;
  const invitedMe = m.status === 'invited' && !!me && m.players.includes(me) && !m.ok.includes(me);
  const mine = toMove(m) === me || invitedMe || (m.offer !== null && seat >= 0 && m.offer !== seat);
  const { Board } = BOARDS[m.kind];
  return (
    <div className={mine ? 'k-gm-card is-mine' : 'k-gm-card'}>
      <button type="button" className="k-gm-card-main" onClick={onOpen}
        aria-label={t('games.card.label', { game: title, players: playersLine(m, me, nameOf, t, list), status })}>
        <span className="k-gm-thumb"><Board state={m.state} me={seat >= 0 ? seat : null} moves={[]} onMove={() => undefined} names={names} mini /></span>
        <span className="k-gm-card-text">
          <span className="k-gm-card-title">{title}{m.clock ? <span className="k-gm-card-clock"><Icon name="clock" /> {clockLabel(m.clock, t)}</span> : null}</span>
          <span className="k-gm-card-who" dir="auto">{playersLine(m, me, nameOf, t, list)}</span>
          <span className="k-gm-card-status" aria-live="polite">{status}{why && m.status === 'over' ? <span className="k-gm-card-why"> · {why}</span> : null}</span>
          {sending ? <span className="k-gm-card-sending">{t(sending === 'sending' ? 'games.sending' : sending === 'queued' ? 'games.queued' : 'games.failed')}</span> : null}
        </span>
      </button>
      {invitedMe && !sending ? (
        <div className="k-gm-card-actions">
          <Button size="sm" variant="primary" onClick={() => onAct({ t: 'accept' })}>{t('games.action.accept')}</Button>
          <Button size="sm" variant="ghost" onClick={() => onAct({ t: 'decline' })}>{t('games.action.decline')}</Button>
        </div>
      ) : null}
    </div>
  );
}
