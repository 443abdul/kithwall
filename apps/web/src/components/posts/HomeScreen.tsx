'use client';
// Home (docs/v2/00-brief.md §4): stories row, the composer, then a chronological feed of your
// connections and circles ending in "You're all caught up". Gentle nudges (recovery key, notifications)
// sit above the composer; the context panel on wide screens holds the invite card.
import { useT } from '@/i18n';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { ButtonLink } from '@/components/ui/Button';
import { Page } from '@/components/shell/AppShell';
import { PushNudge, RecoveryNudge } from '@/components/shell/Nudges';
import { InstallNudge } from '@/components/install/InstallNudge';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { InviteCard } from '@/components/people/InviteCard';
import { StoriesRow } from '@/components/stories/Stories';
import { Composer, Feed } from '.';

export function HomeScreen() {
  const t = useT();
  useDocumentTitle(t('nav.home'));
  return (
    <Page
      title={t('feed.homeTitle')}
      actions={<ButtonLink href="/people" variant="ghost" size="sm" icon="userPlus">{t('people.findPeople')}</ButtonLink>}
      context={<>
        <Card className="k-sealed-card">
          <span className="k-nudge-ico" aria-hidden><Icon name="lock" /></span>
          <h2 className="k-card-title">{t('home.sealedTitle')}</h2>
          <p className="k-muted k-small">{t('home.sealedBody')}</p>
        </Card>
        <Card><InviteCard /></Card>
      </>}
    >
      <StoriesRow />
      <RecoveryNudge />
      <PushNudge />
      <InstallNudge />
      <Composer audience={{ kind: 'connections' }} />
      <Feed scope={{ kind: 'home' }} empty={
        <Card>
          <EmptyState icon="home" title={t('home.emptyTitle')} body={t('home.emptyBody')}
            actions={<ButtonLink href="/people?tab=invite" variant="primary" icon="users">{t('home.invite')}</ButtonLink>} />
        </Card>
      } />
    </Page>
  );
}
