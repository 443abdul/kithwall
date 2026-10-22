'use client';
// Settings → Apps: install Kithwall on this device (or the steps for any other device). Always here, even
// after "Don't ask again" on the home-screen card (components/install/InstallNudge).
import { useT } from '@/i18n';
import { InstallGuide } from '@/components/install/InstallGuide';
import { SettingsPage, Section } from './shared';

export function AppsSettings() {
  const t = useT();
  return (
    <SettingsPage title={t('install.settings.title')}>
      <Section id="install" title={t('install.title')} description={t('install.settings.description')}>
        <InstallGuide />
      </Section>
    </SettingsPage>
  );
}
