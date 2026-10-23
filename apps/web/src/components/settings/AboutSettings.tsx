'use client';
// Settings → Help & about (Kithwall 2).
import { useT } from '@/i18n';
import { Card } from '@/components/ui/Card';
import { List, ListItem } from '@/components/ui/ListItem';
import { Icon } from '@/components/ui/Icon';
import { Logo } from '@/components/shell/Logo';
import { COMMIT_SHA, shortCommit, sourceUrl } from '@/lib/source';
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
            <li><ListItem icon="gift" title={t('you.donate')} subtitle={t('you.donateSub')} href="/donate" /></li>
            {/* AGPL-3.0 §13: the Corresponding Source of exactly this build (the native apps load this page too). */}
            <li>
              <a className="k-item" href={sourceUrl()} target="_blank" rel="noopener noreferrer">
                <span className="k-item-lead k-item-icon"><Icon name="code" /></span>
                <span className="k-item-body">
                  <span className="k-item-title">{t('settings.about.source')}</span>
                  <span className="k-item-sub">{t('settings.about.sourceSub')}</span>
                </span>
                <span className="k-item-trail"><Icon name="forward" /></span>
              </a>
            </li>
          </List>
        </Card>
      </section>
      <Section id="about" title={t('settings.about.about')}>
        <div className="k-set-about">
          <Logo size={40} />
        </div>
        <dl className="k-set-kv">
          <dt>{t('settings.about.version')}</dt><dd className="k-ltr" translate="no">{APP_VERSION}</dd>
          {COMMIT_SHA ? <><dt>{t('settings.about.build')}</dt><dd className="k-ltr" translate="no"><a href={sourceUrl()} target="_blank" rel="noopener noreferrer">{shortCommit()}</a></dd></> : null}
        </dl>
        <p className="k-small k-muted">{t('settings.about.body')}</p>
      </Section>
    </SettingsPage>
  );
}
