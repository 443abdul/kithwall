'use client';
// Events: my upcoming and past events (and circle events), answer invitations at a glance.
import Link from 'next/link';
import { useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Segmented } from '@/components/ui/Segmented';
import { Icon } from '@/components/ui/Icon';
import type { CircleRow } from '@/components/circles/data';
import { E2eeLine, Loading, SectionHead } from '@/components/circles/shared';
import { MoreLinks } from '@/components/circles/CirclesScreen';
import { useCircleOptions } from '@/components/circles/data';
import { isHost, readEvent2, useCircleEvents, useMyEvents, type EventSummary } from './data';
import { splitByTime } from './time';
import { useEventTime } from './useEventTime';

export const RSVP_KEY: Record<'yes' | 'maybe' | 'no', MessageKey> = { yes: 'events.rsvp.yes', maybe: 'events.rsvp.maybe', no: 'events.rsvp.no' };

export function EventCard({ s, circleName }: { s: EventSummary; circleName?: string | null }) {
  const t = useT();
  const fmt = useEventTime();
  const d = readEvent2(s.event);
  const info = d.ok ? d.value : null;
  const badge = info ? fmt.badge(info.start) : null;
  const rsvp = s.me?.rsvp ?? null;
  return (
    <li>
      <Link href={`/events/${s.event.id}`} className="kc-card ke-card" data-cancelled={info?.cancelled || undefined}>
        <span className="ke-date" aria-hidden>
          {badge ? <><span className="ke-date-m">{badge.month}</span><span className="ke-date-d">{badge.day}</span></> : <Icon name="lock" />}
        </span>
        <span className="kc-card-body">
          <span dir="auto" className="kc-card-title">{info?.name ?? t('events.sealed')}</span>
          <span dir="auto" className="kc-card-sub">
            {info ? `${fmt.short(info.start)}${info.where ? ` · ${info.where}` : ''}` : d.ok ? '' : d.reason === 'waiting' ? t('circles.ui.waitingKey') : t('circles.ui.unverified')}
          </span>
          {circleName ? <span className="kc-card-sub ke-circle"><Icon name="circles" /> {circleName}</span> : null}
        </span>
        <span className="ke-card-trail">
          {info?.cancelled ? <Badge tone="neutral" className="k-badge-label">{t('events.cancelled')}</Badge>
            : isHost(s.event, s.me) ? <Badge tone="soft" className="k-badge-label">{t('events.hosting')}</Badge>
              : rsvp ? <Badge tone={rsvp === 'yes' ? 'success' : 'neutral'} className="k-badge-label">{t(RSVP_KEY[rsvp])}</Badge>
                : <Badge tone="accent" className="k-badge-label">{s.me ? t('events.needsAnswer') : t('events.inCircle')}</Badge>}
        </span>
      </Link>
    </li>
  );
}

function EventList({ items, circleNames }: { items: EventSummary[]; circleNames?: Map<string, string> }) {
  return (
    <ul className="k-stack-sm k-plain-list" role="list">
      {items.map((s) => <EventCard key={s.event.id} s={s} circleName={s.event.group_id ? circleNames?.get(s.event.group_id) : null} />)}
    </ul>
  );
}

export function EventsScreen() {
  const t = useT();
  useDocumentTitle(t('events.title'));
  const q = useMyEvents();
  const circles = useCircleOptions();
  const [view, setView] = useState<'upcoming' | 'past'>('upcoming');
  const names = new Map(circles.options.map((o) => [o.id, o.info?.name ?? t('circles.ui.sealedCircle')]));
  const split = splitByTime(q.data ?? [], (s) => { const d = readEvent2(s.event); return d.ok ? d.value : null; });
  const needs = split.upcoming.filter((s) => s.me && !s.me.rsvp && !isHost(s.event, s.me));
  const list = view === 'upcoming' ? split.upcoming.filter((s) => !needs.includes(s)) : split.past;
  return (
    <Page title={t('events.title')} description={t('events.description')}
      actions={<ButtonLink href="/events/new" variant="primary" icon="plus" size="sm">{t('events.create')}</ButtonLink>}
      context={<MoreLinks />}>
      {q.isLoading ? <Loading /> : (
        <>
          {needs.length ? (
            <section className="k-stack-sm" aria-labelledby="ke-needs">
              <SectionHead id="ke-needs" title={t('events.invitations', { count: needs.length })} />
              <EventList items={needs} circleNames={names} />
            </section>
          ) : null}
          <Segmented label={t('events.title')} value={view} onChange={setView} options={[
            { value: 'upcoming', label: t('events.upcoming') }, { value: 'past', label: t('events.past') },
          ]} />
          {list.length ? <EventList items={list} circleNames={names} /> : (
            <Card><EmptyState icon="calendar" title={view === 'upcoming' ? t('events.emptyUpcoming') : t('events.emptyPast')}
              body={view === 'upcoming' ? t('events.emptyBody') : undefined}
              actions={view === 'upcoming' ? <ButtonLink href="/events/new" variant="primary" icon="plus">{t('events.create')}</ButtonLink> : undefined} /></Card>
          )}
          {split.unknown.length ? (
            <section className="k-stack-sm" aria-labelledby="ke-sealed">
              <SectionHead id="ke-sealed" title={t('events.sealedSection')} />
              <EventList items={split.unknown} circleNames={names} />
            </section>
          ) : null}
          <E2eeLine>{t('events.e2ee')}</E2eeLine>
        </>
      )}
    </Page>
  );
}

/** The Events tab of a circle. */
export function CircleEvents({ circle }: { circle: CircleRow }) {
  const t = useT();
  const q = useCircleEvents(circle.id);
  const [showPast, setShowPast] = useState(false);
  const split = splitByTime(q.data ?? [], (s) => { const r = readEvent2(s.event); return r.ok ? r.value : null; });
  if (q.isLoading) return <Loading />;
  return (
    <div className="k-stack">
      <div className="k-row-wrap">
        <ButtonLink href={`/events/new?circle=${circle.id}`} variant="soft" icon="plus">{t('events.createInCircle')}</ButtonLink>
      </div>
      {split.upcoming.length || split.unknown.length ? <EventList items={[...split.upcoming, ...split.unknown]} />
        : <Card><EmptyState icon="calendar" title={t('events.emptyUpcoming')} body={t('events.circleEmptyBody')} /></Card>}
      {split.past.length ? (
        showPast ? (
          <section className="k-stack-sm" aria-labelledby="ke-cpast">
            <SectionHead id="ke-cpast" title={t('events.past')} />
            <EventList items={split.past} />
          </section>
        ) : <div><Button variant="ghost" onClick={() => setShowPast(true)}>{t('events.showPast', { count: split.past.length })}</Button></div>
      ) : null}
    </div>
  );
}
