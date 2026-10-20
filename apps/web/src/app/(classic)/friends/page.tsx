'use client';
// Edit Friends (reference vFriends): all friends with search, unfriend, and friend lists.
import Link from 'next/link';
import { useState } from 'react';
import { AppPage, Title } from '@/components/Shell';
import { TipsBox } from '@/components/feed/RightColumn';
import { PersonRow } from '@/components/social/PersonRow';
import { FriendLists } from '@/components/social/FriendLists';
import { useFriendIds } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import '@/styles/social.css';

function Friends() {
  usePeopleVersion();
  const { userId } = useSession();
  const friends = useFriendIds();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'all' | 'lists'>(() => (typeof location !== 'undefined' && location.hash === '#lists' ? 'lists' : 'all'));
  const ids = [...(friends.data ?? [])].sort((a, b) => (people.person(a)?.name ?? '').localeCompare(people.person(b)?.name ?? ''));
  const ql = q.trim().toLowerCase();
  const shown = ids.filter((f) => !ql || (people.person(f)?.name ?? '').toLowerCase().includes(ql) || (people.person(f)?.username ?? '').includes(ql));
  const go = (t: 'all' | 'lists') => { setTab(t); history.replaceState(null, '', t === 'lists' ? '#lists' : location.pathname); };
  return (
    <>
      <Title icon="friends" right={<><Link href="/search">Find Friends</Link> &middot; <Link href="/requests">Requests</Link></>}>Edit Friends</Title>
      <div className="tabs2" role="tablist">
        <a role="tab" tabIndex={0} aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => go('all')} onKeyDown={(e) => { if (e.key === 'Enter') go('all'); }}>All Friends</a>
        <a role="tab" tabIndex={0} aria-selected={tab === 'lists'} className={tab === 'lists' ? 'on' : ''} onClick={() => go('lists')} onKeyDown={(e) => { if (e.key === 'Enter') go('lists'); }}>Friend Lists</a>
      </div>
      {tab === 'all' ? (
        <>
          <div className="kw-filter"><b>Friends ({ids.length})</b>
            <input type="text" placeholder="Search friends" aria-label="Search friends" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {friends.isLoading ? <div className="gray">Loading…</div> : (
            <div className="list">
              {shown.map((f) => <PersonRow key={f} id={f} rel="friends" self={userId} />)}
              {!ids.length && <p className="kw-pad">You don&rsquo;t have any friends yet. <Link href="/search">Find people you know.</Link></p>}
              {ids.length > 0 && !shown.length && <p className="gray kw-pad">No friends match &ldquo;{q}&rdquo;.</p>}
            </div>
          )}
        </>
      ) : <FriendLists friends={ids} />}
    </>
  );
}

export default function Page() {
  return <AppPage active="friends" right={<TipsBox />}><Friends /></AppPage>;
}
