'use client';
// "On this device": the install button when the browser offers one, otherwise the steps for this exact
// browser. The server (and a visitor without JavaScript) gets a neutral line pointing at the list of every
// device; the live version replaces it after hydration inside a box with a reserved height.
import { useState, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { promptInstall, useInstall } from '@/lib/install';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { PlatformSteps } from './InstallSteps';

export function InstallHere({ heading = true }: { heading?: boolean }) {
  const t = useT();
  const s = useInstall();
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);

  async function install() {
    setBusy(true);
    try { if ((await promptInstall()) === 'accepted') setAccepted(true); } finally { setBusy(false); }
  }

  let body: ReactNode;
  if (!s.ready) body = <p className="k-muted">{t('install.pickDevice')}</p>;
  else if (s.native || s.isInstalled) body = <p className="k-install-done"><Icon name="check" /> <span>{t('install.installedHere')}</span></p>;
  else if (accepted) body = <p className="k-install-done"><Icon name="check" /> <span>{t('install.accepted')}</span></p>;
  else if (s.canInstall) {
    body = (
      <div><Button variant="primary" size="lg" icon="download" busy={busy} onClick={() => void install()} data-testid="install-button">{t('install.cta')}</Button></div>
    );
  } else body = <PlatformSteps platform={s.platform} />;

  return (
    <div className="k-install-here" data-platform={s.ready ? s.platform : undefined} aria-live="polite">
      {heading ? <h3 className="k-install-here-title">{t('install.thisDevice')}</h3> : null}
      {body}
    </div>
  );
}
