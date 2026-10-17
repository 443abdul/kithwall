'use client';
// /groups/[id] (+ /info, /docs, /docs/[docId], /members) — reference vGroup.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, RightBox } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { AvatarLink, NameLink } from '@/components/Avatar';
import { ConfirmDialog } from '@/components/social/Dialog';
import { FriendPicker, NameList } from '@/components/social/bits';
import { useFriendIds, useKeyringVersion } from '@/lib/hooks';
import { keyring } from '@/lib/keys/keyring';
import { me, useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { longDate, plural, when } from '@/lib/format';
import { readPost } from '@/lib/content';
import { sb } from '@/lib/supabase';
import {
  acceptInvite, approveRequest, askToJoin, containerPosts, deleteGroup, deliverMemberKeys, getGroup, groupDocRows,
  groupName, groupPreview, inviteToGroup, leave, membersOf, postToGroup, readGroup, removeMember, resealGroup,
  rotateIfNeeded, saveDoc, setRole, updateGroup, GROUP_COLORS, type GroupInfo, type GroupPrivacy, type GroupRow, type MemberRow,
} from '@/lib/groups';
import type { PostRow } from '@/lib/types';
import { Wall } from './Wall';
import { ErrorBox, GroupIcon, PrivacyLabel, PublicWarning, useAction } from './bits';

export type GroupTab = 'wall' | 'info' | 'docs' | 'members';

interface GroupData { g: GroupRow | null; preview: { privacy: GroupPrivacy; creator_id: string } | null; members: MemberRow[]; mine: MemberRow | null }

function useGroupData(id: string) {
  const { status } = useSession();
  return useQuery({
    queryKey: ['group', id], enabled: status === 'ready',
    queryFn: async (): Promise<GroupData> => {
      const g = await getGroup(id);
      if (!g) return { g: null, preview: await groupPreview(id).catch(() => null), members: [], mine: null };
      const members = await membersOf(g.audience_id);
      return { g, preview: null, members, mine: members.find((m) => m.member_id === me()) ?? null };
    },
  });
}

export function GroupView({ id, tab, docId }: { id: string; tab: GroupTab; docId?: string }) {
  useKeyringVersion();
  usePeopleVersion();
  const q = useGroupData(id);
  const qc = useQueryClient();
  const router = useRouter();
  const act = useAction();
  const g = q.data?.g ?? null;
  const members = useMemo(() => q.data?.members ?? [], [q.data]);
  const mine = q.data?.mine ?? null;
  const active = members.filter((m) => m.status === 'active');
  const isMember = mine?.status === 'active';
  const isAdmin = !!g && (g.creator_id === mine?.member_id || (isMember && mine?.role === 'admin'));
  const signers = useMemo(() => (isMember && g ? new Set([g.creator_id, ...active.filter((m) => m.role === 'admin').map((m) => m.member_id)]) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMember, g?.creator_id, members]);
  const info = g ? readGroup(g, signers) : null;
  const name = g && info ? groupName(g, info) : 'Group';
  const refresh = () => qc.invalidateQueries({ queryKey: ['group', id] });

  // Keep keys flowing: members fetch keys they lack; admins deliver keys (incl. history) to
  // members and rotate when someone who left or was removed still holds the current key.
  const maint = useRef<string | null>(null);
  useEffect(() => {
    if (!g || !mine || maint.current === `${g.id}:${g.envelope_epoch}:${isAdmin}`) return;
    maint.current = `${g.id}:${g.envelope_epoch}:${isAdmin}`;
    void (async () => {
      if (info && !info.ok && info.reason === 'waiting') { await keyring.load().catch(() => undefined); await qc.invalidateQueries({ queryKey: ['group', id] }); }
      if (!isAdmin || g.privacy === 'open') return;
      const rotated = await rotateIfNeeded(g.audience_id).catch(() => false);
      if (rotated) {
        const fresh = await getGroup(g.id);
        if (fresh && info?.ok) await resealGroup(fresh, info.value).catch(() => undefined);
        await qc.invalidateQueries({ queryKey: ['group', id] });
      }
      await deliverMemberKeys(g.audience_id).catch(() => 0);
    })();
  }, [g, mine, isAdmin, info, qc, id]);

  if (q.isLoading) return <AppPage active="groups" right={null}><div className="gray">Loading&hellip;</div></AppPage>;
  if (q.isError) return <AppPage active="groups" right={null}><div className="err">Couldn&rsquo;t load this group.</div></AppPage>;

  if (!g) {
    const pv = q.data?.preview;
    return (
      <AppPage active="groups" right={null}>
        {pv?.privacy === 'closed' ? <AskToJoin groupId={id} /> : (
          <div className="note">This group does not exist or you do not have permission to see it.</div>
        )}
      </AppPage>
    );
  }

  const color = info?.ok ? info.value.color : undefined;
  const tabs: [GroupTab, string, string][] = [['wall', 'Wall', ''], ['info', 'Info', '/info'], ['docs', 'Docs', '/docs'], ['members', 'Members', '/members']];
  const canSee = isMember || g.privacy === 'open';

  let actions: ReactNode = null;
  if (mine?.status === 'invited') {
    actions = <>
      <button type="button" className="btn b" disabled={act.busy} onClick={() => void act.run(async () => { await acceptInvite(g.audience_id); await refresh(); await qc.invalidateQueries({ queryKey: ['groups'] }); })}>Join Group</button>
      <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await leave(g.audience_id); await qc.invalidateQueries({ queryKey: ['groups'] }); router.push('/groups'); })}>Ignore</button>
    </>;
  } else if (mine?.status === 'requested') {
    actions = <><span className="gray">Request sent</span>
      <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await leave(g.audience_id); await refresh(); })}>Cancel Request</button></>;
  } else if (isMember && g.creator_id !== mine?.member_id) {
    actions = <LeaveButton g={g} onLeft={() => { void qc.invalidateQueries({ queryKey: ['groups'] }); router.push('/groups'); }} />;
  } else if (!mine && g.privacy === 'open') {
    actions = <button type="button" className="btn b" disabled={act.busy} onClick={() => void act.run(async () => { await askToJoin(g.id); await refresh(); })}>Join Group</button>;
  }

  let body: ReactNode;
  if (!canSee && tab !== 'info') {
    body = mine?.status === 'invited'
      ? <div className="note"><Icon name="lock" /> Join the group to see its posts, docs and members.</div>
      : <div className="note"><Icon name="lock" /> Only members can see posts, docs and members of this group.</div>;
  } else if (tab === 'info') {
    body = <InfoTab g={g} info={info?.ok ? info.value : null} members={active} isAdmin={isAdmin} onSaved={refresh}
      onDeleted={() => { void qc.invalidateQueries({ queryKey: ['groups'] }); router.push('/groups'); }} />;
  } else if (tab === 'members') {
    body = <MembersTab g={g} name={name} members={members} isAdmin={isAdmin} isMember={isMember} info={info?.ok ? info.value : null} onChange={refresh} />;
  } else if (tab === 'docs') {
    body = <DocsTab g={g} docId={docId} canEdit={isMember} isAdmin={isAdmin} />;
  } else {
    body = (
      <>
        {info && !info.ok && info.reason === 'waiting' && (
          <div className="note"><Icon name="lock" /> Waiting for an admin&rsquo;s device to share this group&rsquo;s key with you. It arrives
            automatically the next time one of them is online.</div>
        )}
        {g.privacy === 'open' && isMember && <PublicWarning what="Posts in this Open group" />}
        <Wall queryKey={['wall', 'group', g.id]} load={(before) => containerPosts('group_id', g.id, before)}
          publish={isMember ? (text) => postToGroup(g, { text }) : undefined}
          isPublic={g.privacy === 'open'} audienceLabel={name}
          filter={(r) => r.kind !== 'note'}
          wallContext={g.id} canModerate={isAdmin}
          placeholder="Write something..." empty="No posts yet. Be the first to post something." />
      </>
    );
  }

  return (
    <AppPage active="groups" right={canSee ? <GroupRight g={g} members={active} /> : null}>
      <div className="cm-head">
        <GroupIcon color={color} label={name} />
        <div className="cm-ttl">
          <h2>{name}</h2>
          <PrivacyLabel privacy={g.privacy} />
        </div>
        <div className="cm-acts">{actions}</div>
      </div>
      <ErrorBox error={act.error} />
      {mine?.status === 'invited' && mine.invited_by && (
        <div className="cm-inv"><Icon name="group" /> <span><NameLink id={mine.invited_by} /> invited you to join this group.</span></div>
      )}
      <nav className="tabs2" aria-label="Group sections">
        {tabs.map(([k, l, p]) => <Link key={k} className={k === tab ? 'on' : ''} aria-current={k === tab ? 'page' : undefined} href={`/groups/${g.id}${p}`}>{l}</Link>)}
      </nav>
      {body}
    </AppPage>
  );
}

