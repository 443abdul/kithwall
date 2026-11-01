'use client';
// One message for "couldn't turn notifications on", shared by the nudge and the settings switch. Says what
// to do next instead of a generic failure: open the app's notification settings (Android app), allow them
// in the site settings (browser), or find the browser's quiet prompt (a bell next to the address).
import type { MessageKey } from '@/i18n';
import type { ToastInput } from '@/components/ui/Toast';
import { openNotificationSettings, PushError } from '@/lib/push';
import { isNative } from '@/lib/native';

export function pushFailureToast(e: unknown, t: (k: MessageKey) => string, toast: (x: ToastInput) => void) {
  // The app's foss build explains a missing UnifiedPush app itself (native dialog).
  if ((e as { code?: string } | null)?.code === 'no_distributor') return;
  if (e instanceof PushError && e.code === 'blocked' && isNative()) {
    toast({ message: t('nudge.pushBlockedApp'), tone: 'danger', action: { label: t('nudge.pushOpenSettings'), onClick: () => void openNotificationSettings() } });
    return;
  }
  // Inside the app: say what actually failed (and show the code, so a screenshot tells us), never "browser settings".
  const code = (e as { code?: string } | null)?.code ?? '';
  if (isNative() && !(e instanceof PushError)) {
    const k: MessageKey = code === 'unavailable' ? 'nudge.pushNativeUnavailable' : code === 'timeout' ? 'nudge.pushNativeTimeout'
      : code === 'not_allowed' ? 'nudge.pushNativeNotAllowed' : 'nudge.pushNativeFailed';
    toast({ message: `${t(k)}${code ? ` (${code})` : ''}`, tone: 'danger', duration: 12_000 });
    return;
  }
  const key: MessageKey = e instanceof PushError
    ? e.code === 'pending' ? 'nudge.pushPending' : e.code === 'blocked' ? 'nudge.pushBlockedWeb' : 'nudge.pushFailed'
    : 'nudge.pushFailed';
  toast({ message: t(key), tone: 'danger', duration: 10_000 });
}
