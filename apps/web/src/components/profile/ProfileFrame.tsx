'use client';
// Dec 2010 profile frame (reference vProfile/pleft): big picture, Wall/Info/Photos/Notes/Friends
// nav, bio, Mutual Friends and Friends boxes on the left; name, buttons, info strip and the
// tagged-photo strip on top. Tabs render their body as children.
//
// Profiles are visible to friends only: a non-friend sees the username (and directory name if
// the person opted in), a silhouette, Add as Friend / Message, and an explanation.
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppPage } from '@/components/Shell';
import { Avatar, AvatarLink, Silhouette } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { PhotoStrip } from '@/components/photos/PhotoStrip';
import { ChangeProfilePicture } from '@/components/photos/ChangeProfilePicture';
import { TipsBox } from '@/components/feed/RightColumn';
import { ProfileButtons } from './ProfileButtons';
import { InfoStrip } from './InfoStrip';
import { people, usePeopleVersion, usePerson, type Person } from '@/lib/people';
import { friendStatus } from '@/lib/friends';
import { useFriendIds, useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { isProfileUsername } from '@/lib/social/reserved';
import { mutualFriends } from '@/lib/social/profile';
import { reconcileAudiences } from '@/lib/social/graph';
import type { ProfileRow } from '@/lib/types';
import '@/styles/social.css';

export type ProfileTab = 'wall' | 'info' | 'photos' | 'notes' | 'friends';
export type Relation = 'self' | 'friends' | 'sent' | 'received' | 'none';

export interface ProfileCtx {
  id: string;
  row: ProfileRow;
  person: Person | null;
  rel: Relation;
  isMe: boolean;
  canSee: boolean;              // me or a friend
  friends: string[];            // this person's friends (decrypted list; mine if it's me)
}

export function useProfileRow(username: string) {
  const { status } = useSession();
  const valid = isProfileUsername(username);
  return useQuery({
    queryKey: ['profile', username.toLowerCase()], enabled: status === 'ready' && valid,
    queryFn: async () => (await people.byUsername(username)) ?? null,
  });
}

export function useRelation(id: string | undefined) {
  const { status, userId } = useSession();
  return useQuery({
    queryKey: ['friends', 'status', id], enabled: status === 'ready' && !!id,
    queryFn: () => (id === userId ? Promise.resolve('self' as const) : friendStatus(id!)),
  });
}

export function ProfileFrame({ username, tab, children }: { username: string; tab: ProfileTab; children: (ctx: ProfileCtx) => ReactNode }) {
  return <AppPage bare><ProfileInner username={username} tab={tab}>{children}</ProfileInner></AppPage>;
}

function NotFound() {
  return <div className="prof"><div className="pmain"><div className="note">The page you requested was not found. <Link href="/">Go to your News Feed</Link></div></div></div>;
}

function ProfileInner({ username, tab, children }: { username: string; tab: ProfileTab; children: (ctx: ProfileCtx) => ReactNode }) {
  useKeyringVersion();
  usePeopleVersion();
  const { userId } = useSession();
  const valid = isProfileUsername(username);
  const prof = useProfileRow(username);
  const row = prof.data ?? null;
  const person = usePerson(row?.id);
  const rel = useRelation(row?.id);
  const mine = useFriendIds();
  const [pic, setPic] = useState(false);

  useEffect(() => { void reconcileAudiences(); }, []);
  useEffect(() => {
    if (person) document.title = `${person.name} | Kithwall`;
  }, [person]);
  const theirFriends = row ? (row.id === userId ? mine.data ?? [] : person?.info?.friends ?? []) : [];
  useEffect(() => { if (theirFriends.length) void people.ensure(theirFriends.slice(0, 200)); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theirFriends.join(',')]);

  if (!valid) return <NotFound />;
  if (prof.isLoading || (row && rel.isLoading)) return <div className="prof"><div className="pmain gray">Loading…</div></div>;
  if (!row) return <NotFound />;

  const r: Relation = rel.data ?? 'none';
  const isMe = r === 'self';
  const canSee = isMe || r === 'friends';
  const ctx: ProfileCtx = { id: row.id, row, person, rel: r, isMe, canSee, friends: theirFriends };
  const name = person?.name ?? row.display_name_public ?? row.username;
  const mutual = !isMe && canSee ? mutualFriends(mine.data ?? [], row.id).filter((f) => f !== row.id) : [];
  const base = `/${row.username}`;
  const pn = (k: ProfileTab, label: string, icon: string, href: string) => (
    <li key={k}><Link className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} href={href}><Icon name={icon} />{label}</Link></li>
  );
  const grid = (ids: string[]) => (
    <div className="fgrid">
      {ids.slice(0, 6).map((f) => {
        const p = people.person(f);
        return <div key={f}><AvatarLink id={f} size={50} /><Link className="n" href={p ? `/${p.username}` : '#'}>{p?.name ?? '…'}</Link></div>;
      })}
    </div>
  );

  return (
    <div className="prof">
      <div className="pleft">
        <div className="ppic">
          {canSee ? <Avatar id={row.id} size={180} big /> : <Silhouette size={180} />}
          {isMe && <button type="button" className="chp kw-link" onClick={() => setPic(true)}>Change Picture</button>}
        </div>
        {canSee ? (
          <ul className="pnav">
            {pn('wall', 'Wall', 'wall', base)}
            {pn('info', 'Info', 'info', `${base}/info`)}
            {pn('photos', 'Photos', 'photo', `${base}/photos`)}
            {pn('notes', 'Notes', 'note', `${base}/notes`)}
            {pn('friends', 'Friends', 'friends', `${base}/friends`)}
          </ul>
        ) : <div style={{ height: 10 }} />}
        {canSee && (person?.info?.bio
          ? <div className="pabout">{person.info.bio}{isMe && <> <Link href="/settings/profile?tab=basic" className="small">Edit</Link></>}</div>
          : isMe ? <div className="pabout"><Link href="/settings/profile?tab=basic">Write something about yourself.</Link></div> : null)}
        {mutual.length > 0 && (
          <div className="lbox">
            <h4><span>Mutual Friends <span className="gray">({mutual.length})</span></span><Link href={`${base}/friends`}>See All</Link></h4>
            {grid(mutual)}
          </div>
        )}
        {canSee && (
          <div className="lbox">
            <h4><span>Friends <span className="gray">({theirFriends.length})</span></span><Link href={`${base}/friends`}>See All</Link></h4>
            {theirFriends.length ? grid(theirFriends) : <span className="gray">{person?.info?.hideFriends ? 'Friend list is hidden.' : isMe ? 'No friends yet.' : 'No friends to show.'}</span>}
          </div>
        )}
      </div>
      <div className="pmain">
        <div className="ptop">
          <h1>{name}</h1>
          <ProfileButtons ctx={ctx} />
        </div>
        {canSee ? (
          <>
            <div className="strip"><InfoStrip person={person} isMe={isMe} /></div>
            <PhotoStrip userId={row.id} />
            {children(ctx)}
          </>
        ) : (
          <NonFriend ctx={ctx} />
        )}
      </div>
      <div className="prc"><TipsBox n={1} /></div>
      {pic && <ChangeProfilePicture onClose={() => setPic(false)} />}
    </div>
  );
}

function NonFriend({ ctx }: { ctx: ProfileCtx }) {
  const first = (ctx.row.display_name_public ?? ctx.row.username).split(' ')[0];
  return (
    <>
      <div className="gray" style={{ marginBottom: 10 }}>@{ctx.row.username}{ctx.row.display_name_public ? <> &middot; listed in the Kithwall directory</> : null}</div>
      <div className="kw-nonfriend">
        <Icon name="lock" /> <b>Profiles on Kithwall are visible to friends only.</b><br />
        {ctx.rel === 'received' ? <>{first} sent you a friend request. Confirm it to see what {first} shares with friends.</>
          : ctx.rel === 'sent' ? <>You sent {first} a friend request. Once {first} confirms, you&rsquo;ll see {first}&rsquo;s Wall, photos and info.</>
            : <>To see what {first} shares with friends, send {first} a friend request. Everything {first} posts is encrypted, so only friends can read it.</>}
      </div>
    </>
  );
}
