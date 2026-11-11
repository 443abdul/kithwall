'use client';
// Connections: find someone by exact handle (no public directory), requests (incoming / outgoing),
// your connections, and your invite link + QR code. Also redeems an invite link opened while signed in
// (/people?invite=…). Follow (docs/v2/10-follow-public.md): the accounts I follow, and, when I let people
// follow me, my followers (each can be removed, which also rotates my followers key).
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { useFriendIds, useRequests } from '@/lib/hooks';
import { me, useSession } from '@/lib/keys/session';
import { useFileUrl } from '@/lib/media';
import { people, usePerson } from '@/lib/people';
import { readRequestNote } from '@/lib/social/graph';
import type { FriendshipRow } from '@/lib/types';
import { HANDLE_RE, normalizeHandle, outgoingRequests, redeemInvite } from './data';
import { InviteCard } from './InviteCard';
import { PersonActions } from './PersonActions';
import { RequestSafety } from './RequestSafety';
import { AccountRow } from '@/components/explore/ExplorePeople';
import { ButtonLink } from '@/components/ui/Button';
import { myFollowers, myFollowing, removeFollower, type AccountCard } from '@/lib/follow/follow';

type Tab = 'connections' | 'requests' | 'following' | 'followers' | 'invite';

export function PeopleScreen({ invite, initialTab }: { invite?: string; initialTab?: Tab }) {
  const t = useT();
  useDocumentTitle(t('people.title'));
  const reqs = useRequests();
  const followOn = !!useSession().profile?.follow_enabled;
  const [tab, setTab] = useState<Tab>(initialTab ?? ((reqs.data?.length ?? 0) > 0 ? 'requests' : 'connections'));
  return (
    <Page title={t('people.title')} description={t('people.description')} back={{ href: '/you', label: t('common.back') }}
      context={<Card><InviteCard /></Card>}>
      {invite ? <RedeemInvite code={invite} /> : null}
      <SearchCard />
      <Tabs label={t('people.title')} value={tab} onChange={setTab} items={[
        { value: 'connections', label: t('people.tabConnections'), panel: <ConnectionsList /> },
        { value: 'requests', label: t('people.tabRequests'), count: reqs.data?.length, panel: <RequestsList /> },
        { value: 'following', label: t('follow.tabFollowing'), panel: <FollowingList /> },
        ...(followOn ? [{ value: 'followers' as Tab, label: t('follow.tabFollowers'), panel: <FollowersList /> }] : []),
        { value: 'invite', label: t('people.tabInvite'), panel: <Card><InviteCard /></Card> },
      ]} />
    </Page>
  );
}

function SearchCard() {
  const t = useT();
  const router = useRouter();
  const [value, setValue] = useState('');
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'invalid' } | { kind: 'none'; handle: string }>({ kind: 'idle' });

  async function find(e: FormEvent) {
    e.preventDefault();
    const h = normalizeHandle(value);
    if (!HANDLE_RE.test(h)) { setState({ kind: 'invalid' }); return; }
    setState({ kind: 'busy' });
    try {
      const row = await people.byUsername(h);
      if (row) router.push(`/u/${row.username}`);
      else setState({ kind: 'none', handle: h });
    } catch { setState({ kind: 'none', handle: h }); }
  }

  return (
    <Card>
      <form className="k-people-search" role="search" onSubmit={(e) => void find(e)}>
        <TextField label={t('people.searchLabel')} value={value} autoCapitalize="none" autoCorrect="off" spellCheck={false}
          inputMode="text" prefix={<span className="k-ltr">@</span>} dir="ltr"
          hint={state.kind === 'idle' || state.kind === 'busy' ? t('people.searchHint') : undefined}
          error={state.kind === 'invalid' ? t('people.searchInvalid') : state.kind === 'none' ? t('people.noMatch', { handle: state.handle }) : undefined}
          onChange={(e) => { setValue(e.target.value); if (state.kind !== 'busy') setState({ kind: 'idle' }); }} />
        <Button type="submit" variant="primary" icon="search" busy={state.kind === 'busy'} disabled={!value.trim()}>{t('people.search')}</Button>
      </form>
    </Card>
  );
}

