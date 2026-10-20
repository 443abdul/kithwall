'use client';
// The You tab: my profile summary (with edit), my connections and requests, my things (albums, notes,
// events), settings, and sign out. Settings themselves live under /you/settings (another work stream).
import Link from 'next/link';
import { useState } from 'react';
import { useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { List, ListItem } from '@/components/ui/ListItem';
import { Page, useMe, useShellHref } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { useFriendIds, useRequests } from '@/lib/hooks';
import { signOut } from '@/lib/keys/session';
import { usePerson } from '@/lib/people';
import { EditProfileDialog } from './EditProfile';

export function YouScreen() {
  const t = useT();
  const href = useShellHref();
  const me = useMe();
  const person = usePerson(me.userId);
  const friends = useFriendIds();
  const reqs = useRequests();
  const [editing, setEditing] = useState(false);
  useDocumentTitle(t('nav.you'));
  const soon = <Badge tone="neutral">{t('common.soon')}</Badge>;
  return (
    <Page title={t('nav.you')}>
      <Card className="k-you-card">
        <Link href={me.handle ? `/u/${me.handle}` : '#'} className="k-you-link" aria-label={t('profile.viewProfile')}>
          <Avatar name={me.name || '?'} src={me.avatar} size={72} />
        </Link>
        <div className="k-you-text">
          <h2>{me.name || t('you.unnamed')}</h2>
          {me.handle ? <p className="k-muted k-ltr">@{me.handle}</p> : null}
          {person?.info?.bio ? <p className="k-small" dir="auto">{person.info.bio}</p> : null}
          <div className="k-row-wrap">
            {me.handle ? <ButtonLink href={`/u/${me.handle}`} size="sm" variant="soft">{t('profile.viewProfile')}</ButtonLink> : null}
            <Button size="sm" variant="secondary" icon="edit" onClick={() => setEditing(true)}>{t('profile.edit')}</Button>
          </div>
        </div>
      </Card>
      <Card padding="flush">
        <List label={t('people.title')}>
          <li><ListItem icon="users" title={t('people.title')} href="/people"
            subtitle={friends.data ? t('people.count', { count: friends.data.length }) : undefined}
            trailing={reqs.data?.length ? <Badge count={reqs.data.length} /> : undefined} /></li>
          <li><ListItem icon="qr" title={t('people.tabInvite')} subtitle={t('people.inviteTitle')} href="/people?tab=invite" /></li>
        </List>
      </Card>
      <Card padding="flush">
        <List label={t('nav.you')}>
          <li><ListItem icon="image" title={t('you.albums')} href="/albums" /></li>
          <li><ListItem icon="edit" title={t('you.notes')} href="/notes" /></li>
          <li><ListItem icon="calendar" title={t('you.events')} href="/events" /></li>
          <li><ListItem icon="shield" title={t('you.safety')} subtitle={t('you.safetySub')} trailing={soon} /></li>
        </List>
      </Card>
      <Card padding="flush">
        <List label={t('settings.title')}>
          <li><ListItem icon="settings" title={t('settings.title')} subtitle={t('you.settingsSub')} href={href('/you/settings')} /></li>
          <li><ListItem icon="gift" title={t('you.donate')} subtitle={t('you.donateSub')} trailing={soon} /></li>
          {/* A full page load after signing out drops every in-memory key and cache. */}
          {/* eslint-disable-next-line @next/next/no-location-assign-relative-destination */}
          <li><ListItem icon="logout" title={t('you.signOut')} onClick={() => void signOut().then(() => { location.href = '/'; })} chevron={false} /></li>
        </List>
      </Card>
      {editing ? <EditProfileDialog onClose={() => setEditing(false)} /> : null}
    </Page>
  );
}
