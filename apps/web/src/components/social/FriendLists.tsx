'use client';
// Friend lists manager: create lists, add/remove members (removal rotates the list key),
// rename and delete. List names are encrypted so only you can read them.
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { useMyLists } from '@/components/feed/AudienceSelect';
import { ConfirmDialog } from './Dialog';
import { FriendPicker } from './bits';
import { addToList, createList, deleteList, removeFromList, renameList, type FriendList } from '@/lib/social/lists';
import { people, usePeopleVersion } from '@/lib/people';

export function FriendLists({ friends }: { friends: string[] }) {
  usePeopleVersion();
  const lists = useMyLists();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['lists'] });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await createList(name, members); setName(''); setMembers([]); await refresh(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="note"><Icon name="lock" /> Friend lists let you share with just some of your friends, like &ldquo;Close Friends&rdquo; or &ldquo;Family&rdquo;.
        Each list has its own encryption key. List names are encrypted so only you can see them; people aren&rsquo;t told which lists they&rsquo;re on.</div>
      {(lists.data ?? []).map((l) => <ListBox key={l.id} list={l} friends={friends} onChange={refresh} />)}
      {lists.isLoading && <div className="gray">Loading lists…</div>}
      <form className="kw-listbox" onSubmit={(e) => void create(e)}>
        <h4><span>Create a New List</span></h4>
        {err && <div className="err" role="alert">{err}</div>}
        <input type="text" placeholder="List name, e.g. Close Friends" aria-label="List name" maxLength={60} value={name}
          onChange={(e) => setName(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
        <FriendPicker friends={friends} value={members} onChange={setMembers} max={500} />
        <div style={{ textAlign: 'right', marginTop: 6 }}><button className="btn b" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create List'}</button></div>
      </form>
    </>
  );
}

function ListBox({ list, friends, onChange }: { list: FriendList; friends: string[]; onChange: () => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(list.name);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await onChange(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const candidates = friends.filter((f) => !list.members.includes(f));
  return (
    <div className="kw-listbox">
      <h4>
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await renameList(list.id, name); setEditing(false); }); }} style={{ display: 'flex', gap: 4, flex: 1 }}>
            <input type="text" aria-label="List name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
            <button className="btn b" disabled={busy}>Save</button>
            <button type="button" className="btn" onClick={() => { setEditing(false); setName(list.name); }}>Cancel</button>
          </form>
        ) : <span><Icon name="friends" /> {list.name} <span className="gray">({list.members.length})</span></span>}
        {!editing && <span>
          <button type="button" className="kw-link" onClick={() => setEditing(true)}>Rename</button> &middot;{' '}
          <button type="button" className="kw-link" onClick={() => setConfirm('delete')}>Delete</button>
        </span>}
      </h4>
      {err && <div className="err" role="alert">{err}</div>}
      <div>
        {list.members.map((m) => (
          <span className="kw-chip" key={m}>{people.person(m)?.name ?? '…'}
            <button type="button" aria-label={`Remove ${people.person(m)?.name ?? ''} from ${list.name}`} title="Remove" disabled={busy} onClick={() => setConfirm(m)}>&times;</button>
          </span>
        ))}
        {!list.members.length && <span className="gray">No one is on this list yet.</span>}
      </div>
      {candidates.length > 0 && (
        <form style={{ marginTop: 6, display: 'flex', gap: 4 }} onSubmit={(e) => { e.preventDefault(); if (adding) void run(async () => { await addToList(list.id, adding); setAdding(''); }); }}>
          <select aria-label={`Add a friend to ${list.name}`} value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a friend…</option>
            {candidates.map((f) => <option key={f} value={f}>{people.person(f)?.name ?? '…'}</option>)}
          </select>
          <button className="btn" disabled={busy || !adding}>Add</button>
        </form>
      )}
      {confirm === 'delete' && (
        <ConfirmDialog title={`Delete "${list.name}"?`} confirmLabel="Delete List" onClose={() => setConfirm(null)} onConfirm={() => run(() => deleteList(list.id))}>
          Deleting this list also <b>deletes the posts you shared only with it</b>. This can&rsquo;t be undone.
        </ConfirmDialog>
      )}
      {confirm && confirm !== 'delete' && (
        <ConfirmDialog title="Remove from list?" confirmLabel="Remove" onClose={() => setConfirm(null)} onConfirm={() => run(() => removeFromList(list.id, confirm))}>
          {people.person(confirm)?.name ?? 'This person'} will be removed from &ldquo;{list.name}&rdquo;. The list gets a new key, so they
          won&rsquo;t be able to read anything you share with it from now on.
        </ConfirmDialog>
      )}
    </div>
  );
}
