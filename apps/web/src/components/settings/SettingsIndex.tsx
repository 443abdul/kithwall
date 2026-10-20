'use client';
// Settings (Kithwall 2): Appearance and Language inline, everything else on its own page.
import { useT } from '@/i18n';
import { signOut } from '@/lib/keys/session';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { List, ListItem } from '@/components/ui/ListItem';
import { StylePicker } from '@/components/onboarding/StylePicker';
import { LanguagePicker } from '@/components/onboarding/LanguagePicker';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Page, useShellHref } from '@/components/shell/AppShell';
import type { IconName } from '@/components/ui/Icon';
import type { MessageKey } from '@/i18n';

const PAGES: { slug: string; icon: IconName; title: MessageKey; sub: MessageKey }[] = [
  { slug: 'account', icon: 'you', title: 'settings.account.title', sub: 'settings.account.sub' },
  { slug: 'security', icon: 'key', title: 'settings.security.title', sub: 'settings.security.sub' },
  { slug: 'privacy', icon: 'eye', title: 'settings.privacy.title', sub: 'settings.privacy.sub' },
  { slug: 'notifications', icon: 'activity', title: 'settings.notifications.title', sub: 'settings.notifications.sub' },
  { slug: 'data', icon: 'share', title: 'settings.data.title', sub: 'settings.data.sub' },
  { slug: 'about', icon: 'info', title: 'settings.about.title', sub: 'settings.about.sub' },
];

export function SettingsIndex() {
  const t = useT();
  const href = useShellHref();
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
      <Card padding="flush">
        <List label={t('you.safety')}>
          <li><ListItem icon="shield" title={t('you.safety')} subtitle={t('you.safetySub')} href={href('/you/safety')} /></li>
        </List>
      </Card>
      <section className="k-stack" aria-labelledby="more-h">
        <h2 id="more-h" className="k-section-title">{t('settings.account')}</h2>
        <Card padding="flush">
          <List>
            {PAGES.map((p) => <li key={p.slug}><ListItem icon={p.icon} title={t(p.title)} subtitle={t(p.sub)} href={href(`/you/settings/${p.slug}`)} /></li>)}
          </List>
        </Card>
      </section>
      <Button variant="secondary" icon="logout" onClick={() => void signOut().then(() => { location.href = '/'; })}>{t('you.signOut')}</Button>
    </Page>
  );
}
