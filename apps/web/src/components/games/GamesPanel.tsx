'use client';
// "Games" on a chat's info screen: games going on, finished games, and the score between the people in
// this chat. Everything is worked out on this device from the chat's (encrypted) messages; nothing about
// games is stored on the server, so the list covers the messages that are still in the chat.
import { useFormat, useT } from '@/i18n';
import { tally, type GameView } from '@/lib/games/thread';
import { Button } from '@/components/ui/Button';
import { List, ListItem } from '@/components/ui/ListItem';
import { useNameOf } from '@/components/messages/look';
import { BOARDS } from './boards';
import { firstName, gameTitle, playersLine, statusText, whyText } from './labels';

export function GamesPanel({ views, me, onOpen, onNew, hasOlder, loadingOlder, onLoadOlder }: {
  views: GameView[]; me: string | null; onOpen: (id: string) => void; onNew: () => void;
  hasOlder: boolean; loadingOlder: boolean; onLoadOlder: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const nameOf = useNameOf();
  const list = (xs: string[]) => f.list(xs);
  const newest = [...views].reverse();
  const ongoing = newest.filter((v) => v.match.status === 'invited' || v.match.status === 'active');
  const finished = newest.filter((v) => v.match.status === 'over');
  const scores = tally(views);

  const row = (v: GameView) => {
    const m = v.match;
    const { Board } = BOARDS[m.kind];
    const why = whyText(m, t);
    const seat = me ? m.players.indexOf(me) : -1;
    return (
      <li key={v.id}>
        <ListItem
          leading={<span className="k-gm-thumb is-small"><Board state={m.state} me={seat >= 0 ? seat : null} moves={[]} onMove={() => undefined} names={[]} mini /></span>}
          title={`${gameTitle(m.kind, t)} · ${playersLine(m, me, nameOf, t, list)}`}
          subtitle={`${statusText(m, me, nameOf, t, list)}${why && m.status === 'over' ? ` · ${why}` : ''}`}
          onClick={() => onOpen(v.id)} chevron />
      </li>
    );
  };

  return (
    <div className="k-stack">
      <Button variant="primary" icon="plus" onClick={onNew}>{t('games.play')}</Button>
      {!views.length ? <p className="k-muted">{t('games.list.empty')}</p> : null}
      {ongoing.length ? <section><h3 className="k-section-title">{t('games.list.ongoing')}</h3><List>{ongoing.map(row)}</List></section> : null}
      {scores.length ? (
        <section>
          <h3 className="k-section-title">{t('games.list.score')}</h3>
          <table className="k-gm-score">
            <thead><tr><th scope="col">{t('games.list.player')}</th><th scope="col">{t('games.list.won')}</th><th scope="col">{t('games.list.drawn')}</th><th scope="col">{t('games.list.lost')}</th></tr></thead>
            <tbody>
              {scores.map((s) => (
                <tr key={s.player}>
                  <th scope="row">{s.player === me ? t('messages.you') : firstName(nameOf, s.player)}</th>
                  <td>{f.number(s.won)}</td><td>{f.number(s.drawn)}</td><td>{f.number(s.lost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {finished.length ? <section><h3 className="k-section-title">{t('games.list.finished')}</h3><List>{finished.map(row)}</List></section> : null}
      <p className="k-small k-muted">{t('games.list.note')}</p>
      {hasOlder ? <Button size="sm" variant="ghost" busy={loadingOlder} onClick={onLoadOlder}>{t('games.list.older')}</Button> : null}
    </div>
  );
}
