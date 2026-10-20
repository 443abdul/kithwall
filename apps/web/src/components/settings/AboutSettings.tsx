'use client';
// Settings → Help & about (Kithwall 2). Legal pages still render in the classic layout for now.
import { useT } from '@/i18n';
import { Card } from '@/components/ui/Card';
import { List, ListItem } from '@/components/ui/ListItem';
import { Logo } from '@/components/shell/Logo';
import { SettingsPage, Section } from './shared';

/** Shown in About; bump with releases. */
export const APP_VERSION = '2.0.0-preview.2';

export function AboutSettings() {
  const t = useT();
  return (
    <SettingsPage title={t('settings.about.title')}>
      <section className="k-set-section" aria-labelledby="help-h">
        <h2 id="help-h" className="k-section-title">{t('settings.about.help')}</h2>
        <Card padding="flush">
          <List>
            <li><ListItem icon="info" title={t('footer.help')} href="/help" /></li>
            <li><ListItem icon="lock" title={t('footer.privacy')} href="/legal/privacy" /></li>
            <li><ListItem icon="edit" title={t('footer.terms')} href="/legal/terms" /></li>
            <li><ListItem icon="users" title={t('footer.community')} href="/legal/community" /></li>
            <li><ListItem icon="shield" title={t('footer.lawEnforcement')} href="/legal/law-enforcement" /></li>
          </List>
        </Card>
      </section>
      <Section id="about" title={t('settings.about.about')}>
        <div className="k-set-about">
          <Logo size={40} />
        </div>
        <dl className="k-set-kv">
          <dt>{t('settings.about.version')}</dt><dd className="k-ltr" translate="no">{APP_VERSION}</dd>
        </dl>
        <p className="k-small k-muted">{t('settings.about.body')}</p>
        <p className="k-small k-muted">{t('footer.tagline')}</p>
      </Section>
    </SettingsPage>
  );
}
