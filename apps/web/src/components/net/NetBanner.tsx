'use client';
// "Connected through a mirror" / "Kithwall seems blocked here — try these options". Calm, small,
// dismissible for this browser session; never shown when everything works or nothing is configured.
import Link from 'next/link';
import { useState } from 'react';
import { useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { NET_KEYS } from '@/lib/net/runtime';
import { useNet } from './useNet';

function dismissedFor(): string {
  try { return sessionStorage.getItem(NET_KEYS.dismissed) ?? ''; } catch { return ''; }
}

export function NetBanner() {
  const t = useT();
  const { status } = useNet();
  const [dismissed, setDismissed] = useState<string>(() => (typeof window === 'undefined' ? '' : dismissedFor()));
  if ((status !== 'rerouted' && status !== 'blocked') || dismissed === status) return null;
  const dismiss = () => {
    try { sessionStorage.setItem(NET_KEYS.dismissed, status); } catch { /* fine */ }
    setDismissed(status);
  };
  const blocked = status === 'blocked';
  return (
    <div className="kw k-net-banner-root">
      <div className={`k-net-banner${blocked ? ' k-net-banner-blocked' : ''}`} role="status">
        <Icon name={blocked ? 'alert' : 'shield'} />
        <span className="k-net-banner-text">{t(blocked ? 'net.banner.blocked' : 'net.banner.rerouted')}</span>
        <Link className="k-net-banner-link" href="/help/blocked">{t(blocked ? 'net.banner.options' : 'net.banner.details')}</Link>
        <button type="button" className="k-net-banner-close" onClick={dismiss} aria-label={t('common.dismiss')}>
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}
