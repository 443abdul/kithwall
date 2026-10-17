'use client';
// /groups — your groups, invitations, pending requests and (when Public is on) open groups.
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AppPage, RightBox, Title } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { NameLink } from '@/components/Avatar';
import { useAppSetting, useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { usePeopleVersion } from '@/lib/people';
import { sb, must } from '@/lib/supabase';
import { plural } from '@/lib/format';
import {
  acceptInvite, askToJoin, groupName, leave, listGroups, myMemberships, readGroup, type GroupRow, type MemberRow,
} from '@/lib/groups';
import { ErrorBox, GroupIcon, PRIVACY_LABEL, useAction, useRetryKeys } from './bits';

interface HomeData { groups: GroupRow[]; mine: Map<string, MemberRow>; counts: Map<string, number> }

export function useGroupsHome() {
  const { status } = useSession();
  return useQuery({
    queryKey: ['groups', 'home'], enabled: status === 'ready',
    queryFn: async (): Promise<HomeData> => {
      const [groups, memberships] = await Promise.all([listGroups(), myMemberships()]);
      const mine = new Map(memberships.map((m) => [m.audience_id, m]));
      const active = groups.filter((g) => mine.get(g.audience_id)?.status === 'active').map((g) => g.audience_id);
      const counts = new Map<string, number>();
      if (active.length) {
        const rows = must(await sb().from('audience_members').select('audience_id').in('audience_id', active).eq('status', 'active')) as { audience_id: string }[];
        rows.forEach((r) => counts.set(r.audience_id, (counts.get(r.audience_id) ?? 0) + 1));
      }
      return { groups, mine, counts };
    },
  });
}

export function GroupsHome() {
  useKeyringVersion();
  usePeopleVersion();
  const q = useGroupsHome();
  const pub = useAppSetting('public_audience_enabled');
  const qc = useQueryClient();
  const act = useAction();
  const data = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['groups'] });
  useRetryKeys(!!data?.groups.some((g) => { const d = readGroup(g); return !d.ok && d.reason === 'waiting'; }), ['groups', 'home']);

  const invited = data?.groups.filter((g) => data.mine.get(g.audience_id)?.status === 'invited') ?? [];
  const requested = data?.groups.filter((g) => data.mine.get(g.audience_id)?.status === 'requested') ?? [];
  const mine = data?.groups.filter((g) => data.mine.get(g.audience_id)?.status === 'active') ?? [];
  const open = pub.data ? data?.groups.filter((g) => g.privacy === 'open' && !data.mine.has(g.audience_id)) ?? [] : [];

  const row = (g: GroupRow, extra: ReactNode, sub?: ReactNode) => {
    const d = readGroup(g);
    const name = groupName(g, d);
    const n = data?.counts.get(g.audience_id);
    return (
      <div className="it" key={g.id}>
        <GroupIcon color={d.ok ? d.value.color : undefined} href={`/groups/${g.id}`} label={name} />
        <div className="d">
          <Link className="big" href={`/groups/${g.id}`}>{name}</Link><br />
          <span className="gray"><Icon name={g.privacy === 'open' ? 'globe' : 'lock'} /> {PRIVACY_LABEL[g.privacy]}{n ? <> &middot; {plural(n, 'member')}</> : null}</span>
          {sub ? <><br />{sub}</> : null}
        </div>
        <div className="x">{extra}</div>
      </div>
    );
  };

  return (
    <AppPage active="groups" right={<GroupsRight />}>
      <Title icon="group" right={<Link className="btn" href="/groups/new">+ Create Group</Link>}>Groups</Title>
      <div className="note"><Icon name="group" /> <b>Groups are a private space for small groups of people to share.</b> Post updates,
        write docs together, and see what the people closest to you are up to. Closed and Secret groups are end-to-end encrypted:
        only members can read them.</div>
      <ErrorBox error={act.error} />
      {q.isLoading && <div className="gray">Loading&hellip;</div>}
      {q.isError && <div className="err">Couldn&rsquo;t load your groups.</div>}

      {invited.length > 0 && <>
        <div className="sub"><span>Group Invitations</span></div>
        <div className="list">
          {invited.map((g) => {
            const m = data!.mine.get(g.audience_id)!;
            return row(g, <>
              <button type="button" className="btn b" disabled={act.busy} onClick={() => void act.run(async () => { await acceptInvite(g.audience_id); await refresh(); })}>Join Group</button>{' '}
              <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await leave(g.audience_id); await refresh(); })}>Ignore</button>
            </>, m.invited_by ? <span className="gray"><NameLink id={m.invited_by} bold={false} /> invited you.</span> : null);
          })}
        </div>
      </>}

      <div className="sub"><span>Your Groups</span></div>
      <div className="list">
        {mine.map((g) => row(g, <span className="gray">{data!.mine.get(g.audience_id)?.role === 'admin' ? 'Admin' : 'Member'}</span>))}
        {data && !mine.length && <div className="gray" style={{ padding: '6px 0' }}>You aren&rsquo;t in any groups yet. <Link href="/groups/new">Create one</Link> with your friends.</div>}
      </div>

      {requested.length > 0 && <>
        <div className="sub"><span>Requests Waiting for Approval</span></div>
        <div className="list">
          {requested.map((g) => row(g, <button type="button" className="btn" disabled={act.busy}
            onClick={() => void act.run(async () => { await leave(g.audience_id); await refresh(); })}>Cancel Request</button>))}
        </div>
      </>}

      {open.length > 0 && <>
        <div className="sub"><span>Open Groups</span></div>
        <div className="list">
          {open.map((g) => row(g, <button type="button" className="btn" disabled={act.busy}
            onClick={() => void act.run(async () => { await askToJoin(g.id); await refresh(); })}>Join Group</button>))}
        </div>
      </>}
    </AppPage>
  );
}

function GroupsRight() {
  return (
    <RightBox title="About Group Privacy">
      <div style={{ lineHeight: '15px' }}>
        <p style={{ marginBottom: 6 }}><Icon name="lock" /> <b>Closed</b> and <b>Secret</b> groups are encrypted on your device.
          Kithwall can see who is in a group, but never its name, posts or docs.</p>
        <p style={{ marginBottom: 6 }}><b>Secret</b> groups are never shown on members&rsquo; profiles and can&rsquo;t be found.</p>
        <p>When someone leaves or is removed, the group gets a new key so they can&rsquo;t read anything posted afterwards.</p>
      </div>
    </RightBox>
  );
}
