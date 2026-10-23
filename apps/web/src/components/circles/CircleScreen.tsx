'use client';
// A circle's home: header, then tabs — Posts, Chat, Photos, Events, Notes, Members.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { Composer, Feed } from '@/components/posts';
import { CircleAlbums } from '@/components/albums/AlbumsScreen';
import { CircleEvents } from '@/components/events/EventsScreen';
import { CircleNotes } from '@/components/notes/NotesScreen';
import { acceptInvite, circleHousekeeping, isAdmin, leaveCircle, readCircle, useCircle, useCircleMembers, type CircleSummary } from './data';
import { AvatarStack, CircleMark, Loading, NotFound, SealedNote, usePersonName } from './shared';
import { CircleMembers, InviteDialog } from './CircleMembers';
import { AudienceKeyNotices, RosterNotices } from '@/components/verify/AudienceKeyNotices';
import { keyAuthorities } from '@/lib/keys/roster';
import { usePeopleVersion } from '@/lib/people';

export const CIRCLE_TABS = ['posts', 'chat', 'photos', 'events', 'notes', 'members'] as const;
export type CircleTab = (typeof CIRCLE_TABS)[number];
export const isCircleTab = (x: unknown): x is CircleTab => typeof x === 'string' && (CIRCLE_TABS as readonly string[]).includes(x);

function InvitedView({ s }: { s: CircleSummary }) {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const inviter = usePersonName(s.membership?.invited_by);
  const go = async (yes: boolean) => {
    setBusy(true);
    try {
      if (yes) await acceptInvite(s.circle.audience_id); else await leaveCircle(s.circle);
      void qc.invalidateQueries({ queryKey: ['circles'] });
      if (!yes) router.replace('/circles');
    } catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); }
    setBusy(false);
  };
  return (
    <Card>
      <EmptyState icon="mail" title={s.membership?.invited_by ? t('circles.invite.from', { name: inviter }) : t('circles.invite.generic')}
        body={t('circles.invite.body')}
        actions={<>
          <Button variant="primary" busy={busy} onClick={() => void go(true)}>{t('circles.invite.accept')}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void go(false)}>{t('circles.invite.decline')}</Button>
        </>} />
    </Card>
  );
}

function ChatPanel({ circleId }: { circleId: string }) {
  const t = useT();
  return (
    <Card>
      <EmptyState icon="messages" title={t('circles.chat.title')} body={t('circles.chat.body')}
        actions={<ButtonLink href={`/messages/circle/${circleId}`} variant="primary" icon="messages">{t('circles.chat.open')}</ButtonLink>} />
    </Card>
  );
}

export function CircleScreen({ id, initialTab }: { id: string; initialTab?: string }) {
  const t = useT();
  const router = useRouter();
  const q = useCircle(id);
  const s = q.data ?? null;
  const members = useCircleMembers(s && s.membership?.status !== 'invited' ? s.circle : null);
  const [tab, setTab] = useState<CircleTab>(isCircleTab(initialTab) ? initialTab : 'posts');
  const [inviteOpen, setInviteOpen] = useState(false);
  const d = s ? readCircle(s.circle) : null;
  const info = d?.ok ? d.value : null;
  const admin = s ? isAdmin(s.circle, s.membership) : false;
  usePeopleVersion();
  // Owner + admins with a verified signed grant (R-K-2); null until the members are loaded.
  const authorities = s && members.data ? keyAuthorities({ id: s.circle.audience_id, owner_id: s.circle.creator_id }, members.data) : null;
  useDocumentTitle(info?.name ?? t('nav.circles'));

  // Admin devices keep keys flowing to new members and rotate after someone leaves.
  const circleRow = s?.circle;
  useEffect(() => { if (circleRow && admin) void circleHousekeeping(circleRow); }, [circleRow, admin]);

  const changeTab = (v: CircleTab) => {
    setTab(v);
    router.replace(v === 'posts' ? `/circles/${id}` : `/circles/${id}?tab=${v}`, { scroll: false });
  };

  if (q.isLoading) return <Page title={t('nav.circles')} back={{ href: '/circles', label: t('common.back') }}><Loading /></Page>;
  if (!s) {
    return (
      <Page title={t('nav.circles')} back={{ href: '/circles', label: t('common.back') }}>
        <NotFound icon="circles" title={t('circles.home.notFound')} body={t('circles.home.notFoundBody')}
          actions={<ButtonLink href="/circles" variant="soft">{t('circles.home.backToList')}</ButtonLink>} />
      </Page>
    );
  }
  const active = members.data?.filter((m) => m.status === 'active') ?? [];
  const invited = s.membership?.status === 'invited';
  const title = info?.name ?? t('circles.ui.sealedCircle');

  return (
    <Page title={title} back={{ href: '/circles', label: t('common.back') }}
      actions={admin ? (
        <Link href={`/circles/${id}/settings`} className="k-iconbtn" aria-label={t('circles.settings.title')} title={t('circles.settings.title')}><Icon name="settings" /></Link>
      ) : undefined}>
      <Card className="kc-hero">
        <CircleMark id={s.circle.id} info={info} size="lg" />
        <div className="kc-hero-body">
          {info?.description ? <p dir="auto" className="kc-hero-desc">{info.description}</p> : null}
          {!d?.ok && d ? <SealedNote reason={d.reason} /> : null}
          <div className="k-row-wrap">
            {active.length ? <AvatarStack ids={active.map((m) => m.member_id)} /> : null}
            <span className="k-small k-muted">{t('circles.home.members', { count: active.length || 1 })}</span>
            <span className="k-small k-muted kc-dot">{t('circles.home.private')}</span>
          </div>
        </div>
        {!invited ? (
          <div className="kc-hero-actions">
            <Button variant="primary" size="sm" icon="users" onClick={() => setInviteOpen(true)}>{t('circles.members.invite')}</Button>
            <ButtonLink href={`/messages/circle/${id}`} variant="secondary" size="sm" icon="messages">{t('circles.tab.chat')}</ButtonLink>
          </div>
        ) : null}
      </Card>

      {!invited ? (
        <>
          <AudienceKeyNotices audienceId={s.circle.audience_id} authorities={authorities} where="circle" />
          <RosterNotices audienceId={s.circle.audience_id} days={7} max={3} />
        </>
      ) : null}
      {invited ? <InvitedView s={s} /> : (
        <Tabs label={title} value={tab} onChange={changeTab} items={[
          { value: 'posts', label: t('circles.tab.posts'), panel: (
            <div className="k-stack">
              <Composer audience={{ kind: 'circle', circleId: id }} fixedAudience placeholder={t('circles.posts.placeholder', { name: title })} />
              <Feed scope={{ kind: 'circle', circleId: id }} empty={<Card><EmptyState icon="home" title={t('circles.posts.emptyTitle')} body={t('circles.posts.emptyBody')} /></Card>} />
            </div>
          ) },
          { value: 'chat', label: t('circles.tab.chat'), panel: <ChatPanel circleId={id} /> },
          { value: 'photos', label: t('circles.tab.photos'), panel: <CircleAlbums circle={s.circle} /> },
          { value: 'events', label: t('circles.tab.events'), panel: <CircleEvents circle={s.circle} /> },
          { value: 'notes', label: t('circles.tab.notes'), panel: <CircleNotes circle={s.circle} /> },
          { value: 'members', label: t('circles.tab.members'), count: active.length || undefined, panel: <CircleMembers s={s} onInvite={() => setInviteOpen(true)} /> },
        ]} />
      )}
      <InviteDialog s={s} open={inviteOpen} onClose={() => setInviteOpen(false)} members={members.data ?? []} />
    </Page>
  );
}
