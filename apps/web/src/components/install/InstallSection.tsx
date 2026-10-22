'use client';
// Landing page (components/onboarding/Landing.tsx): "Install Kithwall". Server-rendered for search engines
// and visitors without JavaScript; only the "On this device" box depends on the browser.
import { useT, type MessageKey } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import { InstallHere } from './InstallHere';
import { AllDevices } from './InstallSteps';

const BENEFITS: { icon: IconName; text: MessageKey }[] = [
  { icon: 'layout', text: 'install.benefitWindow' },
  { icon: 'activity', text: 'install.benefitNotify' },
  { icon: 'bolt', text: 'install.benefitFast' },
  { icon: 'lock', text: 'install.benefitSame' },
];

export function InstallSection() {
  const t = useT();
  return (
    <section className="k-band k-install" id="install" aria-labelledby="install-title">
      <h2 id="install-title" className="k-band-title">{t('install.title')}</h2>
      <p className="k-band-lede k-muted">{t('install.lede')}</p>
      <div className="k-install-grid">
        <ul role="list" className="k-install-benefits">
          {BENEFITS.map((b) => (
            <li key={b.text}><span className="k-install-benefit-ico" aria-hidden><Icon name={b.icon} /></span><span>{t(b.text)}</span></li>
          ))}
        </ul>
        <InstallHere />
      </div>
      <AllDevices />
      <p className="k-install-native"><Icon name="phone" /> <span>{t('install.native')}</span></p>
    </section>
  );
}