function AskToJoin({ groupId }: { groupId: string }) {
  const act = useAction();
  const [sent, setSent] = useState(false);
  const qc = useQueryClient();
  return (
    <>
      <div className="cm-head"><GroupIcon label="Closed group" /><div className="cm-ttl"><h2>Closed Group</h2>
        <span className="cm-enc"><Icon name="lock" /> Encrypted &middot; only members can see its name, members and posts</span></div></div>
      <ErrorBox error={act.error} />
      <div className="note">
        <Icon name="lock" /> This is a closed group. Only members can see posts and docs.{' '}
        {sent ? <b>Your request has been sent to the group&rsquo;s admins.</b> : (
          <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(async () => {
            await askToJoin(groupId); setSent(true); await qc.invalidateQueries({ queryKey: ['group', groupId] });
          })}>Ask to Join Group</button>
        )}
      </div>
    </>
  );
}

function LeaveButton({ g, onLeft }: { g: GroupRow; onLeft: () => void }) {
  const [ask, setAsk] = useState(false);
  return <>
    <button type="button" className="btn" onClick={() => setAsk(true)}>Leave Group</button>
    {ask && <ConfirmDialog title="Leave Group" confirmLabel="Leave Group" onClose={() => setAsk(false)}
      onConfirm={async () => { await leave(g.audience_id); onLeft(); }}>
      Are you sure you want to leave this group? You won&rsquo;t be able to read anything posted after you leave.
    </ConfirmDialog>}
  </>;
}

