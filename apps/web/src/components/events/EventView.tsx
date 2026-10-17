'use client';
// /events/[id] — reference vEvent: details, RSVP, guest lists, invite, wall, edit/cancel, .ics export.
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, RightBox } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { AvatarLink, NameLink } from '@/components/Avatar';
import { ConfirmDialog, Dialog } from '@/components/social/Dialog';
import { FriendPicker, Linkify, Unverified } from '@/components/social/bits';
import { ErrorBox, PublicWarning, useAction } from '@/components/groups/bits';
import { Wall } from '@/components/groups/Wall';
import { useFriendIds, useKeyringVersion } from '@/lib/hooks';
import { keyring } from '@/lib/keys/keyring';
import { me, useSession } from '@/lib/keys/session';
import { usePeopleVersion } from '@/lib/people';
import { plural } from '@/lib/format';
import { containerPosts } from '@/lib/groups';
import {
  deleteEvent, deliverMemberKeys, downloadIcs, fmtEventTime, getEvent, inviteToEvent, isPast, membersOf, postToEvent,
  readEvent, removeGuest, rotateIfNeeded, RSVP_LABEL, setRsvp, updateEvent, type EventInfo, type EventRow, type GuestRow, type Rsvp,
} from '@/lib/events';
import { EventForm } from './EventForm';

function useEventData(id: string) {
  const { status } = useSession();
  return useQuery({
    queryKey: ['event', id], enabled: status === 'ready',
    queryFn: async () => {
      const e = await getEvent(id);
      if (!e) return { e: null, guests: [] as GuestRow[], mine: null };
      const guests = await membersOf(e.audience_id);
      return { e, guests, mine: guests.find((g) => g.member_id === me()) ?? null };
    },
  });
}

function EventArt({ iso }: { iso: string }) {
  const d = new Date(iso);
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()];
  return (
    <svg width="100" height="100" viewBox="0 0 100 100" aria-hidden>
      <rect x="0.5" y="0.5" width="99" height="99" fill="#fff" stroke="#bbb" />
      <rect x="0.5" y="0.5" width="99" height="26" fill="#c33" />
      <text x="50" y="19" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#fff" fontFamily="tahoma">{mon}</text>
      <text x="50" y="76" textAnchor="middle" fontSize="44" fill="#333" fontFamily="tahoma">{d.getDate()}</text>
    </svg>
  );
}

