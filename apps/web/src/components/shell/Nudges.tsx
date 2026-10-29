'use client';
// Home-screen nudges: save the recovery key (after sign-up) and turn on notifications. Dismissible,
// never blocking (brief §5.5).
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { accountApi } from '@/lib/auth/account';
import { dismissPrompt, enablePush, promptDismissed, pushEnabledHere, pushSupport } from '@/lib/push';
import { dismissRecoveryNudge, useRecoveryNudge } from '@/components/onboarding/nudges';
import { Card } from '@/components/ui/Card';
import { Button, ButtonLink, IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { pushFailureToast } from '@/components/push/pushFailure';

export function RecoveryNudge({ force }: { force?: boolean }) {
  const t = useT();
  const show = useRecoveryNudge();
  const { status } = useSession();
  // Already saved (e.g. on another device)? Then the nudge is done.
  useEffect(() => {
    if (!show || force || status !== 'ready') return;
    let live = true;
    accountApi.accountStatus().then((s) => { if (live && s.recoverySaved) dismissRecoveryNudge(); }).catch(() => undefined);
    return () => { live = false; };
  }, [show, force, status]);
  if (!show && !force) return null;
  return (
    <Card tone="accent" className="k-nudge" role="region" aria-label={t('nudge.recoveryTitle')}>
      <span className="k-nudge-ico" aria-hidden><Icon name="key" /></span>
      <div className="k-nudge-body">
        <h2>{t('nudge.recoveryTitle')}</h2>
        <p>{t('nudge.recoveryBody')}</p>
        <div className="k-row-wrap">
          {/* Settings → Security → Recovery key (Kithwall 2). */}
          <ButtonLink href="/you/settings/security#recovery-key" variant="primary" size="sm">{t('nudge.recoveryCta')}</ButtonLink>
          <Button variant="ghost" size="sm" onClick={dismissRecoveryNudge}>{t('common.later')}</Button>
        </div>
      </div>
      <IconButton icon="close" size="sm" label={t('common.dismiss')} onClick={dismissRecoveryNudge} />
    </Card>
  );
}

export function PushNudge() {
  const t = useT();
  const toast = useToast();
  const { status, userId } = useSession();
  const [eligible, setEligible] = useState(false);
  const [ios, setIos] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status !== 'ready' || !userId) return;
    const s = pushSupport();
    const ok = !promptDismissed() && s.permission !== 'denied' && (s.supported || s.iosNeedsInstall);
    if (!ok) return;
    if (s.iosNeedsInstall) { setIos(true); setEligible(true); return; }
    let live = true;
    pushEnabledHere().then((on) => { if (live) setEligible(!on); }).catch(() => undefined);
    return () => { live = false; };
  }, [status, userId]);

  if (!eligible || hidden) return null;
  const close = () => { dismissPrompt(); setHidden(true); };
  async function enable() {
    if (!userId) return;
    setBusy(true);
    try { await enablePush(userId); setHidden(true); toast({ message: t('nudge.pushOn') }); }
    catch (e) { pushFailureToast(e, t, toast); }
    finally { setBusy(false); }
  }
  return (
    <Card className="k-nudge" role="region" aria-label={t('nudge.pushTitle')}>
      <span className="k-nudge-ico" aria-hidden><Icon name="activity" /></span>
      <div className="k-nudge-body">
        <h2>{t('nudge.pushTitle')}</h2>
        <p className="k-muted">{ios ? t('nudge.pushIos') : t('nudge.pushBody')}</p>
        {!ios ? (
          <div className="k-row-wrap">
            <Button variant="primary" size="sm" busy={busy} onClick={() => void enable()}>{t('nudge.pushCta')}</Button>
            <Button variant="ghost" size="sm" onClick={close}>{t('common.notNow')}</Button>
          </div>
        ) : <Link href="/you/settings/notifications#install">{t('nudge.pushIosHow')}</Link>}
      </div>
      <IconButton icon="close" size="sm" label={t('common.dismiss')} onClick={close} />
    </Card>
  );
}
