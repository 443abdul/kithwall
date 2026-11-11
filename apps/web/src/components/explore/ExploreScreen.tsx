'use client';
// Explore (docs/v2/10-follow-public.md §5): public posts from everyone, and people to follow. Nothing here
// is personalised by the server: posts are ranked from public signals only, and what I look at, open or
// search for is never recorded. Tabs come from ./tabs (EXPLORE_TABS), where further public feeds plug in.
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n';
import { Page } from '@/components/shell/AppShell';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { Tabs } from '@/components/ui/Tabs';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { EXPLORE_TABS } from './tabs';

export function ExploreScreen({ initialTab }: { initialTab?: string }) {
  const t = useT();
  const router = useRouter();
  useDocumentTitle(t('nav.explore'));
  const tab = EXPLORE_TABS.some((x) => x.value === initialTab) ? initialTab! : EXPLORE_TABS[0]!.value;
  return (
    <Page title={t('nav.explore')} description={t('explore.description')}
      context={
        <Card className="k-sealed-card">
          <span className="k-nudge-ico" aria-hidden><Icon name="globe" /></span>
          <h2 className="k-card-title">{t('explore.aboutTitle')}</h2>
          <p className="k-muted k-small">{t('explore.aboutBody')}</p>
        </Card>
      }>
      <Tabs label={t('nav.explore')} value={tab} onChange={(v) => router.replace(v === EXPLORE_TABS[0]!.value ? '/explore' : `/explore?tab=${v}`, { scroll: false })}
        items={EXPLORE_TABS.map((x) => ({ value: x.value, label: t(x.label), panel: x.value === tab ? x.render() : null }))} />
    </Page>
  );
}
