'use client';
// "To:" field: tokens for chosen people, a typeahead over my friends (names decrypted on this
// device), and an exact-username lookup for people who aren't my friends.
import { useId, useMemo, useState } from 'react';
import { Avatar } from '@/components/Avatar';
import { useFriendIds } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';

const USERNAME = /^@?([a-z0-9][a-z0-9.]{2,29})$/i;

export function RecipientPicker({ value, onChange, exclude = [], allowStrangers = true, autoFocus = false, label = 'To' }: {
  value: string[]; onChange: (ids: string[]) => void; exclude?: string[]; allowStrangers?: boolean; autoFocus?: boolean; label?: string;
}) {
  const { userId } = useSession();
  const friends = useFriendIds();
  usePeopleVersion();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const listId = useId();

  const hits = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/^@/, '');
    if (!term) return [];
    return (friends.data ?? [])
      .filter((id) => !value.includes(id) && !exclude.includes(id))
      .map((id) => people.person(id))
      .filter((p): p is NonNullable<typeof p> => !!p && (p.name.toLowerCase().includes(term) || p.username.includes(term)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [q, friends.data, value, exclude]);

  const add = (id: string) => {
    if (id === userId || value.includes(id) || exclude.includes(id)) return;
    onChange([...value, id]); setQ(''); setActive(0); setNote(null);
  };

  const byUsername = async () => {
    const m = q.trim().match(USERNAME);
    if (!m) { setNote('Pick a friend from the list, or type someone\'s exact username.'); return; }
    if (!allowStrangers) { setNote('You can only add your friends here.'); return; }
    const row = await people.byUsername(m[1]!.toLowerCase()).catch(() => null);
    if (!row) { setNote(`No one has the username @${m[1]}.`); return; }
    if (row.id === userId) { setNote('That\'s you!'); return; }
    add(row.id);
  };

  return (
    <div className="kwm-to">
      <div className="kwm-toks" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
        {value.map((id) => {
          const p = people.person(id);
          return (
            <span className="kwm-tok" key={id}>{p?.name ?? '…'}
              <button type="button" aria-label={`Remove ${p?.name ?? 'person'}`} onClick={() => onChange(value.filter((v) => v !== id))}>&times;</button>
            </span>
          );
        })}
        <input type="text" aria-label={label} role="combobox" aria-expanded={hits.length > 0} aria-controls={listId} aria-autocomplete="list"
          autoFocus={autoFocus} value={q} placeholder={value.length ? '' : 'Type a friend\'s name or a username'}
          onChange={(e) => { setQ(e.target.value); setActive(0); setNote(null); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
              if (!q.trim()) return;
              e.preventDefault();
              if (hits[active]) add(hits[active]!.id); else void byUsername();
            } else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
          }} />
      </div>
      {hits.length > 0 && (
        <ul className="kwm-ta" id={listId} role="listbox">
          {hits.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active} className={i === active ? 'on' : ''}
              onMouseDown={(e) => { e.preventDefault(); add(p.id); }} onMouseEnter={() => setActive(i)}>
              <Avatar id={p.id} size={24} /> <span><b>{p.name}</b> <span className="gray">@{p.username}</span></span>
            </li>
          ))}
        </ul>
      )}
      {!hits.length && q.trim() && USERNAME.test(q.trim()) && allowStrangers && (
        <div className="kwm-hintline gray">Press Enter to add @{q.trim().replace(/^@/, '').toLowerCase()}</div>
      )}
      {note && <div className="kwm-hintline kwm-err" role="alert">{note}</div>}
    </div>
  );
}
