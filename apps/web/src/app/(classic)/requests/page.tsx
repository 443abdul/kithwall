'use client';
// Requests (reference vReqs): friend requests with their encrypted intro notes, requests you've
// sent, and People You May Know (computed on this device).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { TipsBox } from '@/components/feed/RightColumn';
import { AvatarLink } from '@/components/Avatar';
import { PersonRow } from '@/components/social/PersonRow';
import Link from 'next/link';
import { useFriendIds, useRequests } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { acceptFriend, cancelRequest, ignoreRequest } from '@/lib/friends';
import { readRequestNote, sentRequests } from '@/lib/social/graph';
import { friendsOfFriends, peopleYouMayKnow } from '@/lib/social/profile';
import { getPrefs, hidePymk, usePrefsVersion } from '@/lib/social/local';
import { plural, when } from '@/lib/format';
import '@/styles/social.css';

function Requests() {
  usePeopleVersion();
  usePrefsVersion();
  const { userId, status } = useSession();
  const qc = useQueryClient();
  const reqs = useRequests();
  const friends = useFriendIds();
  const sent = useQuery({
    queryKey: ['friends', 'sent'], enabled: status === 'ready',
    queryFn: sentRequests,
  });
  const fof = useQuery({
    queryKey: ['friends', 'fof', (friends.data ?? []).join(',')], enabled: !!friends.data,
    queryFn: async () => { const ids = friendsOfFriends(friends.data ?? []).slice(0, 300); await people.ensure(ids); return ids.length; },
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); }
    await Promise.all([qc.invalidateQueries({ queryKey: ['requests'] }), qc.invalidateQueries({ queryKey: ['friends'] })]);
    setBusy(null);
  };
  const mine = friends.data ?? [];
  const mutualCount = (id: string) => mine.filter((f) => people.person(f)?.info?.friends?.includes(id)).length;
  const exclude = new Set([...getPrefs().hiddenPymk, ...(sent.data ?? []), ...(reqs.data ?? []).map((r) => r.requested_by)]);
  const pymk = userId && fof.data !== undefined ? peopleYouMayKnow(userId, mine, exclude).filter((x) => people.get(x.id)).slice(0, 12) : [];

  return (
    <>
      <Title icon="friends">Requests</Title>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="sub"><span>Friend Requests</span></div>
      {reqs.isLoading ? <div className="gray">Loading…</div> : (reqs.data ?? []).length ? (
        <div className="list">
          {(reqs.data ?? []).map((r) => {
            const p = people.person(r.requested_by);
            const note = readRequestNote(r);
            const n = mutualCount(r.requested_by);
            return (
              <div className="it" key={r.requested_by}>
                <AvatarLink id={r.requested_by} size={50} />
                <div className="d">
                  <b>{p ? <Link href={`/${p.username}`}>{p.name}</Link> : '…'}</b>
                  {p ? <span className="gray"> @{p.username}</span> : null}<br />
                  <span className="gray">{n ? `${plural(n, 'mutual friend')} · ` : ''}{when(r.created_at)}</span>
                  {note && <div className="kw-intro">&ldquo;{note}&rdquo;</div>}
                </div>
                <div className="x">
                  <button type="button" className="btn b" disabled={busy === r.requested_by} onClick={() => void act(r.requested_by, () => acceptFriend(r.requested_by))}>Confirm</button>{' '}
                  <button type="button" className="btn" disabled={busy === r.requested_by} onClick={() => void act(r.requested_by, () => ignoreRequest(r.requested_by))}>Not Now</button>
                </div>
              </div>
            );
          })}
        </div>
      ) : <div className="gray">No pending friend requests.</div>}

      {(sent.data ?? []).length > 0 && <>
        <div className="sub"><span>Requests You&rsquo;ve Sent</span></div>
        <div className="list">
          {(sent.data ?? []).map((id) => (
            <PersonRow key={id} id={id} rel="sent" self={userId}
              extra={<button type="button" className="kw-link" disabled={busy === id} onClick={() => void act(id, () => cancelRequest(id))}>Cancel request</button>} />
          ))}
        </div>
      </>}

      <div className="sub" id="pymk"><span>People You May Know</span></div>
      <p className="gray small" style={{ marginBottom: 6 }}>Suggestions are worked out on your device from the friend lists your friends share with you. Kithwall&rsquo;s servers don&rsquo;t analyse your connections.</p>
      {pymk.length ? (
        <div className="list">
          {pymk.map(({ id, mutual }) => (
            <PersonRow key={id} id={id} rel="none" self={userId}
              extra={<><span className="gray">{plural(mutual, 'mutual friend')}</span> &middot; <button type="button" className="kw-link" onClick={() => hidePymk(id)}>Hide</button></>} />
          ))}
        </div>
      ) : <div className="gray">No suggestions right now.</div>}
    </>
  );
}

export default function Page() {
  return <AppPage active="friends" right={<TipsBox />}><Requests /></AppPage>;
}
