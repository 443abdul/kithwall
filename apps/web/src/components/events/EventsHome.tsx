'use client';
// /events — invitations, upcoming (Today / Tomorrow / This Week / Later), past events, and
// friends' birthdays (from their decrypted profile info; nothing is computed on a server).
import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, RightBox, Title } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { AvatarLink, NameLink } from '@/components/Avatar';
import { DateBox, ErrorBox, useAction, useRetryKeys } from '@/components/groups/bits';
import { useFriendIds, useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { myMemberships, type MemberRow } from '@/lib/groups';
import {
  birthdayLabel, daysUntilBirthday, fmtEventTime, isPast, listEvents, readEvent, RSVP_LABEL, setRsvp,
  type EventInfo, type EventRow, type Rsvp,
} from '@/lib/events';

type Tab = 'up' | 'past' | 'bdays';

export function EventsHome() {
  useKeyringVersion();
  usePeopleVersion();
  const { status, userId } = useSession();
  const [tab, setTab] = useState<Tab>('up');
  const qc = useQueryClient();
  const act = useAction();
  const q = useQuery({
    queryKey: ['events', 'home'], enabled: status === 'ready',
    queryFn: async () => {
      const [events, memberships] = await Promise.all([listEvents(), myMemberships()]);
      const mine = new Map(memberships.map((m) => [m.audience_id, m]));
      return { events: events.filter((e) => mine.has(e.audience_id) || e.host_id === userId), mine };
    },
  });

  const decoded = (q.data?.events ?? []).map((e) => ({ e, d: readEvent(e), m: q.data!.mine.get(e.audience_id) }));
  const readable = decoded.filter((x): x is { e: EventRow; d: { ok: true; value: EventInfo }; m: MemberRow | undefined } => x.d.ok);
  const unreadable = decoded.filter((x) => !x.d.ok);
  useRetryKeys(unreadable.some((x) => !x.d.ok && x.d.reason === 'waiting'), ['events', 'home']);
  const [now] = useState(() => Date.now());
  const upcoming = readable.filter((x) => !isPast(x.d.value, now)).sort((a, b) => Date.parse(a.d.value.start) - Date.parse(b.d.value.start));
  const past = readable.filter((x) => isPast(x.d.value, now)).sort((a, b) => Date.parse(b.d.value.start) - Date.parse(a.d.value.start));
  const invites = upcoming.filter((x) => x.m && !x.m.rsvp && x.e.host_id !== userId && !x.d.value.cancelled);

  const rsvp = (e: EventRow, r: Rsvp) => act.run(async () => { await setRsvp(e.audience_id, r); void qc.invalidateQueries({ queryKey: ['events'] }); });

  const row = ({ e, d, m }: { e: EventRow; d: { value: EventInfo }; m?: MemberRow }, actions = true) => (
    <div className="it" key={e.id}>
      <DateBox iso={d.value.start} />
      <div className="d">
        <Link className="big" href={`/events/${e.id}`}>{d.value.name}</Link>{d.value.cancelled ? <b style={{ color: '#c33' }}> (Cancelled)</b> : null}<br />
        <span className="gray">{fmtEventTime(d.value)}{d.value.where ? <> &middot; {d.value.where}</> : null}</span><br />
        {m?.rsvp ? <>Your RSVP: <b>{RSVP_LABEL[m.rsvp]}</b></>
          : e.host_id === userId ? <span className="gray">You&rsquo;re the host</span>
          : m?.invited_by ? <><NameLink id={m.invited_by} bold={false} /> invited you.</>
          : <>Created by <NameLink id={e.host_id} bold={false} /></>}
        {' '}<Icon name={e.is_public ? 'globe' : 'lock'} title={e.is_public ? 'Public — not encrypted' : 'Encrypted to guests'} />
      </div>
      {actions && !m?.rsvp && e.host_id !== userId && !d.value.cancelled && !isPast(d.value) && (
        <div className="x"><Link className="btn" href={`/events/${e.id}`}>RSVP</Link></div>
      )}
    </div>
  );

  let body;
  if (tab === 'bdays') body = <Birthdays all />;
  else if (tab === 'past') body = <div className="list">{past.map((x) => row(x, false))}{!past.length && <div className="gray" style={{ padding: '6px 0' }}>No past events.</div>}</div>;
  else {
    const today = new Date(); today.setHours(23, 59, 59, 999);
    const end = today.getTime();
    const buckets: [string, (t: number) => boolean][] = [
      ['Today', (t) => t <= end], ['Tomorrow', (t) => t <= end + 86400_000], ['This Week', (t) => t <= end + 7 * 86400_000], ['Later', () => true],
    ];
    const used = new Set<string>();
    body = <>
      {invites.length > 0 && <>
        <div className="sub"><span>Event Invitations</span></div>
        <div className="list">
          {invites.map((x) => (
            <div className="it" key={`inv-${x.e.id}`}>
              <DateBox iso={x.d.value.start} />
              <div className="d"><Link className="big" href={`/events/${x.e.id}`}>{x.d.value.name}</Link><br />
                <span className="gray">{fmtEventTime(x.d.value)}{x.d.value.where ? <> &middot; {x.d.value.where}</> : null}</span><br />
                {x.m?.invited_by ? <><NameLink id={x.m.invited_by} bold={false} /> invited you.</> : null}</div>
              <div className="x" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button type="button" className="btn" disabled={act.busy} onClick={() => void rsvp(x.e, 'yes')}>Attending</button>
                <button type="button" className="btn" disabled={act.busy} onClick={() => void rsvp(x.e, 'maybe')}>Maybe</button>
                <button type="button" className="btn" disabled={act.busy} onClick={() => void rsvp(x.e, 'no')}>No</button>
              </div>
            </div>
          ))}
        </div>
      </>}
      {buckets.map(([label, fn]) => {
        const xs = upcoming.filter((x) => !used.has(x.e.id) && fn(Date.parse(x.d.value.start)));
        xs.forEach((x) => used.add(x.e.id));
        return xs.length ? <div key={label}><div className="sub"><span>{label}</span></div><div className="list">{xs.map((x) => row(x))}</div></div> : null;
      })}
      {q.data && !upcoming.length && <div className="gray" style={{ padding: '6px 0' }}>You don&rsquo;t have any upcoming events. <Link href="/events/new">Create one.</Link></div>}
    </>;
  }

  return (
    <AppPage active="events" right={<><Birthdays /><RightBox title="Private by Default"><div style={{ lineHeight: '15px' }}>
      <Icon name="lock" /> Private events (details and wall posts) are encrypted to the people you invite. Kithwall sees only
      who is invited and their RSVP.</div></RightBox></>}>
      <Title icon="event" right={<Link className="btn" href="/events/new">+ Create an Event</Link>}>Events</Title>
      <nav className="tabs2" aria-label="Event lists">
        {([['up', 'Upcoming Events'], ['past', 'Past Events'], ['bdays', 'Birthdays']] as [Tab, string][]).map(([k, l]) => (
          <a key={k} role="button" tabIndex={0} className={tab === k ? 'on' : ''} aria-pressed={tab === k}
            onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(k); } }}>{l}</a>
        ))}
      </nav>
      <ErrorBox error={act.error} />
      {q.isLoading && <div className="gray">Loading&hellip;</div>}
      {q.isError && <div className="err">Couldn&rsquo;t load your events.</div>}
      {body}
      {tab !== 'bdays' && unreadable.length > 0 && (
        <div className="gray" style={{ marginTop: 10 }}><Icon name="lock" /> {unreadable.length === 1 ? 'One event is' : `${unreadable.length} events are`} waiting
          for the host&rsquo;s device to share the key with you.</div>
      )}
    </AppPage>
  );
}

