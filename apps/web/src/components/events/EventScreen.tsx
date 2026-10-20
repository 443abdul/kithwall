'use client';
// An event: details, RSVP (going / maybe / can't go), add to calendar (.ics made on this device),
// guest list (visible to guests), host tools, and the discussion (shared post components).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { me } from '@/lib/keys/session';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { List, ListItem } from '@/components/ui/ListItem';
import { Segmented } from '@/components/ui/Segmented';
import { useToast } from '@/components/ui/Toast';
import { Composer, Feed } from '@/components/posts';
import { readCircle, useCircle, useCircleMembers } from '@/components/circles/data';
import { ConnectionPicker, E2eeLine, Loading, NotFound, PersonAvatar, SealedNote, SectionHead } from '@/components/circles/shared';
import { usePerson } from '@/lib/people';
import {
  answer, cancelEvent, deleteEvent, downloadIcs, eventHousekeeping, inviteGuests, isHost, leaveEvent, readEvent2,
  removeGuest, useEvent2, useGuests, type EventSummary, type GuestRow, type Rsvp,
} from './data';
import { useEventTime } from './useEventTime';
import { RSVP_KEY } from './EventsScreen';

function CircleLink({ id }: { id: string }) {
  const t = useT();
  const q = useCircle(id);
  const d = q.data ? readCircle(q.data.circle) : null;
  return <Link href={`/circles/${id}?tab=events`} className="ke-circle-link"><Icon name="circles" /> {d?.ok ? d.value.name : t('circles.ui.sealedCircle')}</Link>;
}

function GuestItem({ g, host, canRemove, onRemove }: { g: GuestRow; host: boolean; canRemove: boolean; onRemove: () => void }) {
  const t = useT();
  const p = usePerson(g.member_id);
  return (
    <li>
      <ListItem leading={<PersonAvatar id={g.member_id} size={36} />}
        title={p?.name ?? '…'}
        subtitle={host ? t('events.host') : g.rsvp ? t(RSVP_KEY[g.rsvp]) : t('events.noAnswer')}
        trailing={canRemove ? <Button size="sm" variant="ghost" onClick={onRemove}>{t('circles.members.remove')}</Button> : undefined} />
    </li>
  );
}

function Guests({ s, host }: { s: EventSummary; host: boolean }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useGuests(s.event, !!s.me);
  const [removing, setRemoving] = useState<GuestRow | null>(null);
  const [busy, setBusy] = useState(false);
  const removingName = usePerson(removing?.member_id)?.name ?? '';
  if (!s.me) return <p className="k-small k-muted">{t('events.guestsHidden')}</p>;
  if (q.isLoading) return <Loading />;
  const rows = q.data ?? [];
  const groups: { key: string; title: string; rows: GuestRow[] }[] = [
    { key: 'yes', title: t('events.going', { count: rows.filter((r) => r.rsvp === 'yes').length }), rows: rows.filter((r) => r.rsvp === 'yes') },
    { key: 'maybe', title: t('events.maybeCount', { count: rows.filter((r) => r.rsvp === 'maybe').length }), rows: rows.filter((r) => r.rsvp === 'maybe') },
    { key: 'none', title: t('events.invitedCount', { count: rows.filter((r) => !r.rsvp).length }), rows: rows.filter((r) => !r.rsvp) },
    { key: 'no', title: t('events.cantGoCount', { count: rows.filter((r) => r.rsvp === 'no').length }), rows: rows.filter((r) => r.rsvp === 'no') },
  ].filter((g) => g.rows.length);
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      const d = readEvent2(s.event);
      await removeGuest(s.event, removing.member_id, d.ok ? d.value : null);
      void qc.invalidateQueries({ queryKey: ['events'] });
      setRemoving(null);
    } catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); }
    setBusy(false);
  };
  return (
    <div className="k-stack">
      {groups.map((g) => (
        <section key={g.key} className="k-stack-sm" aria-label={g.title}>
          <SectionHead title={g.title} />
          <Card padding="flush"><List>
            {g.rows.map((r) => <GuestItem key={r.member_id} g={r} host={r.member_id === s.event.host_id}
              canRemove={host && r.member_id !== s.event.host_id && r.member_id !== me()} onRemove={() => setRemoving(r)} />)}
          </List></Card>
        </section>
      ))}
      <Dialog open={!!removing} onClose={() => { if (!busy) setRemoving(null); }} title={t('events.removeGuestTitle', { name: removingName })}
        footer={<>
          <Button variant="secondary" disabled={busy} onClick={() => setRemoving(null)}>{t('circles.ui.cancel')}</Button>
          <Button variant="danger" busy={busy} onClick={() => void remove()}>{t('circles.members.remove')}</Button>
        </>}>
        <p>{t('events.removeGuestBody')}</p>
      </Dialog>
    </div>
  );
}