export function PersonRow({ id, sub, trailing }: { id: string; sub?: React.ReactNode; trailing?: React.ReactNode }) {
  const p = usePerson(id);
  const avatar = useFileUrl(p?.info?.avatar?.thumb);
  const name = p?.name ?? '…';
  return (
    <div className="k-item k-person-row">
      <Link href={p ? `/u/${p.username}` : '#'} className="k-person-link">
        <span className="k-item-lead"><Avatar name={name} src={avatar} size={44} /></span>
        <span className="k-item-body">
          <span className="k-item-title">{name}</span>
          <span className="k-item-sub">{sub ?? (p ? <span className="k-ltr">@{p.username}</span> : null)}</span>
        </span>
      </Link>
      {trailing ? <span className="k-item-trail">{trailing}</span> : null}
    </div>
  );
}

function ConnectionsList() {
  const t = useT();
  const q = useFriendIds();
  if (q.isPending) return <div className="k-center"><Spinner /></div>;
  const ids = q.data ?? [];
  if (!ids.length) {
    return <Card><EmptyState icon="users" title={t('people.noConnectionsTitle')} body={t('people.noConnectionsBody')} /></Card>;
  }
  const sorted = [...ids].sort((a, b) => (people.person(a)?.name ?? '').localeCompare(people.person(b)?.name ?? ''));
  return (
    <div className="k-stack-sm">
      <p className="k-muted k-small">{t('people.count', { count: ids.length })}</p>
      <Card padding="flush">
        <ul className="k-list" role="list">
          {sorted.map((id) => <li key={id}><PersonRow id={id} trailing={<PersonActions userId={id} name={people.person(id)?.name ?? ''} compact />} /></li>)}
        </ul>
      </Card>
    </div>
  );
}

/** The accounts I follow (their public name and handle, as the server shows them). */
function FollowingList() {
  const t = useT();
  const { status } = useSession();
  const q = useQuery({ queryKey: ['follows', 'following'], enabled: status === 'ready', queryFn: () => myFollowing() });
  if (q.isPending) return <div className="k-center"><Spinner /></div>;
  if (!q.data?.length) {
    return (
      <Card><EmptyState icon="compass" title={t('follow.noFollowingTitle')} body={t('follow.noFollowingBody')}
        actions={<ButtonLink href="/explore?tab=people" variant="primary" icon="search">{t('follow.findAccounts')}</ButtonLink>} /></Card>
    );
  }
  return (
    <div className="k-stack-sm">
      <p className="k-muted k-small">{t('follow.followingCount', { count: q.data.length })}</p>
      <Card padding="flush">
        <ul className="k-list" role="list">
          {q.data.map((a) => <li key={a.id}><AccountRow account={a} following /></li>)}
        </ul>
      </Card>
    </div>
  );
}