export function EventView({ id }: { id: string }) {
  useKeyringVersion();
  usePeopleVersion();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useEventData(id);
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [managing, setManaging] = useState(false);
  const [ask, setAsk] = useState<'cancel' | 'delete' | null>(null);
  const e = q.data?.e ?? null;
  const guests = useMemo(() => q.data?.guests ?? [], [q.data]);
  const mine = q.data?.mine ?? null;
  const isHost = !!e && e.host_id === mine?.member_id;
  const isAdmin = isHost || (mine?.role === 'admin' && mine.status === 'active');
  const signers = useMemo(() => (e && guests.length ? new Set([e.host_id, ...guests.filter((g) => g.role === 'admin').map((g) => g.member_id)]) : undefined), [e, guests]);
  const d = e ? readEvent(e, signers) : null;
  const info = d?.ok ? d.value : null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['event', id] });

  const maint = useRef<string | null>(null);
  useEffect(() => {
    if (!e || !mine || maint.current === `${e.id}:${e.envelope_epoch}:${isAdmin}`) return;
    maint.current = `${e.id}:${e.envelope_epoch}:${isAdmin}`;
    void (async () => {
      if (d && !d.ok && d.reason === 'waiting') { await keyring.load().catch(() => undefined); await qc.invalidateQueries({ queryKey: ['event', id] }); }
      if (!isAdmin || e.is_public) return;
      const rotated = await rotateIfNeeded(e.audience_id).catch(() => false);
      if (rotated && info) {
        const fresh = await getEvent(e.id);
        if (fresh) await updateEvent(fresh, info).catch(() => undefined);
        await qc.invalidateQueries({ queryKey: ['event', id] });
      }
      await deliverMemberKeys(e.audience_id).catch(() => 0);
    })();
  }, [e, mine, isAdmin, d, info, qc, id]);

  if (q.isLoading) return <AppPage active="events" right={null}><div className="gray">Loading&hellip;</div></AppPage>;
  if (q.isError) return <AppPage active="events" right={null}><div className="err">Couldn&rsquo;t load this event.</div></AppPage>;
  if (!e) return <AppPage active="events" right={null}><div className="note">This event has been cancelled or does not exist.</div></AppPage>;
  if (!d?.ok) {
    return (
      <AppPage active="events" right={null}>
        {d?.reason === 'waiting'
          ? <div className="note"><Icon name="lock" /> Waiting for <NameLink id={e.host_id} />&rsquo;s device to share this event with you.</div>
          : <Unverified />}
      </AppPage>
    );
  }

  const ev = d.value;
  const past = isPast(ev);
  const by = (k: Rsvp | null) => guests.filter((g) => g.status === 'active' && (g.rsvp ?? null) === k);
  const rb = (k: Rsvp, label: string) => (
    <button type="button" className={`btn${mine?.rsvp === k ? ' b' : ''}`} aria-pressed={mine?.rsvp === k} disabled={act.busy || !mine}
      onClick={() => void act.run(async () => { await setRsvp(e.audience_id, k); await refresh(); await qc.invalidateQueries({ queryKey: ['events'] }); })}>{label}</button>
  );
  const gl = (title: string, arr: GuestRow[]) => arr.length ? (
    <RightBox title={`${title} (${arr.length})`} key={title}>
      {arr.slice(0, 12).map((g) => <div className="rl" key={g.member_id}><AvatarLink id={g.member_id} size={24} /><NameLink id={g.member_id} bold={false} /></div>)}
      {arr.length > 12 && <div className="gray">and {plural(arr.length - 12, 'other')}</div>}
    </RightBox>
  ) : null;

  const right = <>
    {gl('Attending', by('yes'))}{gl('Maybe Attending', by('maybe'))}{gl('Awaiting Reply', by(null))}{gl('Not Attending', by('no'))}
    {isAdmin && <div className="rs"><a role="button" tabIndex={0} onClick={() => setManaging(true)} onKeyDown={(k) => { if (k.key === 'Enter') setManaging(true); }}>Manage guest list</a></div>}
  </>;

  return (
    <AppPage active="events" right={right}>
      {editing ? (
        <>
          <div className="sub"><span>Edit Event</span></div>
          <EventForm initial={ev} submitLabel="Save Changes" isPublic={e.is_public} onCancel={() => setEditing(false)}
            onSubmit={async (next) => { await updateEvent(e, next); setEditing(false); await refresh(); await qc.invalidateQueries({ queryKey: ['events'] }); }} />
        </>
      ) : (
        <div className="cm-evhead">
          <div className="cm-evart"><EventArt iso={ev.start} /></div>
          <div className="cm-evbody">
            <h2>{ev.name}</h2>
            {ev.tagline && <div className="cm-tag">{ev.tagline}</div>}
            {ev.cancelled && <div className="cm-cancel" role="status">This event has been cancelled.</div>}
            <div className="isec" style={{ marginBottom: 0 }}><table><tbody>
              <tr><td className="l" style={{ width: 90 }}>Time</td><td>{fmtEventTime(ev)}{past ? <span className="gray"> (past)</span> : null}</td></tr>
              <tr><td className="l">Location</td><td>{ev.where || <span className="gray">Not set</span>}{ev.street ? <><br /><span className="gray">{ev.street}</span></> : null}</td></tr>
              <tr><td className="l">Created By</td><td><NameLink id={e.host_id} /></td></tr>
              <tr><td className="l">Privacy</td><td>{e.is_public
                ? <span className="cm-enc"><Icon name="globe" /> Public — not encrypted</span>
                : <span className="cm-enc"><Icon name="lock" /> Private — encrypted to {plural(guests.filter((g) => g.status === 'active').length, 'guest')}</span>}</td></tr>
              <tr><td className="l">More Info</td><td style={{ whiteSpace: 'pre-wrap' }}>{ev.description ? <Linkify text={ev.description} /> : <span className="gray">No description.</span>}</td></tr>
            </tbody></table></div>
          </div>
        </div>
      )}
      <ErrorBox error={act.error} />
      <div className="cm-rsvp">
        {mine && !ev.cancelled ? <><b>Your RSVP:</b> {rb('yes', 'I\'m Attending')}{rb('maybe', 'Maybe')}{rb('no', 'No')}</> : null}
        <span className="sp" />
        {isAdmin && !ev.cancelled && <button type="button" className="btn" onClick={() => setInviting(true)}><Icon name="friends" /> Invite Friends</button>}
        <button type="button" className="btn" title="Creates a calendar file on this device" onClick={() => downloadIcs(e.id, ev)}><Icon name="event" /> Export</button>
        {isAdmin && !editing && <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>}
        {isHost && !ev.cancelled && <button type="button" className="btn" onClick={() => setAsk('cancel')}>Cancel Event</button>}
        {isHost && <button type="button" className="btn" onClick={() => setAsk('delete')}>Delete</button>}
      </div>
      {e.is_public && <PublicWarning what="This event's details and wall" />}
      <div className="sub"><span>Wall</span></div>
      <Wall queryKey={['wall', 'event', e.id]} load={(before) => containerPosts('event_id', e.id, before)}
        publish={mine?.status === 'active' ? (text) => postToEvent(e, { text }) : undefined}
        isPublic={e.is_public} audienceLabel={`Guests of ${ev.name}`}
        wallContext={e.id} canModerate={isAdmin}
        placeholder="Write something..." empty="No posts yet." />

      {inviting && <InviteDialog e={e} info={ev} guests={guests} onClose={() => setInviting(false)} onDone={() => void refresh()} />}
      {managing && <ManageGuests e={e} info={ev} guests={guests} onClose={() => setManaging(false)} onDone={() => void refresh()} />}
      {ask === 'cancel' && <ConfirmDialog title="Cancel Event" confirmLabel="Cancel Event" onClose={() => setAsk(null)}
        onConfirm={async () => { await updateEvent(e, { ...ev, cancelled: true }); await refresh(); await qc.invalidateQueries({ queryKey: ['events'] }); }}>
        Guests will see that <b>{ev.name}</b> has been cancelled.
      </ConfirmDialog>}
      {ask === 'delete' && <ConfirmDialog title="Delete Event" confirmLabel="Delete Event" onClose={() => setAsk(null)}
        onConfirm={async () => { await deleteEvent(e); await qc.invalidateQueries({ queryKey: ['events'] }); router.push('/events'); }}>
        This permanently deletes the event, its guest list and wall for everyone.
      </ConfirmDialog>}
    </AppPage>
  );
}

