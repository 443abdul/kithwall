'use client';
// The calm connection banner (docs/v2/08-censorship.md §3): "Connected through a mirror", "You're
// offline", "Can't reach Kithwall right now" or "Kithwall seems blocked here — try these options". Small,
// dismissible for this browser session; never shown when everything works or nothing is configured, and
// never after a single failed check (lib/net/health.ts decides).
import Link from 'next/link';
import { useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import { NET_KEYS } from '@/lib/net/runtime';
import type { NetStatus } from '@/lib/net/endpoints';
import { useNet } from './useNet';

function dismissedFor(): string {
  try { return sessionStorage.getItem(NET_KEYS.dismissed) ?? ''; } catch { return ''; }
}

const SHOWN: Partial<Record<NetStatus, { text: MessageKey; link?: MessageKey; icon: IconName; tone?: 'danger' }>> = {
  rerouted: { text: 'net.banner.rerouted', link: 'net.banner.details', icon: 'shield' },
  offline: { text: 'net.banner.offline', icon: 'info' },
  unreachable: { text: 'net.banner.unreachable', link: 'net.banner.otherApps', icon: 'info' },
  blocked: { text: 'net.banner.blocked', link: 'net.banner.options', icon: 'alert', tone: 'danger' },
};

export function NetBanner() {
  const t = useT();
  const { status } = useNet();
  const [dismissed, setDismissed] = useState<string>(() => (typeof window === 'undefined' ? '' : dismissedFor()));
  const shown = SHOWN[status];
  if (!shown || dismissed === status) return null;
  const dismiss = () => {
    try { sessionStorage.setItem(NET_KEYS.dismissed, status); } catch { /* fine */ }
    setDismissed(status);
  };
  return (
    <div className="kw k-net-banner-root">
      <div className={`k-net-banner${shown.tone === 'danger' ? ' k-net-banner-blocked' : ''}`} role="status">
        <Icon name={shown.icon} />
        <span className="k-net-banner-text">{t(shown.text)}</span>
        {shown.link ? <Link className="k-net-banner-link" href="/help/blocked">{t(shown.link)}</Link> : null}
        <button type="button" className="k-net-banner-close" onClick={dismiss} aria-label={t('common.dismiss')}>
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}
