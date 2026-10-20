'use client';
// Circles tab: my circles and invitations. Circles are invite-only; there is no directory.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { List, ListItem } from '@/components/ui/ListItem';
import { useToast } from '@/components/ui/Toast';
import { acceptInvite, isAdmin, leaveCircle, readCircle, useMyCircles, type CircleSummary } from './data';
import { CircleMark, E2eeLine, Loading, SectionHead, usePersonName } from './shared';

export function MoreLinks() {
  const t = useT();
  return (
    <Card padding="flush">
      <List label={t('circles.more.title')}>
        <li><ListItem icon="calendar" title={t('events.title')} subtitle={t('circles.more.events')} href="/circles/events" /></li>
        <li><ListItem icon="image" title={t('albums.title')} subtitle={t('circles.more.albums')} href="/albums" /></li>
        <li><ListItem icon="edit" title={t('notes.title')} subtitle={t('circles.more.notes')} href="/circles/notes" /></li>
      </List>
    </Card>
  );
}

function CircleCard({ s }: { s: CircleSummary }) {
  const t = useT();
  const d = readCircle(s.circle);
  const info = d.ok ? d.value : null;
  const admin = isAdmin(s.circle, s.membership);
  return (
    <li>
      <Link href={`/circles/${s.circle.id}`} className="kc-card">
        <CircleMark id={s.circle.id} info={info} />
        <span className="kc-card-body">
          <span dir="auto" className="kc-card-title">{info?.name ?? t('circles.ui.sealedCircle')}</span>
          <span dir="auto" className="kc-card-sub">{info?.description ?? (d.ok ? t('circles.list.private') : t('circles.ui.waitingKey'))}</span>
        </span>
        {admin ? <Badge tone="soft" className="k-badge-label">{t('circles.role.admin')}</Badge> : null}
      </Link>
    </li>
  );
}

function Invitation({ s }: { s: CircleSummary }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const router = useRouter();
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  const inviter = usePersonName(s.membership?.invited_by);
  const d = readCircle(s.circle);
  const info = d.ok ? d.value : null;
  const act = async (yes: boolean) => {
    setBusy(yes ? 'yes' : 'no');
    try {
      if (yes) await acceptInvite(s.circle.audience_id); else await leaveCircle(s.circle);
      void qc.invalidateQueries({ queryKey: ['circles'] });
      if (yes) router.push(`/circles/${s.circle.id}`);
      else toast({ message: t('circles.invite.declined') });
    } catch {
      toast({ message: t('circles.ui.error'), tone: 'danger' });
    } finally { setBusy(null); }
  };
  return (
    <Card as="li" className="kc-invite">
      <div className="k-row">
        <CircleMark id={s.circle.id} info={info} />
        <div className="kc-card-body">
          <p dir="auto" className="kc-card-title">{info?.name ?? t('circles.ui.sealedCircle')}</p>
          <p className="k-small k-muted">
            {s.membership?.invited_by ? t('circles.invite.from', { name: inviter }) : t('circles.invite.generic')}
          </p>
        </div>
      </div>
      <div className="k-row-wrap kc-actions">
        <Button variant="primary" size="sm" busy={busy === 'yes'} disabled={!!busy} onClick={() => void act(true)}>{t('circles.invite.accept')}</Button>
        <Button variant="secondary" size="sm" busy={busy === 'no'} disabled={!!busy} onClick={() => void act(false)}>{t('circles.invite.decline')}</Button>
      </div>
    </Card>
  );
}

export function CirclesScreen() {
  const t = useT();
  useDocumentTitle(t('nav.circles'));
  const q = useMyCircles();
  const active = q.data?.active ?? [];
  const invited = q.data?.invited ?? [];
  return (
    <Page
      title={t('nav.circles')}
      description={t('circles.description')}
      actions={<ButtonLink href="/circles/new" variant="primary" icon="plus" size="sm">{t('circles.create')}</ButtonLink>}
      context={<MoreLinks />}
    >
      {q.isLoading ? <Loading /> : q.isError ? (
        <Card><EmptyState icon="alert" title={t('circles.ui.error')} actions={<Button onClick={() => void q.refetch()} icon="refresh">{t('circles.ui.retry')}</Button>} /></Card>
      ) : (
        <>
          {invited.length ? (
            <section className="k-stack-sm" aria-labelledby="kc-inv-h">
              <SectionHead id="kc-inv-h" title={t('circles.list.invitations', { count: invited.length })} />
              <ul className="k-stack-sm k-plain-list" role="list">{invited.map((s) => <Invitation key={s.circle.id} s={s} />)}</ul>
            </section>
          ) : null}
          {active.length ? (
            <section className="k-stack-sm" aria-labelledby="kc-mine-h">
              <SectionHead id="kc-mine-h" title={t('circles.list.mine')} />
              <ul className="kc-grid" role="list">{active.map((s) => <CircleCard key={s.circle.id} s={s} />)}</ul>
            </section>
          ) : (
            <Card>
              <EmptyState icon="circles" title={t('circles.emptyTitle')} body={t('circles.emptyBody')}
                actions={<ButtonLink href="/circles/new" variant="primary" icon="plus">{t('circles.create')}</ButtonLink>} />
            </Card>
          )}
          <E2eeLine>{t('circles.list.e2ee')}</E2eeLine>
          <div className="kc-phone-only"><MoreLinks /></div>
        </>
      )}
    </Page>
  );
}
