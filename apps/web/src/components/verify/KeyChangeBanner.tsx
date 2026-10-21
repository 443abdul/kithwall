'use client';
// "Safety number changed" notices (security review K2). Shown on the person's profile, in 1:1 chats and
// on the verify screen.
//
//  * A contact I VERIFIED now has a different identity key: a strong warning. Kithwall stops sealing new
//    keys to them until I verify again or accept the new key.
//  * Anyone else whose identity keys differ from the ones this device pinned (lib/keys/pins.ts): a
//    Signal-style notice until I acknowledge it. If their old key did not sign the change, sharing new
//    keys with them is paused until I accept it as well.
import { useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { ButtonLink, Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { clearVerified, useIdentityKey, useKeyChangeWarning } from '@/lib/transparency/verified';
import { acceptIdentityChange, useIdentityChange } from '@/lib/keys/pins';
import { keyring } from '@/lib/keys/keyring';

export function KeyChangeBanner({ userId, name, handle, showVerifyLink = true }: { userId: string; name: string; handle: string; showVerifyLink?: boolean }) {
  const t = useT();
  const f = useFormat();
  const w = useKeyChangeWarning(userId);
  const key = useIdentityKey(userId);
  const change = useIdentityChange(userId, key.data);
  const [busy, setBusy] = useState<'accept' | 'clear' | null>(null);
  const verifyHref = `/u/${encodeURIComponent(handle)}/verify`;

  async function accept(alsoClearVerified: boolean) {
    const k = key.data;
    if (!k) return;
    setBusy('accept');
    try {
      if (alsoClearVerified) await clearVerified(userId);
      await acceptIdentityChange(userId, k.sign_pub, k.kx_pub);
      await keyring.deliverPending().catch(() => undefined);
    } finally { setBusy(null); }
  }

  if (w) {
    return (
      <div className="k-keychange" role="alert">
        <Icon name="alert" />
        <div className="k-stack-sm">
          <p className="k-keychange-title">{t('verify.changedTitle', { name })}</p>
          <p className="k-small">
            {t('verify.changedBody', { name, date: f.date(new Date(w.verifiedAt)) })}{' '}
            {w.vouched ? t('verify.changedVouched') : t('verify.changedUnvouched')}
          </p>
          <p className="k-small">{t('keys.pausedVerified', { name })}</p>
          <div className="k-row-wrap">
            {showVerifyLink ? <ButtonLink href={verifyHref} size="sm" variant="primary" icon="shield">{t('verify.verifyAgain')}</ButtonLink> : null}
            <Button size="sm" variant="ghost" busy={busy === 'accept'} onClick={() => void accept(true)}>{t('keys.acceptNew')}</Button>
            <Button size="sm" variant="ghost" busy={busy === 'clear'} onClick={() => { setBusy('clear'); void clearVerified(userId).finally(() => setBusy(null)); }}>
              {t('verify.clear')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!change) return null;
  return (
    <div className="k-keychange" role={change.vouched ? 'status' : 'alert'} data-testid="safety-number-changed">
      <Icon name={change.vouched ? 'shield' : 'alert'} />
      <div className="k-stack-sm">
        <p className="k-keychange-title">{t('keys.changedTitle', { name })}</p>
        <p className="k-small">
          {t('keys.changedBody', { name, date: f.date(new Date(change.pinnedAt)) })}{' '}
          {change.vouched ? t('keys.changedVouched') : t('keys.changedUnvouched', { name })}
          {/* Security re-review R-K-1: this device keeps verifying with the pinned key until the change is accepted. */}
          {change.vouched ? null : <>{' '}{t('keys.unvouchedUnverified')}</>}
        </p>
        <div className="k-row-wrap">
          {showVerifyLink ? <ButtonLink href={verifyHref} size="sm" variant={change.vouched ? 'ghost' : 'primary'} icon="shield">{t('verify.profileLink')}</ButtonLink> : null}
          <Button size="sm" variant={change.vouched ? 'primary' : 'ghost'} busy={busy === 'accept'} onClick={() => void accept(false)}>
            {change.vouched ? t('keys.ok') : t('keys.acceptNew')}
          </Button>
        </div>
      </div>
    </div>
  );
}
