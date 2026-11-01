'use client';
// "Safety number changed" notices (security review K2). Shown on the person's profile, in 1:1 chats and
// on the verify screen.
//
//  * A contact I VERIFIED now has a different identity key: a strong warning. Kithwall stops sealing new
//    keys to them until I verify again or accept the new key.
//  * Anyone else whose identity keys differ from the ones this device pinned (lib/keys/pins.ts): a
//    Signal-style notice until I acknowledge it. If their old key did not sign the change, sharing new
//    keys with them is paused until I accept it as well.
//  * Their current key is not provably in Kithwall's public key log (lib/kt/client.ts, docs/v2/09): the
//    same warning, on its own or added to the two above. Sharing new keys with that key is paused until I
//    accept it (accepting the key change accepts this too).
import { useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { ButtonLink, Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { clearVerified, useIdentityKey, useKeyChangeWarning } from '@/lib/transparency/verified';
import { acceptIdentityChange, useIdentityChange } from '@/lib/keys/pins';
import { keyring } from '@/lib/keys/keyring';
import { acceptKeyLogFailure, useKeyLog } from '@/lib/kt/client';

export function KeyChangeBanner({ userId, name, handle, showVerifyLink = true }: { userId: string; name: string; handle: string; showVerifyLink?: boolean }) {
  const t = useT();
  const f = useFormat();
  const w = useKeyChangeWarning(userId);
  const key = useIdentityKey(userId);
  const change = useIdentityChange(userId, key.data);
  const log = useKeyLog(userId, key.data);
  const [busy, setBusy] = useState<'accept' | 'clear' | null>(null);
  const verifyHref = `/u/${encodeURIComponent(handle)}/verify`;
  const logFailed = log.state === 'missing' || log.state === 'bad';
  const logLine = logFailed ? <p className="k-small" data-testid="key-log-failed">{t(log.state === 'bad' ? 'kt.badLine' : 'kt.missingLine', { name })}</p> : null;

  async function accept(alsoClearVerified: boolean) {
    const k = key.data;
    if (!k) return;
    setBusy('accept');
    try {
      if (alsoClearVerified) await clearVerified(userId);
      await acceptIdentityChange(userId, k.sign_pub, k.kx_pub);
      if (logFailed) await acceptKeyLogFailure(userId, k.sign_pub, k.kx_pub);
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
          {logLine}
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

  if (change) {
    const calm = change.vouched && !logFailed;
    return (
      <div className="k-keychange" role={calm ? 'status' : 'alert'} data-testid="safety-number-changed">
        <Icon name={calm ? 'shield' : 'alert'} />
        <div className="k-stack-sm">
          <p className="k-keychange-title">{t('keys.changedTitle', { name })}</p>
          <p className="k-small">
            {t('keys.changedBody', { name, date: f.date(new Date(change.pinnedAt)) })}{' '}
            {change.vouched ? t('keys.changedVouched') : t('keys.changedUnvouched', { name })}
            {/* Security re-review R-K-1: this device keeps verifying with the pinned key until the change is accepted. */}
            {change.vouched ? null : <>{' '}{t('keys.unvouchedUnverified')}</>}
          </p>
          {logLine}
          <div className="k-row-wrap">
            {showVerifyLink ? <ButtonLink href={verifyHref} size="sm" variant={calm ? 'ghost' : 'primary'} icon="shield">{t('verify.profileLink')}</ButtonLink> : null}
            <Button size="sm" variant={calm ? 'primary' : 'ghost'} busy={busy === 'accept'} onClick={() => void accept(false)}>
              {calm ? t('keys.ok') : t('keys.acceptNew')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!logFailed || !key.data) return null;
  const k = key.data;
  return (
    <div className="k-keychange" role="alert" data-testid="key-log-warning">
      <Icon name="alert" />
      <div className="k-stack-sm">
        <p className="k-keychange-title">{t('kt.warnTitle', { name })}</p>
        {logLine}
        <p className="k-small">{t('kt.warnBody', { name })}</p>
        <div className="k-row-wrap">
          {showVerifyLink ? <ButtonLink href={verifyHref} size="sm" variant="primary" icon="shield">{t('verify.profileLink')}</ButtonLink> : null}
          <Button size="sm" variant="ghost" busy={busy === 'accept'} onClick={() => {
            setBusy('accept');
            void acceptKeyLogFailure(userId, k.sign_pub, k.kx_pub).then(() => keyring.deliverPending()).catch(() => undefined).finally(() => setBusy(null));
          }}>{t('kt.acceptAnyway')}</Button>
        </div>
      </div>
    </div>
  );
}