/** People who follow me. Connections count as followers too and are listed under Connections. */
function FollowersList() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { status } = useSession();
  const q = useQuery({ queryKey: ['follows', 'followers'], enabled: status === 'ready', queryFn: () => myFollowers() });
  const [busy, setBusy] = useState<string | null>(null);
  async function remove(a: AccountCard) {
    const name = a.name?.trim() || `@${a.username}`;
    setBusy(a.id);
    try {
      await removeFollower(a.id);
      await qc.invalidateQueries({ queryKey: ['follows'] });
      toast({ message: t('follow.followerRemoved', { name }) });
    } catch { toast({ message: t('feed.failed'), tone: 'danger' }); } finally { setBusy(null); }
  }
  if (q.isPending) return <div className="k-center"><Spinner /></div>;
  if (!q.data?.length) return <Card><EmptyState icon="userCheck" title={t('follow.noFollowersTitle')} body={t('follow.noFollowersBody')} /></Card>;
  return (
    <div className="k-stack-sm">
      <p className="k-muted k-small">{t('follow.followersListNote', { count: q.data.length })}</p>
      <Card padding="flush">
        <ul className="k-list" role="list">
          {q.data.map((a) => {
            const name = a.name?.trim() || `@${a.username}`;
            return (
              <li key={a.id}>
                <div className="k-item k-person-row">
                  <Link href={`/u/${a.username}`} className="k-person-link">
                    <span className="k-item-lead"><Avatar name={name} size={44} /></span>
                    <span className="k-item-body">
                      <span className="k-item-title">{name}</span>
                      <span className="k-item-sub"><span className="k-ltr">@{a.username}</span></span>
                    </span>
                  </Link>
                  <span className="k-item-trail">
                    <Button size="sm" variant="ghost" busy={busy === a.id} disabled={busy !== null} onClick={() => void remove(a)}>{t('follow.removeFollower')}</Button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function RequestsList() {
  const t = useT();
  const incoming = useRequests();
  const { status } = useSession();
  const outgoing = useQuery({ queryKey: ['people-requests', 'outgoing'], enabled: status === 'ready', queryFn: outgoingRequests });
  if (incoming.isPending) return <div className="k-center"><Spinner /></div>;
  const inc = incoming.data ?? [];
  const out = outgoing.data ?? [];
  if (!inc.length && !out.length) {
    return <Card><EmptyState icon="users" title={t('people.noRequests')} body={t('people.noRequestsBody')} /></Card>;
  }
  return (
    <div className="k-stack">
      {inc.length ? (
        <section className="k-stack-sm" aria-labelledby="req-in">
          <h2 id="req-in" className="k-section-title">{t('people.incoming')}</h2>
          <Card padding="flush">
            <ul className="k-list" role="list">
              {inc.map((f) => <li key={f.requested_by}><IncomingRow f={f} /></li>)}
            </ul>
          </Card>
        </section>
      ) : null}
      {out.length ? (
        <section className="k-stack-sm" aria-labelledby="req-out">
          <h2 id="req-out" className="k-section-title">{t('people.outgoing')}</h2>
          <Card padding="flush">
            <ul className="k-list" role="list">
              {out.map((id) => <li key={id}><PersonRow id={id} trailing={<PersonActions userId={id} name={people.person(id)?.name ?? ''} compact />} /></li>)}
            </ul>
          </Card>
        </section>
      ) : null}
    </div>
  );
}

function IncomingRow({ f }: { f: FriendshipRow }) {
  const t = useT();
  const p = usePerson(f.requested_by);
  const note = p ? readRequestNote(f) : null;
  return (
    <PersonRow id={f.requested_by}
      sub={<>{note ? t('people.note', { note }) : t('people.wantsToConnect')}<RequestSafety userId={f.requested_by} compact /></>}
      trailing={<PersonActions userId={f.requested_by} name={p?.name ?? ''} compact />} />
  );
}

function RedeemInvite({ code }: { code: string }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function accept() {
    setBusy(true); setErr(null);
    try {
      const inviter = await redeemInvite(code);
      if (inviter === me()) { setErr(t('people.redeemSelf')); return; }
      await qc.invalidateQueries({ queryKey: ['friends'] });
      await qc.invalidateQueries({ queryKey: ['people-requests'] });
      toast({ message: t('people.requestSent') });
      setOpen(false);
      const p = people.get(inviter);
      router.replace(p ? `/u/${p.username}` : '/people');
    } catch {
      setErr(t('people.redeemInvalid'));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onClose={() => { setOpen(false); router.replace('/people'); }} title={t('people.redeemTitle')} dismissible={!busy}
      footer={<>
        <Button variant="ghost" onClick={() => { setOpen(false); router.replace('/people'); }} disabled={busy}>{t('feed.cancel')}</Button>
        <Button variant="primary" icon="userPlus" busy={busy} onClick={() => void accept()} disabled={!!err}>{t('people.redeemSend')}</Button>
      </>}>
      <div className="k-stack">
        <p>{t('people.redeemBody')}</p>
        <p className="k-muted k-small"><Icon name="lock" /> {t('feed.sealed')}</p>
        {err ? <p className="k-error" role="alert"><Icon name="alert" />{err}</p> : null}
      </div>
    </Dialog>
  );
}
