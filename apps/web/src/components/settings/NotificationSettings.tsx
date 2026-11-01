'use client';
// Settings → Notifications (Kithwall 2): push on this device, what to push about (every device),
// a test push, and installing the app. Logic from lib/push.ts (same as the v1 PushSettings section).
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import {
  DEFAULT_PUSH_PREFS, disablePush, enablePush, loadPushPrefs, openNotificationSettings, pushEnabledHere,
  pushSupport, savePushPrefs, sendTestPush, usePushValue, usePushVersion, type PushPrefs,
} from '@/lib/push';
import { Switch } from '@/components/ui/Switch';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { InstallHere } from '@/components/install/InstallHere';
import { useShellHref } from '@/components/shell/AppShell';
import { useToast } from '@/components/ui/Toast';
import { SettingsPage, Section } from './shared';
import { pushFailureToast } from '@/components/push/pushFailure';
import { isNative } from '@/lib/native';

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
  // Finished after a trip to the system notification settings (lib/push refreshPushPermission).
  useEffect(() => {
    const done = () => { setOn(true); toast({ message: t('nudge.pushOn') }); };
    window.addEventListener('kw:push-enabled', done);
    return () => window.removeEventListener('kw:push-enabled', done);
  }, [t, toast]);
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
    } catch (e) {
      pushFailureToast(e, t, toast);
    } finally { setBusy(null); }
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
    try {
      const r = await sendTestPush();
      // The server answers how many devices it actually handed the test to; 0 means nothing will arrive.
      if (r && typeof r.sent === 'number' && r.sent === 0) toast({ message: t('settings.notifications.testNone'), tone: 'danger' });
      else toast({ message: t('settings.notifications.testSent') });
    }
    catch { toast({ message: t('settings.notifications.testFailed'), tone: 'danger' }); } finally { setBusy(null); }
  }

  const blocked = permission === 'denied';
  // In the app a tap always gets somewhere (Android's dialog, or its notification settings), so the switch is
  // never disabled by a "blocked" state; in a browser only the site settings can undo a block.
  const cant = !supported || iosNeedsInstall || (blocked && !isNative());
  return (
    <>
      <Section id="push" title={t('settings.notifications.push')} description={t('settings.notifications.pushBody')}>
        {iosNeedsInstall ? <Callout>{t('nudge.pushIos')}</Callout> : !supported ? <Callout>{t('settings.notifications.unsupported')}</Callout>
          : blocked && isNative() ? (
            <Callout tone="warning">
              <span>{t('nudge.pushBlockedApp')} </span>
              <Button variant="secondary" size="sm" onClick={() => void openNotificationSettings()}>{t('nudge.pushOpenSettings')}</Button>
            </Callout>
          ) : blocked ? <Callout tone="warning">{t('settings.notifications.blocked')}</Callout> : null}
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
  const href = useShellHref();
  // On iPhone and iPad, push needs the installed app (nudge.pushIos links here).
  return (
    <Section id="install" title={t('settings.install.title')} description={t('settings.install.body')}>
      <InstallHere heading={false} />
      <p className="k-small"><Link href={href('/you/settings/apps')}>{t('install.settings.more')}</Link></p>
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
