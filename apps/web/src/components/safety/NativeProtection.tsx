'use client';
// Safety centre → App lock, app-only sections (docs/v2/05-native.md §4 and §6). Render nothing in a
// browser.
//  - Biometric unlock: an alternative to the app PIN on this phone (real unlock only; the duress PIN
//    keeps working on the PIN pad).
//  - Screenshots and app preview: Android FLAG_SECURE (blocks screenshots and recordings, blank preview in
//    recent apps); iOS covers the app-switcher snapshot (iOS can't block screenshots). Off by default.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useT } from '@/i18n';
import { isNative, nativePlatform } from '@/lib/native';
import { useAppLock } from '@/lib/safety/applock';
import { biometricOn, biometricSupport, disableBiometricUnlock, enableBiometricUnlock } from '@/lib/safety/biometric';
import { Section } from '@/components/settings/shared';
import { Callout } from '@/components/ui/Callout';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';

const never = () => () => undefined;
/** false during SSR and hydration, the real answer afterwards. */
function useIsNative(): boolean {
  return useSyncExternalStore(never, isNative, () => false);
}

function BiometricSection() {
  const t = useT();
  const toast = useToast();
  const { pin } = useAppLock();
  const [support, setSupport] = useState<boolean | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([biometricSupport(), biometricOn()]).then(([s, o]) => { if (live) { setSupport(s.available); setOn(o); } }).catch(() => { if (live) setSupport(false); });
    return () => { live = false; };
  }, [pin]);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      if (next) await enableBiometricUnlock({ title: t('safety.bio.prompt'), cancel: t('safety.cancel') });
      else await disableBiometricUnlock();
      setOn(next);
      toast({ message: next ? t('safety.bio.enabled') : t('safety.bio.disabled') });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code !== 'cancelled') toast({ message: t('errors.unknown'), tone: 'danger' });
    } finally { setBusy(false); }
  }

  return (
    <Section id="biometric" title={t('safety.bio.title')} description={t('safety.bio.body')}>
      {pin !== 'set' ? <Callout tone="info">{t('safety.bio.needsPin')}</Callout>
        : support === false ? <Callout tone="info">{t('safety.bio.unavailable')}</Callout>
          : <Switch checked={on} disabled={busy || support === null} onChange={(v) => void toggle(v)} label={t('safety.bio.enable')} />}
      <Callout tone="warning">{t('safety.bio.limits')}</Callout>
    </Section>
  );
}

function ScreenSection() {
  const t = useT();
  const toast = useToast();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void import('@/lib/native/shell').then((m) => m.getSecureScreen()).then((v) => { if (live) setOn(v); }).catch(() => { if (live) setOn(false); });
    return () => { live = false; };
  }, []);
  async function toggle(next: boolean) {
    const prev = on;
    setOn(next);
    try { await (await import('@/lib/native/shell')).setSecureScreen(next); }
    catch { setOn(prev); toast({ message: t('errors.unknown'), tone: 'danger' }); }
  }
  return (
    <Section id="screen" title={t('safety.screen.title')} description={t('safety.screen.body')}>
      <Switch checked={!!on} disabled={on === null} onChange={(v) => void toggle(v)} label={t('safety.screen.toggle')} />
      {nativePlatform() === 'ios' ? <p className="k-hint">{t('safety.screen.iosHint')}</p> : null}
    </Section>
  );
}

export function NativeProtectionSections() {
  const native = useIsNative();
  if (!native) return null;
  return (
    <>
      <BiometricSection />
      <ScreenSection />
    </>
  );
}
