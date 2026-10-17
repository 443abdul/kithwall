'use client';
// Profile tab bodies: Wall, Info, Friends, Notes.
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AvatarLink } from '@/components/Avatar';
import { Publisher } from '@/components/feed/Publisher';
import { Stream, pageOf } from '@/components/feed/Stream';
import { NoteList } from '@/components/social/NoteList';
import { ExternalLink, safeHref } from '@/components/social/bits';
import { AddFriendDialog } from './ProfileButtons';
import { RelationshipText } from './InfoStrip';
import { fetchWall } from '@/lib/content';
import { fetchByKind } from '@/lib/feed/feed';
import { people, usePeopleVersion } from '@/lib/people';
import { useFriendIds } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { birthdayText, splitList } from '@/lib/social/profile';
import type { ProfileCtx } from './ProfileFrame';

export function WallTab({ ctx }: { ctx: ProfileCtx }) {
  const first = ctx.person?.name.split(' ')[0] ?? ctx.row.username;
  return (
    <>
      <Publisher wallOwnerId={ctx.id} />
      <Stream queryKey={['wall', ctx.id]} wallContext={ctx.id}
        load={async (before) => pageOf(await fetchWall(ctx.id, before, 20), 20)}
        empty={ctx.isMe ? 'You haven’t posted anything yet.' : `${first} hasn’t posted anything yet.`} />
    </>
  );
}

type Row = [string, ReactNode];

function Section({ title, edit, rows, isMe }: { title: string; edit: string; rows: Row[]; isMe: boolean }) {
  const r = rows.filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
  if (!r.length && !isMe) return null;
  return (
    <div className="isec">
      <h3><span>{title}</span>{isMe && <Link href={`/settings/profile?tab=${edit}`}>Edit</Link>}</h3>
      {r.length ? (
        <table><tbody>{r.map(([l, v]) => <tr key={l}><td className="l">{l}:</td><td>{v}</td></tr>)}</tbody></table>
      ) : <span className="gray">Nothing to show.</span>}
    </div>
  );
}

const links = (s?: string) => {
  const items = splitList(s);
  if (!items.length) return null;
  return <>{items.map((t) => <span className="plink" key={t}><Link href={`/search?q=${encodeURIComponent(t)}`}>{t}</Link></span>)}</>;
};
const multiline = (s?: string) => (s ? <span style={{ whiteSpace: 'pre-wrap' }}>{s}</span> : null);

