'use client';
// Phase 1 screens inside the new shell. Home, Circles, Messages and Activity are intentional placeholders
// (the real features land in phase 2); You and Settings are partly functional (Appearance, Language).
import { useState } from 'react';
import { useT } from '@/i18n';
import { signOut } from '@/lib/keys/session';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Tabs } from '@/components/ui/Tabs';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { List, ListItem } from '@/components/ui/ListItem';
import { StylePicker } from '@/components/onboarding/StylePicker';
import { LanguagePicker } from '@/components/onboarding/LanguagePicker';
import { InvitePanel } from '@/components/onboarding/InvitePanel';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Page, useMe, useShellHref } from './AppShell';
import Link from 'next/link';
import { PushNudge, RecoveryNudge } from './Nudges';

function SealedCard() {
  const t = useT();
  return (
    <Card tone="default" className="k-sealed-card">
      <span className="k-nudge-ico" aria-hidden><Icon name="lock" /></span>
      <h2 className="k-card-title">{t('home.sealedTitle')}</h2>
      <p className="k-muted k-small">{t('home.sealedBody')}</p>
    </Card>
  );
}

function InviteButton({ variant = 'primary' as const }: { variant?: 'primary' | 'soft' }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} icon="users" onClick={() => setOpen(true)}>{t('home.invite')}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('home.inviteTitle')} sheet
        footer={<Button variant="secondary" onClick={() => setOpen(false)}>{t('common.done')}</Button>}>
        <div className="k-stack">
          <p className="k-muted">{t('join.peopleBody')}</p>
          <InvitePanel />
        </div>
      </Dialog>
    </>
  );
}

export function HomeScreen() {
  const t = useT();
  useDocumentTitle(t('nav.home'));
  return (
    <Page
      title={t('home.title')}
      context={<><SealedCard /><Card><h2 className="k-card-title">{t('home.peopleTitle')}</h2><p className="k-muted k-small">{t('home.peopleBody')}</p><InviteButton variant="soft" /></Card></>}
    >
      <RecoveryNudge />
      <PushNudge />
      <Card>
        <EmptyState
          icon="home"
          title={t('home.emptyTitle')}
          body={t('home.emptyBody')}
          actions={<InviteButton />}
        />
      </Card>
    </Page>
  );
}

export function CirclesScreen() {
  const t = useT();
  useDocumentTitle(t('nav.circles'));
  return (
    <Page title={t('nav.circles')} description={t('circles.description')}>
      <Card>
        <EmptyState
          icon="circles"
          title={t('circles.emptyTitle')}
          body={t('circles.emptyBody')}
          actions={<Button variant="primary" icon="plus" disabled title={t('shell.comingSoon')}>{t('circles.create')}</Button>}
        />
      </Card>
      <p className="k-center k-small k-muted">{t('circles.groupsNote')} <Link href="/groups">{t('circles.groupsLink')}</Link></p>
    </Page>
  );
}

export function MessagesScreen() {
  const t = useT();
  useDocumentTitle(t('nav.messages'));
  return (
    <Page title={t('nav.messages')} description={t('messages.description')}>
      <Card>
        <EmptyState
          icon="sealed"
          title={t('messages.emptyTitle')}
          body={t('messages.emptyBody')}
          actions={<ButtonLink href="/messages/inbox" variant="soft" iconEnd="forward">{t('messages.openClassic')}</ButtonLink>}
        />
      </Card>
    </Page>
  );
}

export function ActivityScreen() {
  const t = useT();
  const [tab, setTab] = useState<'all' | 'requests'>('all');
  useDocumentTitle(t('nav.activity'));
  return (
    <Page title={t('nav.activity')}>
      <Tabs
        label={t('nav.activity')}
        value={tab}
        onChange={setTab}
        items={[
          { value: 'all', label: t('activity.all'), panel: <Card><EmptyState icon="activity" title={t('activity.caughtUp')} body={t('activity.caughtUpBody')} /></Card> },
          { value: 'requests', label: t('activity.requests'), panel: <Card><EmptyState icon="users" title={t('activity.noRequests')} body={t('activity.noRequestsBody')} /></Card> },
        ]}
      />
    </Page>
  );
}

export function YouScreen() {
  const t = useT();
  const href = useShellHref();
  const me = useMe();
  useDocumentTitle(t('nav.you'));
  const soon = <Badge tone="neutral">{t('common.soon')}</Badge>;
  return (
    <Page title={t('nav.you')}>
      <Card className="k-profile-card">
        <Avatar name={me.name || '?'} src={me.avatar} size={80} />
        <div className="k-profile-names">
          <h2>{me.name || t('you.unnamed')}</h2>
          {me.handle ? <p className="k-muted k-ltr">@{me.handle}</p> : null}
        </div>
        <Button variant="secondary" size="sm" icon="edit" disabled title={t('shell.comingSoon')}>{t('you.edit')}</Button>
      </Card>
      <Card padding="flush">
        <List label={t('nav.you')}>
          <li><ListItem icon="image" title={t('you.albums')} trailing={soon} /></li>
          <li><ListItem icon="edit" title={t('you.notes')} trailing={soon} /></li>
          <li><ListItem icon="calendar" title={t('you.events')} trailing={soon} /></li>
          <li><ListItem icon="shield" title={t('you.safety')} subtitle={t('you.safetySub')} trailing={soon} /></li>
        </List>
      </Card>
      <Card padding="flush">
        <List label={t('settings.title')}>
          <li><ListItem icon="settings" title={t('settings.title')} subtitle={t('you.settingsSub')} href={href('/you/settings')} /></li>
          <li><ListItem icon="gift" title={t('you.donate')} subtitle={t('you.donateSub')} trailing={soon} /></li>
          <li><ListItem icon="logout" title={t('you.signOut')} onClick={() => void signOut().then(() => { location.href = '/'; })} chevron={false} /></li>
        </List>
      </Card>
    </Page>
  );
}

export function SettingsScreen() {
  const t = useT();
  useDocumentTitle(t('settings.title'));
  return (
    <Page title={t('settings.title')} back={{ href: '/you', label: t('common.back') }}>
      <section className="k-stack" aria-labelledby="appearance-h">
        <h2 id="appearance-h" className="k-section-title">{t('settings.appearance')}</h2>
        <Card>
          <div className="k-stack">
            <p className="k-muted k-small">{t('settings.appearanceBody')}</p>
            <StylePicker headingId="appearance-h" />
          </div>
        </Card>
      </section>
      <section className="k-stack" aria-labelledby="language-h">
        <h2 id="language-h" className="k-section-title">{t('settings.language')}</h2>
        <Card>
          <div className="k-stack">
            <LanguagePicker />
            <p className="k-muted k-small">{t('settings.languageNote')}</p>
          </div>
        </Card>
      </section>
      <section className="k-stack" aria-labelledby="account-h">
        <h2 id="account-h" className="k-section-title">{t('settings.account')}</h2>
        <Card padding="flush">
          <List>
            <li><ListItem icon="shield" title={t('settings.security')} subtitle={t('settings.classicNote')} href="/settings/security" /></li>
            <li><ListItem icon="eye" title={t('settings.privacy')} subtitle={t('settings.classicNote')} href="/settings/privacy" /></li>
            <li><ListItem icon="activity" title={t('settings.notifications')} subtitle={t('settings.classicNote')} href="/settings/account" /></li>
          </List>
        </Card>
      </section>
      <Button variant="secondary" icon="logout" onClick={() => void signOut().then(() => { location.href = '/'; })}>{t('you.signOut')}</Button>
    </Page>
  );
}
