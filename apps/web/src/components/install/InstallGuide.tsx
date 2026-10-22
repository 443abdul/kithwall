'use client';
// Settings → Apps: install on this device, steps for every other device, and the native apps note.
import { useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { InstallHere } from './InstallHere';
import { AllDevices } from './InstallSteps';

export function InstallGuide() {
  const t = useT();
  return (
    <div className="k-stack">
      <InstallHere heading={false} />
      <AllDevices />
      <p className="k-install-native"><Icon name="phone" /> <span>{t('install.native')}</span></p>
    </div>
  );
}