export function InfoTab({ ctx }: { ctx: ProfileCtx }) {
  usePeopleVersion();
  const i = ctx.person?.info;
  if (!i) return <div className="gray kw-pad">{ctx.isMe ? <Link href="/settings/profile">Fill in your profile.</Link> : 'Nothing to show yet.'}</div>;
  const edu = (k: 'college' | 'high_school' | 'grad') => {
    const list = (i.education ?? []).filter((e) => e.kind === k);
    if (!list.length) return null;
    return <>{list.map((e, n) => <div key={n}>{e.school}{e.year ? <span className="gray"> &rsquo;{String(e.year).slice(-2)}</span> : null}
      {e.concentration ? <div className="gray">{e.concentration}</div> : null}</div>)}</>;
  };
  const work = (i.work ?? []).length ? <>{(i.work ?? []).map((w, n) => <div key={n}>{w.employer}
    {w.position || w.city ? <div className="gray">{[w.position, w.city].filter(Boolean).join(' · ')}</div> : null}
    {w.from || w.to ? <div className="gray">{[w.from, w.to || 'present'].filter(Boolean).join(' – ')}</div> : null}</div>)}</> : null;
  const site = i.contact?.website ? (safeHref(i.contact.website) ? <ExternalLink href={i.contact.website}>{i.contact.website}</ExternalLink> : i.contact.website) : null;
  const featured = (i.featuredFriends ?? []).filter((f) => people.person(f));
  return (
    <>
      <Section title="Education and Work" edit="edu" isMe={ctx.isMe} rows={[
        ['Employers', work], ['Grad School', edu('grad')], ['College', edu('college')], ['High School', edu('high_school')],
      ]} />
      <Section title="Featured People" edit="featured" isMe={ctx.isMe} rows={[
        ['Relationship', ctx.person && i.relationship ? <RelationshipText person={ctx.person} /> : null],
        ['Anniversary', i.anniversary ?? null],
        ['Friends', featured.length ? <>{featured.map((f) => <span className="plink" key={f}><AvatarLink id={f} size={32} /><Link href={`/${people.person(f)!.username}`}>{people.person(f)!.name}</Link></span>)}</> : null],
      ]} />
      <Section title="Philosophy" edit="phil" isMe={ctx.isMe} rows={[
        ['Religious Views', i.religion ?? null], ['Political Views', i.political ?? null],
        ['People Who Inspire You', links(i.likes?.inspirational)], ['Favorite Quotations', multiline(i.quotes)],
      ]} />
      <Section title="Arts and Entertainment" edit="arts" isMe={ctx.isMe} rows={[
        ['Music', links(i.likes?.music)], ['Books', links(i.likes?.books)], ['Movies', links(i.likes?.movies)],
        ['Television', links(i.likes?.tv)], ['Games', links(i.likes?.games)],
      ]} />
      <Section title="Sports" edit="sports" isMe={ctx.isMe} rows={[
        ['Sports You Play', links(i.likes?.sports)], ['Favorite Teams', links(i.likes?.teams)], ['Favorite Athletes', links(i.likes?.athletes)],
      ]} />
      <Section title="Activities and Interests" edit="acts" isMe={ctx.isMe} rows={[
        ['Activities', links(i.likes?.activities)], ['Interests', links(i.likes?.interests)],
      ]} />
      <Section title="Basic Information" edit="basic" isMe={ctx.isMe} rows={[
        ['Sex', i.sex ?? null], ['Birthday', birthdayText(i)], ['Current City', i.currentCity ?? null], ['Hometown', i.hometown ?? null],
        ['Interested In', i.interestedIn ?? null], ['Looking For', i.lookingFor ?? null], ['Languages', i.languages ?? null],
        ['About Me', multiline(i.bio)],
      ]} />
      <Section title="Contact Information" edit="contact" isMe={ctx.isMe} rows={[
        ['Email', i.contact?.email ?? null], ['Mobile Phone', i.contact?.phone ?? null], ['Screen Name', i.contact?.im ?? null],
        ['Address', multiline(i.contact?.address)], ['Website', site],
      ]} />
    </>
  );
}

export function FriendsTab({ ctx }: { ctx: ProfileCtx }) {
  usePeopleVersion();
  const { userId } = useSession();
  const mine = useFriendIds();
  const qc = useQueryClient();
  const [add, setAdd] = useState<string | null>(null);
  const list = [...ctx.friends].filter((f) => people.person(f))
    .sort((a, b) => people.person(a)!.name.localeCompare(people.person(b)!.name));
  const myFriends = new Set(mine.data ?? []);
  return (
    <>
      <div className="sub"><span>Friends <span className="gray">({ctx.friends.length})</span></span></div>
      {ctx.person?.info?.hideFriends && !ctx.isMe ? <div className="gray">{ctx.person.name.split(' ')[0]} keeps their friend list private.</div> : null}
      <div className="ph">
        {list.map((f) => {
          const p = people.person(f)!;
          return (
            <div key={f}>
              <AvatarLink id={f} size={100} />
              <Link href={`/${p.username}`} style={{ display: 'block', marginTop: 3 }}><b>{p.name}</b></Link>
              {f !== userId && !myFriends.has(f) && <button type="button" className="kw-link small" onClick={() => setAdd(f)}>Add as Friend</button>}
            </div>
          );
        })}
      </div>
      {!list.length && <span className="gray">No friends to show.</span>}
      {add && <AddFriendDialog id={add} name={people.person(add)?.name ?? 'this person'} onClose={() => setAdd(null)}
        onDone={() => void qc.invalidateQueries({ queryKey: ['friends'] })} />}
    </>
  );
}

export function NotesTab({ ctx }: { ctx: ProfileCtx }) {
  const first = ctx.person?.name.split(' ')[0] ?? ctx.row.username;
  return (
    <>
      <div className="sub"><span>{ctx.isMe ? 'My' : `${first}’s`} Notes</span>{ctx.isMe && <Link href="/notes/new">Write a Note</Link>}</div>
      <NoteList queryKey={['kind', 'note', 'user', ctx.id]} load={(before) => fetchByKind('note', [ctx.id], before)} empty="No notes yet." />
    </>
  );
}
