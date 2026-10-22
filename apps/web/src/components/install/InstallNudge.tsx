'use client';
// Home: a calm "install the app" card for returning visitors only (lib/install.ts nudgeEligible: from the
// second session or three days after the first visit; never in the Kithwall app, when already installed,
// after "Don't ask again", or within 30 days of "Not now"). All of it is remembered on this device only.
import { useState } from 'react';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { useAppLock } from '@/lib/safety/applock';
import { neverInstallNudge, promptInstall, snoozeInstallNudge, useInstall, useInstallNudge } from '@/lib/install';
import { useRecoveryNudge } from '@/components/onboarding/nudges';
import { Card } from '@/components/ui/Card';
import { Button, IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { PlatformSteps } from './InstallSteps';

/** `preview`: the dev-only design preview (/design/shell), which has no session; eligibility still applies. */
export function InstallNudge({ preview }: { preview?: boolean }) {
  const t = useT();
  const toast = useToast();
  const eligible = useInstallNudge();
  const s = useInstall();
  const recovery = useRecoveryNudge();
  const { status } = useSession();
  const { decoy } = useAppLock();
  const [busy, setBusy] = useState(false);

  // One gentle card at a time: saving the recovery key comes first. Never on locked or decoy screens.
  if (!eligible || decoy || (!preview && (recovery || status !== 'ready'))) return null;

  async function install() {
    setBusy(true);
    try {
      const r = await promptInstall();
      if (r === 'accepted') toast({ message: t('install.accepted') });
      else if (r === 'dismissed') snoozeInstallNudge();
    } finally { setBusy(false); }
  }
  const ios = s.platform === 'ios-safari' || s.platform === 'ios-other';
  return (
    <Card className="k-nudge k-install-nudge" role="region" aria-label={t('install.nudge.title')} data-testid="install-nudge">
      <span className="k-nudge-ico" aria-hidden><Icon name="download" /></span>
      <div className="k-nudge-body">
        <h2>{t('install.nudge.title')}</h2>
        <p className="k-muted">{t('install.nudge.body')}{ios ? ` ${t('install.nudge.ios')}` : ''}</p>
        {!s.canInstall ? (
          <details className="k-install-nudge-steps">
            <summary>{t('nudge.pushIosHow')}</summary>
            <PlatformSteps platform={s.platform} />
          </details>
        ) : null}
        <div className="k-row-wrap">
          {s.canInstall ? <Button variant="primary" size="sm" icon="download" busy={busy} onClick={() => void install()}>{t('install.cta')}</Button> : null}
          <Button variant={s.canInstall ? 'ghost' : 'secondary'} size="sm" onClick={snoozeInstallNudge}>{t('common.notNow')}</Button>
          <Button variant="ghost" size="sm" onClick={neverInstallNudge}>{t('install.nudge.never')}</Button>
        </div>
      </div>
      <IconButton icon="close" size="sm" label={t('common.dismiss')} onClick={snoozeInstallNudge} />
    </Card>
  );
}
