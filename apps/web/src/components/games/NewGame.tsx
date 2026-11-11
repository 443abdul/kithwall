'use client';
// "Play a game" (from the chat composer's plus menu): pick a game, who plays (the other person in a
// one-to-one chat; chosen members in a group), who goes first and, if wanted, a clock. Sending it posts an
// invitation in the chat; the game starts when everyone invited has accepted.
import { useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { CLOCKS, type ClockSpec, type NewGame } from '@/lib/games/match';
import { engineOf, GAME_KINDS } from '@/lib/games/registry';
import type { GameKind } from '@/lib/games/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/components/ui/cx';
import { PersonAvatar, useNameOf } from '@/components/messages/look';
import { BOARDS } from './boards';
import { clockLabel, firstName, gameTitle } from './labels';

type First = 'random' | 'me' | 'them';

export function NewGameDialog({ members, me, open, onClose, onStart }: {
  /** Everyone in the chat, me included. */
  members: string[]; me: string; open: boolean; onClose: () => void; onStart: (g: NewGame) => void;
}) {
  const t = useT();
  const nameOf = useNameOf();
  const others = members.filter((p) => p !== me);
  const [kind, setKind] = useState<GameKind | null>(null);
  const [picked, setPicked] = useState<string[]>(others.length === 1 ? others : []);
  const [first, setFirst] = useState<First>('random');
  const [clock, setClock] = useState(0);
  const [rules, setRules] = useState(false);

  const engine = kind ? engineOf(kind) : null;
  const max = engine ? engine.players.max - 1 : 1;
  const chosen = picked.slice(0, max);
  // A clock for the whole game is for two players; more than two can have time per move.
  const clocks = CLOCKS.map((c, i) => ({ c, i })).filter(({ c }) => !c || c.k === 'move' || chosen.length === 1);
  const clockSpec: ClockSpec | null = clocks.some((x) => x.i === clock) ? CLOCKS[clock] ?? null : null;
  const close = () => { setKind(null); setRules(false); onClose(); };

  function toggle(id: string) {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : max === 1 ? [id] : [...cur, id].slice(-max)));
  }

  function send() {
    if (!kind || !engine || !chosen.length) return;
    // With dice the inviter always rolls first (the dice protocol needs it, docs/v2/11-games.md §5).
    const meFirst = engine.dice || first === 'me' || (first === 'random' && crypto.getRandomValues(new Uint8Array(1))[0]! < 128);
    onStart({ kind, players: meFirst ? [me, ...chosen] : [...chosen, me], by: me, clock: clockSpec });
    close();
  }

  if (!kind || !engine) {
    return (
      <Dialog open={open} onClose={close} title={t('games.new.title')} sheet>
        {others.length ? (
          <ul className="k-gm-picker" aria-label={t('games.new.choose')}>
            {GAME_KINDS.map((k) => {
              const { Board } = BOARDS[k];
              const e = engineOf(k);
              return (
                <li key={k}>
                  <button type="button" className="k-gm-pick" onClick={() => { setKind(k); setPicked(others.length === 1 ? others : []); setFirst('random'); setClock(0); }}>
                    <span className="k-gm-thumb"><Board state={e.init(e.players.min)} me={null} moves={[]} onMove={() => undefined} names={[]} mini /></span>
                    <span className="k-gm-pick-text">
                      <span className="k-gm-pick-title">{gameTitle(k, t)}</span>
                      <span className="k-small k-muted">{t(`games.blurb.${k}` as MessageKey)}</span>
                    </span>
                    <Icon name="forward" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : <p className="k-muted">{t('games.new.nobody')}</p>}
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={close} title={gameTitle(kind, t)} sheet
      footer={<><Button variant="ghost" onClick={() => setKind(null)}>{t('common.back')}</Button>
        <Button variant="primary" disabled={!chosen.length} onClick={send}>{t('games.new.send')}</Button></>}>
      <div className="k-stack">
        {others.length > 1 ? (
          <section>
            <h3 className="k-section-title">{t('games.new.with')}</h3>
            <p className="k-small k-muted">{t('games.new.pick', { count: max })}</p>
            <ul className="k-chat-picker-list" role="listbox" aria-multiselectable={max > 1} aria-label={t('games.new.with')}>
              {others.map((id) => {
                const on = chosen.includes(id);
                return (
                  <li key={id} role="option" aria-selected={on} className={cx('k-chat-pick', on && 'is-on')} tabIndex={0}
                    onClick={() => toggle(id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(id); } }}>
                    <PersonAvatar id={id} size={40} />
                    <span className="k-chat-pick-names"><span className="k-chat-pick-name">{nameOf(id)}</span></span>
                    <span className="k-chat-pick-check" aria-hidden>{on ? <Icon name="check" /> : null}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <p className="k-gm-with"><PersonAvatar id={others[0]} size={32} /> {t('games.new.withOne', { name: nameOf(others[0] ?? '') })}</p>
        )}

        {engine.dice ? <p className="k-small k-muted">{t('games.new.diceFirst')}</p> : (
          <section>
            <h3 className="k-section-title">{t('games.new.first')}</h3>
            <Segmented<First> label={t('games.new.first')} value={first} onChange={setFirst} block options={[
              { value: 'random', label: t('games.new.firstRandom') },
              { value: 'me', label: t('games.new.firstMe') },
              { value: 'them', label: chosen.length === 1 ? firstName(nameOf, chosen[0]!) : t('games.new.firstThem') },
            ]} />
          </section>
        )}

        <section>
          <h3 className="k-section-title">{t('games.new.clock')}</h3>
          <div role="radiogroup" aria-label={t('games.new.clock')} className="k-chat-reasons">
            {clocks.map(({ c, i }) => (
              <label key={i} className={cx('k-chat-reason', (clockSpec ? clock === i : !c) && 'is-on')}>
                <input type="radio" name="k-gm-clock" checked={clockSpec ? clock === i : !c} onChange={() => setClock(i)} />
                <span>{clockLabel(c, t)}</span>
              </label>
            ))}
          </div>
          <p className="k-small k-muted">{t('games.new.clockNote')}</p>
        </section>

        <Button size="sm" variant="ghost" icon="info" aria-expanded={rules} onClick={() => setRules(!rules)}>{t('games.action.rules')}</Button>
        {rules ? <p className="k-gm-rules k-small" dir="auto">{t(`games.rules.${kind}` as MessageKey)}</p> : null}
        <p className="k-small k-muted"><Icon name="lock" /> {t('games.sealed')}</p>
      </div>
    </Dialog>
  );
}
