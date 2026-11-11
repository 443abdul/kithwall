'use client';
// The full game: the board (touch, mouse and keyboard), whose turn it is, clocks, the dice, draw offers,
// resigning, claiming a win on time, a rematch, the move list and the rules. People who aren't playing see
// the same screen without the controls and can watch the game as it goes.
//
// Nothing here decides what is legal: moves offered on the board come from the game's engine, and what is
// sent goes through `nextEvent` (lib/games/match.ts), the same rule book every other device checks it with.
import { useEffect, useState } from 'react';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { engineOf } from '@/lib/games/registry';
import { nextRoll, settle, stamp, timeLeft, type Action, type NewGame } from '@/lib/games/match';
import type { GameView } from '@/lib/games/thread';
import { secretsFor, serverNow } from '@/lib/games/play';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/components/ui/cx';
import { useNameOf } from '@/components/messages/look';
import { BOARDS } from './boards';
import { Die } from './pieces';
import type { SendState } from './GameCard';
import { clockLabel, clockText, firstName, gameTitle, playersLine, statusText, whyText } from './labels';

/** The server's time, re-read twice a second while a clock is running. */
function useServerClock(running: boolean): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => setNow(serverNow()), 500);
    return () => clearInterval(h);
  }, [running]);
  return running ? now : 0;
}

