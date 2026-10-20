'use client';
// Settings → Notifications (Kithwall 2): push on this device, what to push about (every device),
// a test push, and installing the app. Logic from lib/push.ts (same as the v1 PushSettings section).
import { useEffect, useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import {
  DEFAULT_PUSH_PREFS, disablePush, enablePush, installState, loadPushPrefs, promptInstall, pushEnabledHere,
  pushSupport, savePushPrefs, sendTestPush, usePushValue, usePushVersion, type PushPrefs,
} from '@/lib/push';
import { Switch } from '@/components/ui/Switch';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { SettingsPage, Section } from './shared';

const KINDS: [keyof PushPrefs, MessageKey, MessageKey][] = [
  ['messages', 'settings.notifications.messages', 'settings.notifications.messagesBody'],
  ['activity', 'settings.notifications.activity', 'settings.notifications.activityBody'],
  ['friend_requests', 'settings.notifications.requests', 'settings.notifications.requestsBody'],
  ['invites', 'settings.notifications.invites', 'settings.notifications.invitesBody'],
  ['security', 'settings.notifications.security', 'settings.notifications.securityBody'],
];

function PushSection() {
  const t = useT();
  const toast = useToast();
  const v = usePushVersion();
  const { userId } = useSession();
  const supported = usePushValue(() => pushSupport().supported, false);
  const iosNeedsInstall = usePushValue(() => pushSupport().iosNeedsInstall, false);
  const permission = usePushValue(() => pushSupport().permission, 'unsupported');
  const [on, setOn] = useState<boolean | null>(null);
  const [prefs, setPrefs] = useState<PushPrefs>(DEFAULT_PUSH_PREFS);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    pushEnabledHere().then((x) => { if (live) setOn(x); }).catch(() => { if (live) setOn(false); });
    return () => { live = false; };
  }, [v, userId]);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    loadPushPrefs(userId).then((p) => { if (live) setPrefs(p); }).catch(() => undefined);
    return () => { live = false; };
  }, [userId]);

  async function toggle(next: boolean) {
    if (!userId) return;
    setBusy('toggle');
    try {
      if (next) await enablePush(userId); else await disablePush(userId);
      setOn(next);
      toast({ message: next ? t('nudge.pushOn') : t('settings.notifications.offHere') });
    } catch { toast({ message: t('nudge.pushFailed'), tone: 'danger' }); } finally { setBusy(null); }
  }
  async function setPref(k: keyof PushPrefs, val: boolean) {
    if (!userId) return;
    const prev = prefs;
    const next = { ...prefs, [k]: val };
    setPrefs(next);
    try { await savePushPrefs(userId, next); } catch { setPrefs(prev); toast({ message: t('settings.saveFailed'), tone: 'danger' }); }
  }
  async function test() {
    setBusy('test');
    try { await sendTestPush(); toast({ message: t('settings.notifications.testSent') }); }
    catch { toast({ message: t('settings.notifications.testFailed'), tone: 'danger' }); } finally { setBusy(null); }
  }

  const blocked = permission === 'denied';
  const cant = !supported || iosNeedsInstall || blocked;
  return (
    <>
      <Section id="push" title={t('settings.notifications.push')} description={t('settings.notifications.pushBody')}>
        {iosNeedsInstall ? <Callout>{t('nudge.pushIos')}</Callout> : !supported ? <Callout>{t('settings.notifications.unsupported')}</Callout>
          : blocked ? <Callout tone="warning">{t('settings.notifications.blocked')}</Callout> : null}
        <Switch checked={!!on} disabled={on === null || busy !== null || (!on && cant)} label={t('settings.notifications.thisDevice')}
          description={on ? t('settings.notifications.onHere') : t('settings.notifications.offHereBody')} onChange={(x) => void toggle(x)} />
        <div><Button variant="secondary" size="sm" busy={busy === 'test'} disabled={!on || busy !== null} onClick={() => void test()}>{t('settings.notifications.test')}</Button></div>
      </Section>
      <Section id="kinds" title={t('settings.notifications.kinds')} description={t('settings.notifications.kindsBody')}>
        {KINDS.map(([k, label, body]) => (
          <Switch key={k} checked={prefs[k]} label={t(label)} description={t(body)} onChange={(x) => void setPref(k, x)} />
        ))}
      </Section>
    </>
  );
}

function InstallSection() {
  const t = useT();
  const canPrompt = usePushValue(() => installState().canPrompt, false);
  const installed = usePushValue(() => installState().installed, false);
  const ios = usePushValue(() => pushSupport().ios, false);
  const [done, setDone] = useState(false);
  return (
    <Section id="install" title={t('settings.install.title')} description={t('settings.install.body')}>
      {installed || done ? <p><Badge tone="success">{t('settings.install.installed')}</Badge></p>
        : ios ? <ol className="k-stack-sm k-small"><li>{t('settings.install.ios1')}</li><li>{t('settings.install.ios2')}</li><li>{t('settings.install.ios3')}</li></ol>
          : canPrompt ? <div><Button variant="primary" icon="phone" onClick={() => void promptInstall().then((r) => { if (r === 'accepted') setDone(true); })}>{t('settings.install.cta')}</Button></div>
            : <p className="k-small k-muted">{t('settings.install.manual')}</p>}
    </Section>
  );
}

export function NotificationSettings() {
  const t = useT();
  return (
    <SettingsPage title={t('settings.notifications.title')} description={t('settings.notifications.description')}>
      <PushSection />
      <InstallSection />
    </SettingsPage>
  );
}
