'use client';
// The app lock screen (Safety centre §2). Deliberately anonymous — no name, no avatar — so it looks the
// same whether the real account or the decoy opens behind it. A real PIN unlocks; a duress PIN opens
// the decoy (AppGate switches to it); wrong PINs are slowed down and may wipe this device.
// In the Kithwall app, "Unlock with biometrics" is offered when it was turned on (a real unlock only;
// the duress PIN stays on the pad, docs/v2/05-native.md §4).
import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n';
import { afterLogin } from '@/lib/auth/login';
import { pinWait, unlockWithPin } from '@/lib/safety/applock';
import { biometricOn, unlockWithBiometrics } from '@/lib/safety/biometric';
import { Button } from '@/components/ui/Button';
import { V2Root } from '@/components/shell/V2Root';
import { Logo } from '@/components/shell/Logo';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { PinPad } from './PinPad';

export function PinLockScreen({ onUseOther }: { onUseOther: () => void }) {
  return <V2Root><PinLockInner onUseOther={onUseOther} /></V2Root>;
}

function useCountdown(): [number, () => Promise<void>] {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(async () => { const w = await pinWait(); setNow(Date.now()); setUntil(Date.now() + w); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (until <= now) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until, now]);
  return [Math.max(0, Math.ceil((until - now) / 1000)), refresh];
}

function PinLockInner({ onUseOther }: { onUseOther: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [wait, refreshWait] = useCountdown();
  const [bio, setBio] = useState(false);
  useDocumentTitle(t('safety.lock.title'));
  useEffect(() => {
    let live = true;
    void biometricOn().then((on) => { if (live) setBio(on); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  async function biometric() {
    setBusy(true); setErr(null);
    try {
      const r = await unlockWithBiometrics({ title: t('safety.bio.prompt'), cancel: t('safety.bio.cancel') });
      if (r === 'ok') { await afterLogin(); return; }
      if (r === 'invalidated') { setBio(false); setErr(t('safety.bio.invalidated')); }
      else if (r === 'lockout') setErr(t('safety.bio.lockout'));
      else if (r !== 'cancelled') setErr(t('errors.unknown'));
    } catch {
      setErr(t('errors.unknown'));
    } finally { setBusy(false); }
  }

  async function submit(pin: string) {
    setBusy(true); setErr(null);
    try {
      const r = await unlockWithPin(pin);
      if (r === 'ok') { await afterLogin(); return; }
      if (r === 'decoy') return;
      if (r === 'wiped') { location.replace('/'); return; }
      setErr(r === 'wait' ? t('safety.lock.wait') : t('safety.lock.wrong'));
      await refreshWait();
    } catch {
      setErr(t('errors.unknown'));
    } finally { setBusy(false); }
  }

  return (
    <div className="k-auth k-pinlock">
      <header className="k-pub-head"><Logo size={32} /></header>
      <main id="main" className="k-auth-main">
        <section className="k-flow-step k-pinlock-step" aria-labelledby="k-pinlock-h">
          <span className="k-pinlock-icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></svg>
          </span>
          <h1 id="k-pinlock-h">{t('safety.lock.title')}</h1>
          <p className="k-muted">{t('safety.lock.body')}</p>
          <PinPad
            label={t('safety.pin.label')}
            submitLabel={t('safety.lock.unlock')}
            onSubmit={submit}
            busy={busy}
            disabled={wait > 0}
            error={wait > 0 ? t('safety.lock.waitFor', { count: wait }) : err}
          />
          {bio ? (
            <div className="k-center">
              <Button variant="secondary" icon="lock" onClick={() => void biometric()} disabled={busy}>{t('safety.bio.unlock')}</Button>
            </div>
          ) : null}
          <p className="k-center k-small">
            <button type="button" className="k-linkbtn" onClick={onUseOther}>{t('safety.lock.useOther')}</button>
          </p>
        </section>
      </main>
    </div>
  );
}
