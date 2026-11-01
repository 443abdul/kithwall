'use client';
// Settings → Connection (docs/v2/08-censorship.md): how this device reaches Kithwall, known mirrors,
// Tor (and "Use Tor (Orbot)" in the Android app), where to get the app without a store, and Data Saver.
import Link from 'next/link';
import { useT } from '@/i18n';
import { SettingsPage, Section } from '@/components/settings/shared';
import { ApkPanel, MirrorsPanel, RoutePanel, TorPanel } from './ConnectionPanels';
import { DataSaverPanel } from './DataSaverPanel';

export function ConnectionSettings() {
  const t = useT();
  return (
    <SettingsPage title={t('net.settings.title')}>
      <Section id="data-saver" title={t('saver.title')} description={t('saver.body')}><DataSaverPanel /></Section>
      <Section id="net-route" title={t('net.route.title')}><RoutePanel /></Section>
      <Section id="net-mirrors" title={t('net.mirrors.title')} description={t('net.mirrors.body')}><MirrorsPanel /></Section>
      <Section id="net-tor" title={t('net.tor.title')}><TorPanel /></Section>
      <Section id="net-apk" title={t('net.apk.title')}><ApkPanel /></Section>
      <p className="k-small"><Link href="/help/blocked">{t('net.help.title')}</Link></p>
    </SettingsPage>
  );
}