function GroupRight({ g, members }: { g: GroupRow; members: MemberRow[] }) {
  usePeopleVersion();
  return (
    <RightBox title={`Members (${members.length})`} action={<Link href={`/groups/${g.id}/members`}>See All</Link>}>
      {members.slice(0, 8).map((m) => (
        <div className="rl" key={m.member_id}><AvatarLink id={m.member_id} size={24} /><NameLink id={m.member_id} bold={false} />
          {m.role === 'admin' || m.member_id === g.creator_id ? <span className="gray">&nbsp;&middot; Admin</span> : null}</div>
      ))}
    </RightBox>
  );
}

// ---------------------------------------------------------------------------------------
// Info (+ edit / delete for admins)

function InfoTab({ g, info, members, isAdmin, onSaved, onDeleted }:
  { g: GroupRow; info: GroupInfo | null; members: MemberRow[]; isAdmin: boolean; onSaved: () => void; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const admins = [g.creator_id, ...members.filter((m) => m.role === 'admin' && m.member_id !== g.creator_id).map((m) => m.member_id)];
  if (editing && info) return <EditGroup g={g} info={info} onDone={() => { setEditing(false); onSaved(); }} />;
  return (
    <div className="isec">
      <h3><span>Basic Information</span>{isAdmin && info ? <a role="button" tabIndex={0} onClick={() => setEditing(true)} onKeyDown={(e) => { if (e.key === 'Enter') setEditing(true); }}>Edit Group</a> : null}</h3>
      <table><tbody>
        <tr><td className="l">Description:</td><td style={{ whiteSpace: 'pre-wrap' }}>{info?.description || <span className="gray">No description.</span>}</td></tr>
        <tr><td className="l">Privacy:</td><td><PrivacyLabel privacy={g.privacy} /></td></tr>
        {members.length > 0 && <tr><td className="l">Admins:</td><td><NameList ids={admins} max={6} /></td></tr>}
        <tr><td className="l">Created:</td><td>{longDate(g.created_at)}</td></tr>
      </tbody></table>
      {g.creator_id === mineId() && (
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={() => setAskDelete(true)}>Delete Group</button>
        </div>
      )}
      {askDelete && <ConfirmDialog title="Delete Group" confirmLabel="Delete Group" onClose={() => setAskDelete(false)}
        onConfirm={async () => { await deleteGroup(g); onDeleted(); }}>
        This permanently deletes the group, its posts and docs for everyone. This can&rsquo;t be undone.
      </ConfirmDialog>}
    </div>
  );
}

function mineId() { try { return me(); } catch { return ''; } }

function EditGroup({ g, info, onDone }: { g: GroupRow; info: GroupInfo; onDone: () => void }) {
  const [name, setName] = useState(info.name);
  const [desc, setDesc] = useState(info.description ?? '');
  const [color, setColor] = useState(info.color ?? GROUP_COLORS[0]!);
  const [privacy, setPrivacy] = useState<GroupPrivacy>(g.privacy);
  const { busy, error, setError, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Your group needs a name.'); return; }
    if (await run(() => updateGroup(g, { name: name.trim().slice(0, 120), description: desc.trim().slice(0, 2000), color }, privacy))) onDone();
  };
  return (
    <form onSubmit={(e) => void save(e)}>
      <div className="sub"><span>Edit Group</span></div>
      <ErrorBox error={error} />
      <table className="form"><tbody>
        <tr><td className="l"><label htmlFor="eg-name">Group Name:</label></td><td><input id="eg-name" type="text" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></td></tr>
        <tr><td className="l"><label htmlFor="eg-desc">Description:</label></td><td><textarea id="eg-desc" value={desc} maxLength={2000} onChange={(e) => setDesc(e.target.value)} /></td></tr>
        <tr><td className="l">Icon:</td><td><div className="cm-colors" role="group" aria-label="Group icon color">
          {GROUP_COLORS.map((c) => <button key={c} type="button" aria-pressed={color === c} aria-label={`Color ${c}`} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div></td></tr>
        {g.privacy !== 'open' && <tr><td className="l">Privacy:</td><td className="cm-radio">
          <label><input type="radio" name="eg-p" checked={privacy === 'closed'} onChange={() => setPrivacy('closed')} /> <b>Closed</b></label>
          <label><input type="radio" name="eg-p" checked={privacy === 'secret'} onChange={() => setPrivacy('secret')} /> <b>Secret</b> (never shown on members&rsquo; profiles)</label>
        </td></tr>}
        {g.privacy === 'open' && <tr><td /><td><PublicWarning what="An Open group's name and description" /></td></tr>}
        <tr><td /><td><button type="submit" className="btn b" disabled={busy}>{busy ? 'Saving…' : 'Save Changes'}</button>{' '}
          <button type="button" className="btn" onClick={onDone}>Cancel</button></td></tr>
      </tbody></table>
    </form>
  );
}

// ---------------------------------------------------------------------------------------
// Members: list, invite friends, requests, admin tools

function MembersTab({ g, name, members, isAdmin, isMember, info, onChange }:
  { g: GroupRow; name: string; members: MemberRow[]; isAdmin: boolean; isMember: boolean; info: GroupInfo | null; onChange: () => void }) {
  usePeopleVersion();
  const friends = useFriendIds();
  const [pick, setPick] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmRm, setConfirmRm] = useState<string | null>(null);
  const act = useAction();
  const active = members.filter((m) => m.status === 'active');
  const invited = members.filter((m) => m.status === 'invited');
  const requests = members.filter((m) => m.status === 'requested');
  const inGroup = new Set(members.map((m) => m.member_id));
  const candidates = (friends.data ?? []).filter((f) => !inGroup.has(f));
  const isAdminRow = (m: MemberRow) => m.role === 'admin' || m.member_id === g.creator_id;

  const invite = () => act.run(async () => {
    const n = await inviteToGroup(g, pick, name);
    setPick([]); setMsg(`${plural(n, 'invitation')} sent.`); onChange();
  });

  return (
    <>
      <ErrorBox error={act.error} />
      {msg && <div className="ok" role="status">{msg}</div>}
      {isMember && (
        <div style={{ marginBottom: 12 }}>
          <div className="sub"><span>Add Friends to Group</span></div>
          {candidates.length ? <>
            <div style={{ maxWidth: 320 }}><FriendPicker friends={candidates} value={pick} onChange={setPick} label="Search friends" /></div>
            <button type="button" className="btn b" style={{ marginTop: 6 }} disabled={act.busy || !pick.length} onClick={() => void invite()}>Invite</button>
          </> : <div className="gray">All your friends are already in this group (or invited).</div>}
        </div>
      )}

      {isAdmin && requests.length > 0 && <>
        <div className="sub"><span>Requests to Join ({requests.length})</span></div>
        <div className="list cm-reqs">
          {requests.map((m) => (
            <div className="it" key={m.member_id}>
              <AvatarLink id={m.member_id} size={32} />
              <div className="d"><NameLink id={m.member_id} /><br /><span className="gray">Asked {when(m.created_at)}</span></div>
              <div className="x">
                <button type="button" className="btn b" disabled={act.busy} onClick={() => void act.run(async () => { await approveRequest(g, m.member_id, name); onChange(); })}>Approve</button>
                <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await removeMember(g, m.member_id, info); onChange(); })}>Ignore</button>
              </div>
            </div>
          ))}
        </div>
      </>}

      <div className="sub"><span>Members ({active.length})</span></div>
      <div className="cm-members">
        {active.map((m) => (
          <div key={m.member_id}>
            <AvatarLink id={m.member_id} size={100} />
            <NameLink id={m.member_id} />
            {isAdminRow(m) && <div className="gray">Admin</div>}
            {isAdmin && m.member_id !== g.creator_id && m.member_id !== mineId() && (
              <div className="cm-macts">
                {m.role !== 'admin'
                  ? <a role="button" tabIndex={0} onClick={() => void act.run(async () => { await setRole(g.audience_id, m.member_id, 'admin'); onChange(); })}
                      onKeyDown={(e) => { if (e.key === 'Enter') void act.run(async () => { await setRole(g.audience_id, m.member_id, 'admin'); onChange(); }); }}>Make Admin</a>
                  : <a role="button" tabIndex={0} onClick={() => void act.run(async () => { await setRole(g.audience_id, m.member_id, 'member'); onChange(); })}
                      onKeyDown={(e) => { if (e.key === 'Enter') void act.run(async () => { await setRole(g.audience_id, m.member_id, 'member'); onChange(); }); }}>Remove Admin</a>}
                <a role="button" tabIndex={0} onClick={() => setConfirmRm(m.member_id)} onKeyDown={(e) => { if (e.key === 'Enter') setConfirmRm(m.member_id); }}>Remove</a>
              </div>
            )}
          </div>
        ))}
      </div>

      {invited.length > 0 && <>
        <div className="sub"><span>Invited ({invited.length})</span></div>
        <div className="list">
          {invited.map((m) => (
            <div className="it" key={m.member_id}>
              <AvatarLink id={m.member_id} size={32} />
              <div className="d"><NameLink id={m.member_id} /><br /><span className="gray">Invited{m.invited_by ? <> by {people.person(m.invited_by)?.name ?? 'a member'}</> : null} &middot; {when(m.created_at)}</span></div>
              {isAdmin && <div className="x"><button type="button" className="btn" disabled={act.busy}
                onClick={() => void act.run(async () => { await removeMember(g, m.member_id, info); onChange(); })}>Cancel Invitation</button></div>}
            </div>
          ))}
        </div>
      </>}

      {confirmRm && <ConfirmDialog title="Remove Member" confirmLabel="Remove" onClose={() => setConfirmRm(null)}
        onConfirm={async () => { await removeMember(g, confirmRm, info); onChange(); }}>
        Remove {people.person(confirmRm)?.name ?? 'this person'} from the group? The group gets a new key, so they won&rsquo;t be able
        to read anything posted afterwards.
      </ConfirmDialog>}
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Docs: notes in the group; members edit by adding revisions (see lib/groups.ts saveDoc).

interface Doc { id: string; original: PostRow; latest: PostRow; title: string; body: string; editors: string[] }

function useDocs(g: GroupRow) {
  return useQuery({ queryKey: ['docs', g.id], queryFn: () => groupDocRows(g.id) });
}

function buildDocs(rows: PostRow[], groupId: string): Doc[] {
  const ts = (r: PostRow) => Date.parse(r.edited_at ?? r.created_at);
  const originals = rows.filter((r) => !r.shared_post_id && r.group_id === groupId);
  const revs = new Map<string, PostRow[]>();
  rows.forEach((r) => { if (r.shared_post_id && r.group_id === groupId) revs.set(r.shared_post_id, [...(revs.get(r.shared_post_id) ?? []), r]); });
  const docs: Doc[] = [];
  for (const o of originals) {
    const versions = [o, ...(revs.get(o.id) ?? [])].sort((a, b) => ts(b) - ts(a));
    let latest: PostRow | null = null; let title = ''; let body = '';
    for (const v of versions) {
      const d = readPost(v);
      if (d.ok && d.value.note) { latest = v; title = d.value.note.title; body = d.value.note.body; break; }
    }
    if (!latest) continue;
    docs.push({ id: o.id, original: o, latest, title, body, editors: [...new Set(versions.map((v) => v.author_id))] });
  }
  return docs.sort((a, b) => ts(b.latest) - ts(a.latest));
}

function DocsTab({ g, docId, canEdit, isAdmin }: { g: GroupRow; docId?: string; canEdit: boolean; isAdmin: boolean }) {
  usePeopleVersion();
  useKeyringVersion();
  const q = useDocs(g);
  const qc = useQueryClient();
  const router = useRouter();
  const docs = buildDocs(q.data ?? [], g.id);
  const waiting = (q.data ?? []).some((r) => !readPost(r).ok);
  const [askDel, setAskDel] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['docs', g.id] });

  if (docId) {
    const doc = docs.find((d) => d.id === docId);
    if (q.isLoading) return <div className="gray">Loading&hellip;</div>;
    if (!doc) return <div className="note">This doc couldn&rsquo;t be found{waiting ? ' (or its key hasn’t reached your device yet)' : ''}. <Link href={`/groups/${g.id}/docs`}>Back to Docs</Link></div>;
    const canDelete = isAdmin || doc.editors.every((e) => e === mineId());
    return (
      <>
        <div style={{ marginBottom: 8 }}><Link href={`/groups/${g.id}/docs`}>&laquo; Back to Docs</Link></div>
        <h2 style={{ fontSize: 16, marginBottom: 4, wordBreak: 'break-word' }}>{doc.title}</h2>
        <div className="gray" style={{ marginBottom: 10 }}>Last edited by <NameLink id={doc.latest.author_id} bold={false} /> &middot; {when(doc.latest.edited_at ?? doc.latest.created_at)}</div>
        <div className="cm-doc">{doc.body}</div>
        {canEdit && <DocForm key={`${doc.latest.id}:${doc.latest.edited_at}`} g={g} doc={doc} onSaved={() => void refresh()} />}
        {canDelete && <div style={{ marginTop: 10 }}><button type="button" className="btn" onClick={() => setAskDel(true)}>Delete Doc</button></div>}
        {askDel && <ConfirmDialog title="Delete Doc" confirmLabel="Delete" onClose={() => setAskDel(false)} onConfirm={async () => {
          const ids = (q.data ?? []).filter((r) => r.shared_post_id === doc.id).map((r) => r.id);
          if (ids.length) { const r = await sb().from('posts').delete().in('id', ids); if (r.error) throw new Error(r.error.message); }
          const r = await sb().from('posts').delete().eq('id', doc.id); if (r.error) throw new Error(r.error.message);
          await refresh(); router.push(`/groups/${g.id}/docs`);
        }}>Delete &ldquo;{doc.title}&rdquo; and all of its versions?</ConfirmDialog>}
      </>
    );
  }

  return (
    <>
      {q.isLoading && <div className="gray">Loading&hellip;</div>}
      <div className="list">
        {docs.map((d) => (
          <div className="it" key={d.id}>
            <Icon name="note" />
            <div className="d"><Link className="big" href={`/groups/${g.id}/docs/${d.id}`}>{d.title}</Link><br />
              <span className="gray">Last edited by {people.person(d.latest.author_id)?.name ?? '…'} &middot; {when(d.latest.edited_at ?? d.latest.created_at)}</span></div>
          </div>
        ))}
      </div>
      {!q.isLoading && !docs.length && <div className="gray" style={{ margin: '6px 0 10px' }}>No docs yet.</div>}
      {waiting && <div className="gray" style={{ marginBottom: 8 }}><Icon name="lock" /> Some docs are waiting for a key from an admin&rsquo;s device.</div>}
      {canEdit && <DocForm g={g} onSaved={(id) => { void refresh(); router.push(`/groups/${g.id}/docs/${id}`); }} />}
    </>
  );
}

function DocForm({ g, doc, onSaved }: { g: GroupRow; doc?: Doc; onSaved: (docId: string) => void }) {
  const [title, setTitle] = useState(doc?.title ?? '');
  const [body, setBody] = useState(doc?.body ?? '');
  const { busy, error, setError, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) { setError('Your doc needs a title and some text.'); return; }
    let id = doc?.id ?? '';
    if (await run(async () => {
      const row = await saveDoc(g, title.trim(), body, doc?.id, doc?.latest);
      if (!doc) id = row.id;
    })) onSaved(id);
  };
  return (
    <form className="cm-docform" onSubmit={(e) => void save(e)}>
      <div className="sub"><span>{doc ? 'Edit Doc' : 'Create a Doc'}</span></div>
      <ErrorBox error={error} />
      <input type="text" aria-label="Title" placeholder="Title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <textarea aria-label="Doc text" placeholder="Write something..." value={body} maxLength={40000} onChange={(e) => setBody(e.target.value)} />
      <div style={{ textAlign: 'right', marginTop: 4 }}><button type="submit" className="btn b" disabled={busy}>{busy ? 'Saving…' : 'Save Doc'}</button></div>
    </form>
  );
}
