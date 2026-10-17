'use client';
// News Feed right column (reference rcol): Requests, Pokes, Upcoming Birthdays, People You May
// Know (computed on this device from friends' encrypted friend lists) and Kithwall Tips where
// 2010 had "Sponsored" — there are no ads.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { AvatarLink } from '@/components/Avatar';
import { RightBox } from '@/components/Shell';
import { useFriendIds, usePokes, useRequests } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { poke, sendFriendRequest } from '@/lib/friends';
import { sentRequests } from '@/lib/social/graph';
import { daysUntilBirthday, friendsOfFriends, peopleYouMayKnow } from '@/lib/social/profile';
import { getPrefs, hidePymk, usePrefsVersion } from '@/lib/social/local';
import { sb, must } from '@/lib/supabase';
import { plural } from '@/lib/format';

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const TIPS: { t: string; s: string; href?: string }[] = [
  { t: 'Your posts are sealed', s: 'Everything you share with friends is encrypted on your device. Not even Kithwall can read it.' },
  { t: 'Save your recovery key', s: 'Your 24-word key is the only way back in if you forget your password. Keep it somewhere safe.', href: '/settings/security' },
  { t: 'Pick trusted friends', s: 'Choose 3–5 friends who can help you recover your account together.', href: '/settings/security' },
  { t: 'Make a friend list', s: 'Share some things only with "Close Friends" or "Family". Each list has its own key.', href: '/friends' },
  { t: 'No ads, ever', s: 'This box used to hold ads. Now it holds tips. Nobody is paying to see your News Feed.' },
  { t: 'Link previews stay private', s: 'When you share a link, we fetch the preview for you, so the site never sees your friends’ IP addresses.' },
];

export function TipsBox({ n = 2 }: { n?: number }) {
  const [day] = useState(() => Math.floor(Date.now() / 86_400_000));
  const list = Array.from({ length: n }, (_, i) => TIPS[(day + i * 2) % TIPS.length]!);
  return (
    <RightBox title="Kithwall Tips">
      {list.map((t) => (
        <div className="spon" key={t.t}>
          {t.href ? <Link href={t.href}><b>{t.t}</b></Link> : <b>{t.t}</b>}
          <div className="tx">{t.s}</div>
        </div>
      ))}
    </RightBox>
  );
}

export function SocialRightColumn() {
  usePeopleVersion();
  usePrefsVersion();
  const { userId, status } = useSession();
  const qc = useQueryClient();
  const reqs = useRequests();
  const pokes = usePokes();
  const friends = useFriendIds();
  const sent = useQuery({ queryKey: ['friends', 'sent'], enabled: status === 'ready', queryFn: sentRequests });
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const tried = useRef(new Set<string>());

  // Load profile rows for friends-of-friends once (names/usernames for suggestions).
  const fof = friends.data ? friendsOfFriends(friends.data) : [];
  const fofKey = fof.join(',');
  useEffect(() => {
    const missing = fof.filter((id) => !tried.current.has(id));
    if (!missing.length) return;
    missing.forEach((id) => tried.current.add(id));
    void people.ensure(missing.slice(0, 300));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fofKey]);

  const myFriends = friends.data ?? [];
  const exclude = new Set([...getPrefs().hiddenPymk, ...(sent.data ?? []), ...added, ...(reqs.data ?? []).map((r) => r.requested_by)]);
  const pymk = userId ? peopleYouMayKnow(userId, myFriends, exclude).filter((x) => people.get(x.id)).slice(0, 2) : [];
  const bdays = myFriends
    .map((f) => ({ f, d: daysUntilBirthday(people.person(f)?.info) }))
    .filter((x): x is { f: string; d: number } => x.d !== null && x.d < 7)
    .sort((a, b) => a.d - b.d).slice(0, 3);

  const act = async (fn: () => Promise<unknown>, keys: string[][]) => {
    setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); }
    await Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
  };
  const nReq = reqs.data?.length ?? 0;

  return (
    <>
      {err && <div className="err" role="alert">{err}</div>}
      {bdays.length > 0 && (
        <RightBox title="Upcoming Birthdays">
          {bdays.map(({ f, d }) => {
            const p = people.person(f);
            return (
              <div className="rl" key={f}>
                <Icon name="cake" />
                <div>
                  {p ? <Link href={`/${p.username}`}>{p.name}</Link> : '…'}&rsquo;s birthday is {d === 0 ? <b>today</b> : d === 1 ? 'tomorrow' : WD[(new Date().getDay() + d) % 7]}.
                  {d === 0 && p ? <> <Link href={`/${p.username}`}>Write on {p.name.split(' ')[0]}&rsquo;s Wall</Link></> : null}
                </div>
              </div>
            );
          })}
        </RightBox>
      )}
      {nReq > 0 && (
        <RightBox title="Requests" action={<Link href="/requests">See All</Link>}>
          <div className="rl"><Icon name="friends" /><Link href="/requests">{plural(nReq, 'friend request')}</Link></div>
        </RightBox>
      )}
      {pymk.length > 0 && (
        <RightBox title="People You May Know" action={<Link href="/requests#pymk">See All</Link>}>
          {pymk.map(({ id, mutual }) => {
            const p = people.person(id);
            return (
              <div className="rr" key={id}>
                <AvatarLink id={id} size={50} />
                <div>
                  {p ? <Link href={`/${p.username}`}>{p.name}</Link> : '…'}
                  <div className="gray">{plural(mutual, 'mutual friend')}</div>
                  <div style={{ marginTop: 3 }}><Icon name="friends" />{' '}
                    <a role="button" tabIndex={0} onClick={() => { setAdded((a) => [...a, id]); void act(() => sendFriendRequest(id), [['friends']]); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { setAdded((a) => [...a, id]); void act(() => sendFriendRequest(id), [['friends']]); } }}>Add as friend</a>
                  </div>
                </div>
                <button type="button" className="x kw-x" title="Hide" aria-label={`Hide ${p?.name ?? 'suggestion'}`} onClick={() => hidePymk(id)}>&times;</button>
              </div>
            );
          })}
        </RightBox>
      )}
      {(pokes.data ?? []).length > 0 && (
        <RightBox title="Pokes" action={<Link href="/pokes">See All</Link>}>
          {(pokes.data ?? []).slice(0, 4).map((pk) => {
            const p = people.person(pk.from_id);
            return (
              <div className="rl" key={pk.from_id}>
                <Icon name="poke" />
                <div>
                  {p ? <Link href={`/${p.username}`}>{p.name}</Link> : '…'} poked you.{' '}
                  <a role="button" tabIndex={0} onClick={() => void act(() => poke(pk.from_id), [['pokes']])}
                    onKeyDown={(e) => { if (e.key === 'Enter') void act(() => poke(pk.from_id), [['pokes']]); }}>Poke Back</a>{' '}
                  <button type="button" className="kw-x gray" title="Remove" aria-label="Remove poke"
                    onClick={() => void act(async () => must(await sb().from('pokes').delete().match({ from_id: pk.from_id, to_id: userId! })), [['pokes']])}>&times;</button>
                </div>
              </div>
            );
          })}
        </RightBox>
      )}
      <TipsBox />
    </>
  );
}
