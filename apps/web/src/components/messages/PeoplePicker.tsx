'use client';
// Pick connections (Kithwall 2): search by decrypted name or handle on this device, tap to select.
import { useMemo, useState } from 'react';
import { useT } from '@/i18n';
import { useFriendIds } from '@/lib/hooks';
import { people, usePeopleVersion } from '@/lib/people';
import { Spinner } from '@/components/ui/Spinner';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/components/ui/cx';
import { matches } from './chatModel';
import { PersonAvatar } from './look';

export function PeoplePicker({ selected, onToggle, exclude = [], max = 50, single = false }: {
  selected: string[];
  onToggle: (id: string) => void;
  exclude?: string[];
  max?: number;
  single?: boolean;
}) {
  const t = useT();
  usePeopleVersion();
  const friends = useFriendIds();
  const [q, setQ] = useState('');
  const excludeKey = exclude.join(',');
  const version = people.version;
  const list = useMemo(() => (friends.data ?? [])
    .filter((id) => !exclude.includes(id))
    .map((id) => ({ id, p: people.person(id) }))
    .sort((a, b) => (a.p?.name ?? '').localeCompare(b.p?.name ?? '')),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [friends.data, excludeKey, version]);
  const shown = list.filter((x) => matches(q, x.p?.name, x.p?.username));
  return (
    <div className="k-chat-picker">
      <div className="k-chat-search">
        <Icon name="search" />
        <label className="k-sr-only" htmlFor="k-chat-picker-q">{t('messages.new.search')}</label>
        <input id="k-chat-picker-q" type="search" className="k-input" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={t('messages.new.search')} autoComplete="off" spellCheck={false} />
      </div>
      {friends.isLoading ? <div className="k-chat-center"><Spinner /></div> : null}
      {!friends.isLoading && !list.length ? <p className="k-muted k-small k-chat-picker-empty">{t('messages.new.noConnections')}</p> : null}
      <ul className="k-chat-picker-list" role="listbox" aria-multiselectable={!single} aria-label={t('messages.new.people')}>
        {shown.map(({ id, p }) => {
          const on = selected.includes(id);
          const full = !on && selected.length >= max;
          return (
            <li key={id} role="option" aria-selected={on} aria-disabled={full || undefined}
              className={cx('k-chat-pick', on && 'is-on', full && 'is-off')}
              tabIndex={0}
              onClick={() => { if (!full) onToggle(id); }}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !full) { e.preventDefault(); onToggle(id); } }}>
              <PersonAvatar id={id} size={40} />
              <span className="k-chat-pick-names">
                <span className="k-chat-pick-name">{p?.name ?? '…'}</span>
                {p?.username ? <span className="k-small k-muted k-ltr">@{p.username}</span> : null}
              </span>
              <span className="k-chat-pick-check" aria-hidden>{on ? <Icon name="check" /> : null}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
