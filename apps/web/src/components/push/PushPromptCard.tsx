'use client';
// News Feed card inviting people to turn on push notifications on this device. Renders nothing when
// push is already on here, unsupported, blocked, or the card was dismissed (it comes back after 60 days).
// Usage: <PushPromptCard />   (optional: className, style)
import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';
import { useSession } from '@/lib/keys/session';
import { dismissPrompt, enablePush, promptDismissed, pushEnabledHere, pushSupport, usePushValue, usePushVersion } from '@/lib/push';

export interface PushPromptCardProps {
  className?: string;
  style?: CSSProperties;
}

export function PushPromptCard({ className, style }: PushPromptCardProps) {
  const v = usePushVersion();
  const { status, userId } = useSession();
  const ios = usePushValue(() => pushSupport().iosNeedsInstall, false);
  // Could this device be asked at all? (supported or iOS-needs-install, not blocked, not dismissed)
  const eligible = usePushValue(() => {
    const s = pushSupport();
    return !promptDismissed() && s.permission !== 'denied' && (s.supported || s.iosNeedsInstall);
  }, false);
  const [enabledHere, setEnabledHere] = useState<boolean | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (status !== 'ready' || !userId || !eligible || ios) return;
    let live = true;
    pushEnabledHere().then((on) => { if (live) setEnabledHere(on); }).catch(() => undefined);
    return () => { live = false; };
  }, [status, userId, eligible, ios, v]);

  const show = !hidden && status === 'ready' && !!userId && eligible && (ios || enabledHere === false);

  if (done) {
    return (
      <div className={['ok', className].filter(Boolean).join(' ')} style={style} role="status">
        Notifications are on. You can choose what to be notified about in <Link href="/settings/account#push">Account Settings</Link>.
      </div>
    );
  }
  if (!show) return null;
  const close = () => { dismissPrompt(); setHidden(true); };

  async function enable() {
    if (!userId) return;
    setBusy(true); setErr(null);
    try { await enablePush(userId); setDone(true); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className={className} role="region" aria-label="Turn on notifications"
      style={{ background: '#edeff4', border: '1px solid #d8dfea', padding: '8px 10px', margin: '0 0 10px', ...style }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, lineHeight: '15px' }}>
          <b style={{ color: '#3b5998' }}>Get notified about messages, even when Kithwall is closed</b>
          {ios ? (
            <div style={{ marginTop: 3 }}>On iPhone and iPad, add Kithwall to your Home Screen first (Share &rarr; Add to Home Screen),
              then open it from there to turn on notifications. <Link href="/settings/account#install">Show me how</Link></div>
          ) : (
            <div style={{ marginTop: 3 }} className="gray">Notifications say who did what (&ldquo;dan sent you a message&rdquo;) &mdash; never what anyone wrote.</div>
          )}
          {err && <div className="err" role="alert" style={{ margin: '6px 0 0' }}>{err}</div>}
          {!ios && (
            <div className="kw-actions" style={{ marginTop: 6 }}>
              <button type="button" className="btn b" disabled={busy} onClick={() => void enable()}>{busy ? 'Turning on…' : 'Turn on notifications'}</button>
              <button type="button" className="btn" disabled={busy} onClick={close}>Not now</button>
            </div>
          )}
        </div>
        <button type="button" aria-label="Dismiss" title="Dismiss" onClick={close}
          style={{ background: 'none', border: 0, cursor: 'pointer', color: '#999', fontSize: 14, lineHeight: '14px', padding: 2 }}>&times;</button>
      </div>
    </div>
  );
}
