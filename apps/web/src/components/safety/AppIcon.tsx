'use client';
// Safety centre → App lock → App icon (Android app only; docs/v2/03-safety.md §13). For people who need to
// hide that they use Kithwall: the app can show on the home screen as Kithwall (the default), Calculator,
// Notes or Weather. Name and icon both change; it is the same app either way (the Android side switches
// between launcher entries, KwIcons.java).
//
// The screen is honest about what a disguise is: a different icon on the home screen, not a hidden app. The
// phone's app list, the notifications and the incoming-call screen still say Kithwall, so the settings that
// cover those are linked right here.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { nativePlatform } from '@/lib/native';
import type { AppIconId } from '@/lib/native/plugins';
import { Section } from '@/components/settings/shared';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';

const NAMES: Record<AppIconId, MessageKey> = {
  kithwall: 'safety.icon.kithwall', calculator: 'safety.icon.calculator', notes: 'safety.icon.notes', weather: 'safety.icon.weather',
};
const ORDER: AppIconId[] = ['kithwall', 'calculator', 'notes', 'weather'];

/** A small picture of each launcher icon (the real ones are drawn by apps/mobile/scripts/gen-assets.mjs). */
function Preview({ id }: { id: AppIconId }) {
  const bg = { kithwall: '#b4532a', calculator: '#37474f', notes: '#f57f17', weather: '#1e88e5' }[id];
  return (
    <svg className="k-appicon-art" viewBox="0 0 48 48" width="48" height="48" aria-hidden focusable="false">
      <rect width="48" height="48" rx="11" fill={bg} />
      {id === 'kithwall' ? (
        <g fill="none" stroke="#fff" strokeWidth="3.2"><circle cx="19.5" cy="21.5" r="7.4" /><circle cx="28.5" cy="26.5" r="7.4" /></g>
      ) : id === 'calculator' ? (
        <>
          <rect x="15" y="10" width="18" height="28" rx="3" fill="#fff" />
          <rect x="18" y="13" width="12" height="5" rx="1" fill={bg} />
          {[23, 28, 33].map((y) => [19.5, 24, 28.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" fill={bg} />))}
        </>
      ) : id === 'notes' ? (
        <>
          <path d="M17 10h9l7 7v18a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3z" fill="#fff" />
          {[20, 24.5, 29].map((y) => <rect key={y} x="18" y={y} width="12" height="1.8" rx=".9" fill={bg} />)}
          <rect x="18" y="33.5" width="7" height="1.8" rx=".9" fill={bg} />
        </>
      ) : (
        <>
          <circle cx="19.5" cy="19.5" r="6" fill="#ffd54f" />
          <g fill="#fff" stroke={bg} strokeWidth="1.4"><path d="M21.5 35a5 5 0 0 1-.6-10 6.6 6.6 0 0 1 12.6 1.6 4.3 4.3 0 0 1-.6 8.4z" /></g>
        </>
      )}
    </svg>
  );
}

export function AppIconSection() {
  const t = useT();
  const toast = useToast();
  // undefined: still asking the app; null: this app can't change its icon.
  const [state, setState] = useState<{ icon: AppIconId; options: AppIconId[] } | null | undefined>(undefined);
  const [picked, setPicked] = useState<AppIconId | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void import('@/lib/native/shell').then((m) => m.getAppIcon()).then((s) => { if (live) setState(s); }).catch(() => { if (live) setState(null); });
    return () => { live = false; };
  }, []);

  // iPhone apps can't offer this the same way, and older Android apps don't have it: say so on Android only.
  if (nativePlatform() !== 'android') return null;

  async function change() {
    if (!picked || !state) return;
    setBusy(true);
    try {
      await (await import('@/lib/native/shell')).setAppIcon(picked);
      setState({ ...state, icon: picked });
      toast({ message: t('safety.icon.changed', { name: t(NAMES[picked]) }) });
      setPicked(null);
    } catch {
      toast({ message: t('errors.unknown'), tone: 'danger' });
    } finally { setBusy(false); }
  }

  const options = state ? ORDER.filter((id) => state.options.includes(id)) : [];
  return (
    <Section id="app-icon" title={t('safety.icon.title')} description={t('safety.icon.body')}>
      {state === null ? <Callout tone="info">{t('safety.icon.update')}</Callout> : (
        <div className="k-appicon-grid" role="radiogroup" aria-label={t('safety.icon.title')} aria-busy={state === undefined}>
          {options.map((id) => {
            const on = state?.icon === id;
            return (
              <button key={id} type="button" role="radio" aria-checked={on} className="k-appicon" disabled={busy}
                onClick={() => { if (!on) setPicked(id); }}>
                <Preview id={id} />
                <span className="k-appicon-name">{t(NAMES[id])}</span>
                <span className="k-appicon-state k-small">{on ? t('safety.icon.current') : id === 'kithwall' ? t('safety.icon.default') : ' '}</span>
              </button>
            );
          })}
        </div>
      )}
      <Callout tone="warning">
        <p><strong>{t('safety.icon.limitsTitle')}</strong></p>
        <ul className="k-safety-bullets">
          <li>{t('safety.icon.limitList')}</li>
          <li>{t('safety.icon.limitNotify')}</li>
          <li>{t('safety.icon.limitSwitch')}</li>
        </ul>
      </Callout>
      <p className="k-small k-muted">
        {t('safety.icon.also')}{' '}
        <Link href="/you/settings/notifications">{t('safety.icon.alsoNotifications')}</Link>{' · '}
        <Link href="/you/safety/hidden">{t('safety.icon.alsoHidden')}</Link>{' · '}
        <a href="#screen">{t('safety.icon.alsoScreen')}</a>
      </p>
      <Dialog open={!!picked} onClose={() => setPicked(null)} dismissible={!busy}
        title={picked ? t('safety.icon.confirmTitle', { name: t(NAMES[picked]) }) : ''}
        footer={<>
          <Button variant="ghost" disabled={busy} onClick={() => setPicked(null)}>{t('safety.cancel')}</Button>
          <Button variant="primary" busy={busy} onClick={() => void change()}>{t('safety.icon.confirm')}</Button>
        </>}>
        <div className="k-stack">
          <p>{picked === 'kithwall' ? t('safety.icon.confirmBack') : t('safety.icon.confirmBody', { name: picked ? t(NAMES[picked]) : '' })}</p>
          <p className="k-muted k-small">{t('safety.icon.confirmClose')}</p>
        </div>
      </Dialog>
    </Section>
  );
}
