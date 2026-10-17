'use client';
// /groups/new — reference vNewGroup: name, members (friends), description, privacy.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { FriendPicker } from '@/components/social/bits';
import { useAppSetting, useFriendIds } from '@/lib/hooks';
import { createGroup, GROUP_COLORS, type GroupPrivacy } from '@/lib/groups';
import { ErrorBox, PublicWarning, useAction } from './bits';

export function NewGroup() {
  const router = useRouter();
  const qc = useQueryClient();
  const friends = useFriendIds();
  const pub = useAppSetting('public_audience_enabled');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [privacy, setPrivacy] = useState<GroupPrivacy>('closed');
  const [color, setColor] = useState(GROUP_COLORS[0]!);
  const { busy, error, setError, run } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError('Please give your group a name.'); return; }
    if (privacy === 'open' && !pub.data) { setError('Open groups aren\'t available.'); return; }
    let id = '';
    if (await run(async () => { id = await createGroup({ info: { name: n.slice(0, 120), description: desc.trim().slice(0, 2000), color }, privacy, invite: members }); })) {
      await qc.invalidateQueries({ queryKey: ['groups'] });
      router.push(`/groups/${id}`);
    }
  };

  const opts: [GroupPrivacy, string, string][] = [
    ['closed', 'Closed', 'Members can see who\'s in the group and invite their friends. Only members can read the name, posts and docs (end-to-end encrypted).'],
    ['secret', 'Secret', 'Same as Closed, but the group is never shown on members\' profiles and can\'t be found or requested.'],
    ['open', 'Open', 'Anyone on Kithwall can see the group, who\'s in it, and what members post. Not encrypted.'],
  ];

  return (
    <AppPage active="groups" right={null}>
      <Title icon="group">Create Group</Title>
      <ErrorBox error={error} />
      <form onSubmit={(e) => void submit(e)}>
        <table className="form"><tbody>
          <tr><td className="l"><label htmlFor="g-name">Group Name:</label></td>
            <td><input id="g-name" type="text" value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} /></td></tr>
          <tr><td className="l">Members:</td>
            <td style={{ maxWidth: 300 }}>
              {friends.isLoading ? <span className="gray">Loading friends…</span>
                : <FriendPicker friends={friends.data ?? []} value={members} onChange={setMembers} label="Search friends to add" />}
              <div className="gray small" style={{ marginTop: 3 }}>They&rsquo;ll get an invitation to join.</div>
            </td></tr>
          <tr><td className="l"><label htmlFor="g-desc">Description:</label></td>
            <td><textarea id="g-desc" value={desc} maxLength={2000} onChange={(e) => setDesc(e.target.value)} /></td></tr>
          <tr><td className="l">Icon:</td>
            <td><div className="cm-colors" role="group" aria-label="Group icon color">
              {GROUP_COLORS.map((c) => <button key={c} type="button" aria-pressed={color === c} aria-label={`Color ${c}`} style={{ background: c }} onClick={() => setColor(c)} />)}
            </div></td></tr>
          <tr><td className="l">Privacy:</td>
            <td className="cm-radio" role="radiogroup" aria-label="Privacy">
              {opts.filter(([v]) => v !== 'open' || pub.data).map(([v, l, help]) => (
                <label key={v}><input type="radio" name="privacy" value={v} checked={privacy === v} onChange={() => setPrivacy(v)} /> <b>{l}:</b> {help}</label>
              ))}
              {privacy === 'open' && <PublicWarning what="An Open group's name, members and posts" />}
            </td></tr>
          <tr><td /><td>
            <button type="submit" className="btn b" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>{' '}
            <Link className="btn" href="/groups">Cancel</Link>
          </td></tr>
        </tbody></table>
      </form>
    </AppPage>
  );
}