/** Friends' birthdays (this week in the right column; all upcoming in the Birthdays tab). */
function Birthdays({ all = false }: { all?: boolean }) {
  usePeopleVersion();
  useKeyringVersion();
  const friends = useFriendIds();
  const list = (friends.data ?? []).map((f) => {
    const info = people.person(f)?.info;
    const b = info?.showBirthday === 'none' ? undefined : info?.birthday;
    return { f, b, d: daysUntilBirthday(b) };
  }).filter((x): x is { f: string; b: string; d: number } => x.d !== null && !!x.b).sort((a, b) => a.d - b.d);
  const label = (d: number) => (d === 0 ? 'Today!' : d === 1 ? 'Tomorrow' : `in ${d} days`);
  if (!all) {
    const week = list.filter((x) => x.d < 7);
    if (!week.length) return null;
    return (
      <RightBox title="Birthdays This Week">
        {week.slice(0, 6).map((x) => <div className="rl" key={x.f}><Icon name="cake" /><NameLink id={x.f} bold={false} /> <span className="gray">{label(x.d).replace('!', '').toLowerCase()}</span></div>)}
      </RightBox>
    );
  }
  return (
    <div className="list">
      {list.map((x) => (
        <div className="it" key={x.f}>
          <AvatarLink id={x.f} size={32} />
          <div className="d"><NameLink id={x.f} /><br /><span className="gray">{birthdayLabel(x.b)} &middot; {label(x.d)}</span></div>
          {x.d < 2 && <div className="x"><Link className="btn" href={`/${people.person(x.f)?.username ?? ''}`}>Write on Wall</Link></div>}
        </div>
      ))}
      {friends.data && !list.length && <div className="gray" style={{ padding: '6px 0' }}>None of your friends share a birthday with you yet.</div>}
    </div>
  );
}