export function GameDialog({ view, me, sending, onClose, onAct, onStart }: {
  view: GameView; me: string | null; sending: SendState;
  onClose: () => void; onAct: (a: Action) => void; onStart: (g: NewGame) => void;
}) {
  const t = useT();
  const f = useFormat();
  const nameOf = useNameOf();
  const list = (xs: string[]) => f.list(xs);
  const m = view.match;
  const engine = engineOf(m.kind);
  const { Board, note } = BOARDS[m.kind];
  const names = m.players.map((p) => (p === me ? t('messages.you') : firstName(nameOf, p)));
  const seat = me ? m.players.indexOf(me) : -1;
  const playing = seat >= 0 && !m.left.includes(seat);
  const busy = view.pending || !!sending;
  const turn = m.status === 'active' ? engine.turn(m.state) : null;
  const myTurn = playing && turn === seat && !busy;
  const active = m.players.length - m.left.length;

  // Dice: the roll is fixed by the protocol; "Roll" only shows it. It belongs to this exact position.
  const [rolled, setRolled] = useState<{ link: string; roll: number } | null>(null);
  const roll = engine.dice && rolled?.link === view.head.link ? rolled.roll : null;
  const moves = !myTurn ? [] : engine.dice ? (roll ? engine.moves(m.state, roll) : []) : engine.moves(m.state);
  const last = engine.rolled?.(m.state) ?? null;
  function doRoll() {
    if (!me) return;
    const r = nextRoll(view.head, seat, secretsFor(view.id));
    if (r === null) return;
    setRolled({ link: view.head.link, roll: r });
    // Nothing to choose (no piece can move): the turn message goes out by itself.
    const only = engine.forced?.(engine.moves(m.state, r));
    if (only) onAct({ t: 'move', m: only });
  }

  // Clocks run on the server's time (lib/games/play.ts).
  const limited = m.status === 'active' && (!!m.clock || active > 2);
  const now = useServerClock(limited);
  const left = limited ? timeLeft(m, stamp(view.head.at), now) : null;
  const settled = settle(m, stamp(view.head.at));
  const canClaim = playing && !busy && !!left && left.seat !== seat && left.ms <= -1000;
  const flagged = !!left && !!m.clock && left.ms <= 0;

  const [confirm, setConfirm] = useState(false);
  const [rules, setRules] = useState(false);
  const invitedMe = m.status === 'invited' && playing && !m.ok.includes(me!);
  const offerToMe = m.status === 'active' && m.offer !== null && playing && m.offer !== seat;
  const canOffer = m.status === 'active' && playing && m.players.length === 2 && !engine.dice && m.offer === null;
  const act = (a: Action) => { setConfirm(false); onAct(a); };

  function rematch() {
    if (!me) return;
    // The other player starts this time; with dice the one who asks rolls first (lib/games/match.ts).
    const others = m.players.filter((p) => p !== me);
    const players = engine.dice ? [me, ...others] : [...m.players.slice(1), m.players[0]!];
    onStart({ kind: m.kind, players, by: me, clock: m.clock, from: view.id });
    onClose();
  }

  const status = statusText(m, me, nameOf, t, list);
  const why = whyText(m, t);
  const extra = note ? (note as (s: unknown, n: string[], tt: typeof t, who: number | null) => string | null)(m.state, names, t, seat >= 0 ? seat : null) : null;
  const san = m.kind === 'chess' ? (m.state as { san: string[] }).san : null;

  return (
    <Dialog open onClose={onClose} title={gameTitle(m.kind, t)} sheet className="k-gm-dialog">
      <div className="k-gm-play">
        <div className="k-gm-top">
          <p className="k-gm-players" dir="auto">{playersLine(m, me, nameOf, t, list)}</p>
          {m.clock ? (
            <p className="k-gm-clocks">
              <Icon name="clock" /> <span className="k-sr-only">{clockLabel(m.clock, t)}</span>
              {m.clock.k === 'total' ? m.players.map((p, i) => (
                <span key={p} className={cx('k-gm-clock', left?.seat === i && 'is-running', left?.seat === i && left.ms <= 0 && 'is-out')}>
                  {names[i]} <b>{clockText(left?.seat === i ? left.ms : settled.left[i] ?? 0)}</b>
                </span>
              )) : left ? (
                <span className={cx('k-gm-clock is-running', left.ms <= 0 && 'is-out')}>{names[left.seat]} <b>{clockText(left.ms)}</b></span>
              ) : <span className="k-gm-clock">{clockLabel(m.clock, t)}</span>}
            </p>
          ) : null}
        </div>

        <p className={cx('k-gm-status', myTurn && 'is-mine')} role="status" aria-live="polite">
          {status}{why ? ` · ${why}` : ''}
          {sending || view.pending ? <span className="k-gm-card-sending"> {t(sending === 'queued' ? 'games.queued' : sending === 'failed' ? 'games.failed' : 'games.sending')}</span> : null}
        </p>

        <Board state={m.state} me={seat >= 0 ? seat : null} moves={moves} onMove={(mv) => act({ t: 'move', m: mv })} names={names} roll={roll} />

        {extra ? <p className="k-gm-note k-small" aria-live="polite">{extra}</p> : null}

        {engine.dice && m.status === 'active' ? (
          <div className="k-gm-dice">
            <span className={cx('k-gm-dice-die', roll !== null && 'is-fresh')}><Die value={roll ?? last?.roll ?? null} /></span>
            {roll !== null ? <span role="status">{t('games.dice.you', { n: roll })} {moves.length && !engine.forced?.(moves) ? t('games.dice.choose') : t('games.dice.noMove')}</span>
              : last ? <span role="status">{last.seat === seat ? t('games.dice.you', { n: last.roll }) : t('games.dice.other', { name: names[last.seat] ?? '', n: last.roll })}</span> : null}
            {myTurn && roll === null ? <Button variant="primary" onClick={doRoll}>{t('games.action.roll')}</Button> : null}
          </div>
        ) : null}

        {offerToMe ? (
          <Callout>
            <span>{t('games.status.offered', { name: names[m.offer!] ?? '' })}</span>
            <span className="k-gm-row">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => act({ t: 'agree' })}>{t('games.action.agree')}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ t: 'refuse' })}>{t('games.action.refuse')}</Button>
            </span>
          </Callout>
        ) : null}
        {flagged && left && left.seat === seat ? <Callout tone="warning">{t('games.time.yoursUp')}</Callout> : null}

        {confirm ? (
          <div className="k-gm-row" role="group" aria-label={t('games.resign.title')}>
            <span className="k-gm-row-text">{t(m.players.length === 2 ? 'games.resign.body' : 'games.resign.bodyMany')}</span>
            <Button size="sm" variant="danger" onClick={() => act({ t: 'resign' })}>{t('games.action.resign')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>{t('common.back')}</Button>
          </div>
        ) : (
          <div className="k-gm-row">
            {invitedMe ? <>
              <Button variant="primary" disabled={busy} onClick={() => act({ t: 'accept' })}>{t('games.action.accept')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => act({ t: 'decline' })}>{t('games.action.decline')}</Button>
            </> : null}
            {m.status === 'invited' && me === m.by ? <Button variant="ghost" disabled={busy} onClick={() => act({ t: 'cancel' })}>{t('games.action.cancel')}</Button> : null}
            {canClaim && left ? (
              <Button variant="primary" onClick={() => act({ t: 'claim' })}>
                {active === 2 ? t('games.action.claim') : t('games.action.remove', { name: names[left.seat] ?? '' })}
              </Button>
            ) : null}
            {canOffer ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ t: 'offer' })}>{t('games.action.offer')}</Button> : null}
            {m.status === 'active' && playing ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>{t(m.players.length === 2 ? 'games.action.resign' : 'games.action.leave')}</Button> : null}
            {m.status === 'over' && seat >= 0 ? <Button variant="primary" icon="refresh" onClick={rematch}>{t('games.action.rematch')}</Button> : null}
            <Button size="sm" variant="ghost" icon="info" aria-expanded={rules} onClick={() => setRules(!rules)}>{t('games.action.rules')}</Button>
          </div>
        )}

        {rules ? <p className="k-gm-rules k-small" dir="auto">{t(`games.rules.${m.kind}` as MessageKey)}</p> : null}

        {san ? (
          <section className="k-gm-moves" aria-label={t('games.moves')}>
            <h3 className="k-section-title">{t('games.moves')}</h3>
            {san.length ? (
              <ol dir="ltr">
                {Array.from({ length: Math.ceil(san.length / 2) }, (_, i) => (
                  <li key={i}><span className="k-gm-moves-n">{i + 1}.</span> <span>{san[i * 2]}</span> <span>{san[i * 2 + 1] ?? ''}</span></li>
                ))}
              </ol>
            ) : <p className="k-small k-muted">{t('games.noMoves')}</p>}
          </section>
        ) : null}

        {seat < 0 ? <p className="k-small k-muted"><Icon name="eye" /> {t('games.watching')}</p> : null}
        {!view.complete ? <p className="k-small k-muted"><Icon name="clock" /> {t('games.partial')}</p> : null}
        <p className="k-small k-muted"><Icon name="lock" /> {t('games.sealed')}</p>
      </div>
    </Dialog>
  );
}