function InviteDialog({ e, info, guests, onClose, onDone }: { e: EventRow; info: EventInfo; guests: GuestRow[]; onClose: () => void; onDone: () => void }) {
  const friends = useFriendIds();
  const [pick, setPick] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  const invited = new Set(guests.map((g) => g.member_id));
  const candidates = (friends.data ?? []).filter((f) => !invited.has(f));
  return (
    <Dialog title="Invite Friends" onClose={onClose} buttons={<>
      <button type="button" className="btn b" disabled={busy || !pick.length}
        onClick={() => void run(async () => { await inviteToEvent(e, pick, info.name); onDone(); onClose(); })}>{busy ? 'Inviting…' : 'Send Invitations'}</button>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
    </>}>
      <ErrorBox error={error} />
      {candidates.length ? <FriendPicker friends={candidates} value={pick} onChange={setPick} max={500} label="Search friends" />
        : <div className="gray">All your friends are already invited.</div>}
    </Dialog>
  );
}

function ManageGuests({ e, info, guests, onClose, onDone }: { e: EventRow; info: EventInfo; guests: GuestRow[]; onClose: () => void; onDone: () => void }) {
  usePeopleVersion();
  const { busy, error, run } = useAction();
  const list = guests.filter((g) => g.member_id !== e.host_id);
  return (
    <Dialog title="Guest List" onClose={onClose} buttons={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <ErrorBox error={error} />
      <p className="gray" style={{ marginBottom: 6 }}>Removing a guest gives the event a new key, so they can&rsquo;t read anything posted afterwards.</p>
      <div className="list">
        {list.map((g) => (
          <div className="it" key={g.member_id}>
            <AvatarLink id={g.member_id} size={32} />
            <div className="d"><NameLink id={g.member_id} /><br /><span className="gray">{g.rsvp ? RSVP_LABEL[g.rsvp] : 'Awaiting reply'}</span></div>
            <div className="x"><button type="button" className="btn" disabled={busy}
              onClick={() => void run(async () => { await removeGuest(e, g.member_id, info); onDone(); })}>Remove</button></div>
          </div>
        ))}
        {!list.length && <div className="gray">No guests yet.</div>}
      </div>
    </Dialog>
  );
}
