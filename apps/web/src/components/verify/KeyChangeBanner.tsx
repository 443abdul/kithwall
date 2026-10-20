'use client';
// Warning shown when a contact I verified now has a different identity key (their safety number
// changed). Usually they reinstalled or recovered their account; it could also mean someone is in
// the middle. Shown on their profile and the verify screen; chat headers can use it too.
import { useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { ButtonLink, Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { clearVerified, useKeyChangeWarning } from '@/lib/transparency/verified';

export function KeyChangeBanner({ userId, name, handle, showVerifyLink = true }: { userId: string; name: string; handle: string; showVerifyLink?: boolean }) {
  const t = useT();
  const f = useFormat();
  const w = useKeyChangeWarning(userId);
  const [busy, setBusy] = useState(false);
  if (!w) return null;
  return (
    <div className="k-keychange" role="alert">
      <Icon name="alert" />
      <div className="k-stack-sm">
        <p className="k-keychange-title">{t('verify.changedTitle', { name })}</p>
        <p className="k-small">
          {t('verify.changedBody', { name, date: f.date(new Date(w.verifiedAt)) })}{' '}
          {w.vouched ? t('verify.changedVouched') : t('verify.changedUnvouched')}
        </p>
        <div className="k-row-wrap">
          {showVerifyLink ? <ButtonLink href={`/u/${encodeURIComponent(handle)}/verify`} size="sm" variant="primary" icon="shield">{t('verify.verifyAgain')}</ButtonLink> : null}
          <Button size="sm" variant="ghost" busy={busy} onClick={() => { setBusy(true); void clearVerified(userId).finally(() => setBusy(false)); }}>
            {t('verify.clear')}
          </Button>
        </div>
      </div>
    </div>
  );
}