function InviteGuests({ s, open, onClose }: { s: EventSummary; open: boolean; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const guests = useGuests(s.event, open);
  const circle = useCircle(s.event.group_id ?? '');
  const members = useCircleMembers(s.event.group_id && open ? circle.data?.circle : null);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const d = readEvent2(s.event);
  const exclude = (guests.data ?? []).map((g) => g.member_id);
  const candidates = s.event.group_id ? (members.data ?? []).filter((m) => m.status === 'active').map((m) => m.member_id) : undefined;
  const send = async () => {
    setBusy(true);
    try {
      const n = await inviteGuests(s.event, ids, d.ok ? d.value.name : '');
      void qc.invalidateQueries({ queryKey: ['events'] });
      toast({ message: t('circles.members.invitedToast', { count: n }) });
      setIds([]); onClose();
    } catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); }
    setBusy(false);
  };
  return (
    <Dialog open={open} onClose={onClose} title={t('events.inviteTitle')} sheet dismissible={!busy}
      footer={<>
        <Button variant="secondary" disabled={busy} onClick={onClose}>{t('circles.ui.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!ids.length} onClick={() => void send()}>{t('circles.members.sendInvites', { count: ids.length })}</Button>
      </>}>
      <ConnectionPicker value={ids} onChange={setIds} exclude={exclude} candidates={candidates} />
    </Dialog>
  );
}

export function EventScreen({ id }: { id: string }) {
  const t = useT();
  const q = useEvent2(id);
  const fmt = useEventTime();
  const toast = useToast();
  const qc = useQueryClient();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'cancel' | 'leave' | null>(null);
  const s = q.data ?? null;
  const d = s ? readEvent2(s.event) : null;
  const info = d?.ok ? d.value : null;
  const hostName = usePerson(s?.event.host_id)?.name ?? '';
  useDocumentTitle(info?.name ?? t('events.title'));
  const host = s ? isHost(s.event, s.me) : false;
  const ev = s?.event;
  useEffect(() => { if (ev && host) void eventHousekeeping(ev); }, [ev, host]);

  const back = { href: s?.event.group_id ? `/circles/${s.event.group_id}?tab=events` : '/events', label: t('common.back') };
  if (q.isLoading) return <Page title={t('events.title')} back={back}><Loading /></Page>;
  if (!s) return <Page title={t('events.title')} back={back}><NotFound icon="calendar" title={t('events.notFound')} body={t('events.notFoundBody')} actions={<ButtonLink href="/events" variant="soft">{t('events.title')}</ButtonLink>} /></Page>;

  const rsvp = s.me?.rsvp ?? null;
  const setAnswer = async (r: Rsvp) => {
    setBusy(r);
    try { await answer(s, r); void qc.invalidateQueries({ queryKey: ['events'] }); }
    catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); }
    setBusy(null);
  };
  const doConfirm = async () => {
    if (!confirm) return;
    setBusy(confirm);
    try {
      if (confirm === 'delete') { await deleteEvent(s.event); void qc.invalidateQueries({ queryKey: ['events'] }); router.replace(back.href); return; }
      if (confirm === 'leave') { await leaveEvent(s.event); void qc.invalidateQueries({ queryKey: ['events'] }); router.replace(back.href); return; }
      if (info) await cancelEvent(s.event, info, !info.cancelled);
      void qc.invalidateQueries({ queryKey: ['events'] });
      setConfirm(null);
    } catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); }
    setBusy(null);
  };
  const hostZone = info ? fmt.hostZone(info) : null;

  return (
    <Page title={info?.name ?? t('events.sealed')} back={back}
      actions={host && info ? <ButtonLink href={`/events/${id}/edit`} variant="secondary" size="sm" icon="edit">{t('events.edit')}</ButtonLink> : undefined}>
      <Card className="ke-hero">
        {info ? (
          <div className="k-stack">
            {info.cancelled ? <Callout tone="warning" icon="alert">{t('events.cancelledBody')}</Callout> : null}
            <div className="ke-facts">
              <p className="ke-fact"><Icon name="calendar" /><span><strong>{fmt.date(info.start)}</strong><br />{fmt.range(info)}{hostZone ? <span className="k-muted"> · {t('events.hostTime', { time: hostZone })}</span> : null}</span></p>
              {info.where ? <p className="ke-fact"><Icon name="mapPin" /><span>{info.where}</span></p> : null}
              <p className="ke-fact"><PersonAvatar id={s.event.host_id} size={24} /><span>{t('events.hostedBy', { name: hostName })}</span></p>
              {s.event.group_id ? <p className="ke-fact"><CircleLink id={s.event.group_id} /></p> : null}
            </div>
            {info.description ? <p dir="auto" className="ke-desc">{info.description}</p> : null}
            <div className="k-row-wrap">
              <Button variant="secondary" size="sm" icon="calendar" onClick={() => downloadIcs(s.event.id, info)}>{t('events.addToCalendar')}</Button>
              {host ? <Button variant="secondary" size="sm" icon="users" onClick={() => setInviteOpen(true)}>{t('events.invite')}</Button> : null}
            </div>
          </div>
        ) : d && !d.ok ? <SealedNote reason={d.reason} /> : null}
      </Card>

      {info && !info.cancelled && !host ? (
        <section className="k-stack-sm" aria-labelledby="ke-rsvp-h">
          <SectionHead id="ke-rsvp-h" title={s.me ? t('events.yourAnswer') : t('events.joinPrompt')} />
          <Segmented label={t('events.yourAnswer')} block value={(rsvp ?? '') as Rsvp} onChange={(v) => void setAnswer(v)} options={[
            { value: 'yes', label: t('events.rsvp.yes'), icon: 'check' },
            { value: 'maybe', label: t('events.rsvp.maybe') },
            { value: 'no', label: t('events.rsvp.no'), icon: 'close' },
          ]} />
          {busy && ['yes', 'maybe', 'no'].includes(busy) ? <p className="k-small k-muted" role="status">{t('common.loading')}</p> : null}
        </section>
      ) : null}

      {!s.me && d && !d.ok ? <Callout icon="lock">{t('events.joinToRead')}</Callout> : null}

      <section className="k-stack-sm" aria-labelledby="ke-guests-h">
        <SectionHead id="ke-guests-h" title={t('events.guests')} />
        <Guests s={s} host={host} />
      </section>

      {s.me ? (
        <section className="k-stack-sm" aria-labelledby="ke-talk-h">
          <SectionHead id="ke-talk-h" title={t('events.discussion')} />
          <Composer audience={{ kind: 'event', eventId: id }} fixedAudience placeholder={t('events.discussionPh')} />
          <Feed scope={{ kind: 'event', eventId: id }} empty={<Card><EmptyState icon="messages" title={t('events.discussionEmpty')} /></Card>} />
        </section>
      ) : null}

      <div className="k-row-wrap">
        {host ? (
          <>
            {info ? <Button variant="secondary" onClick={() => setConfirm('cancel')}>{info.cancelled ? t('events.restore') : t('events.cancel')}</Button> : null}
            {s.event.host_id === me() ? <Button variant="danger" onClick={() => setConfirm('delete')}>{t('events.delete')}</Button> : null}
          </>
        ) : s.me ? <Button variant="ghost" icon="logout" onClick={() => setConfirm('leave')}>{t('events.leave')}</Button> : null}
      </div>
      <E2eeLine>{t('events.e2ee')}</E2eeLine>
      {host ? <InviteGuests s={s} open={inviteOpen} onClose={() => setInviteOpen(false)} /> : null}
      <Dialog open={!!confirm} onClose={() => { if (!busy) setConfirm(null); }}
        title={confirm === 'delete' ? t('events.deleteTitle') : confirm === 'leave' ? t('events.leaveTitle') : info?.cancelled ? t('events.restore') : t('events.cancelTitle')}
        footer={<>
          <Button variant="secondary" disabled={!!busy} onClick={() => setConfirm(null)}>{t('circles.ui.cancel')}</Button>
          <Button variant={confirm === 'delete' ? 'danger' : 'primary'} busy={busy === confirm} onClick={() => void doConfirm()}>{t('circles.ui.confirm')}</Button>
        </>}>
        <p>{confirm === 'delete' ? t('events.deleteBody') : confirm === 'leave' ? t('events.leaveBody') : info?.cancelled ? t('events.restoreBody') : t('events.cancelBody')}</p>
      </Dialog>
    </Page>
  );
}
