'use client';
// /offline: the page public/sw.js keeps so that Kithwall opens without the internet (Kit Drop, docs/v2/
// 08-censorship.md §5). The service worker answers with it when a page can't be loaded, and serves it from
// its cache when it is opened directly (the Android app's offline page links here). The account opens from
// what this device kept (lib/keys/offline); then the Kit Drop page: posts waiting to go out, making and
// opening Kit Drop files. Nothing here navigates away by itself; "Try again" goes back to where the person was.
import { useT } from '@/i18n';
import { AppGate } from '@/components/shell/AppGate';
import { V2Root } from '@/components/shell/V2Root';
import { Logo } from '@/components/shell/Logo';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { KitDropScreen } from '@/components/posts/KitDrop';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { safePath } from '@/lib/auth/next';
import { useSession } from '@/lib/keys/session';

/** "Try again": back to the page that couldn't be loaded (?from=, set by public/sw.js), or Home. */
function goBack() {
  const p = safePath(new URLSearchParams(location.search).get('from'));
  location.assign(p && !p.startsWith('/offline') ? p : '/home');
}

export function OfflineShell() {
  return <V2Root><AppGate offline={<OfflineUnavailable />}><OfflineKitDrop /></AppGate></V2Root>;
}

function OfflineKitDrop() {
  const t = useT();
  const { offline } = useSession();
  const notice = offline ? (
    <Callout icon="sealed">
      <div className="k-stack-sm">
        <span>{t('offline.shellBody')}</span>
        <div><Button size="sm" variant="soft" icon="refresh" onClick={goBack}>{t('offline.tryAgain')}</Button></div>
      </div>
    </Callout>
  ) : (
    <Callout tone="success">
      <div className="k-stack-sm">
        <span>{t('offline.backOnline')}</span>
        <div><Button size="sm" variant="primary" onClick={goBack}>{t('offline.openKithwall')}</Button></div>
      </div>
    </Callout>
  );
  return <KitDropScreen notice={notice} entry="offline" />;
}

/** Signed out, or this device has nothing to open the account with offline. */
function OfflineUnavailable() {
  const t = useT();
  const { status } = useSession();
  useDocumentTitle(t('offline.title'));
  return (
    <div className="k-auth">
      <header className="k-pub-head"><Logo size={32} /></header>
      <main id="main" className="k-auth-main">
        <div className="k-flow">
          <section className="k-flow-step k-stack">
            <h1>{t('offline.title')}</h1>
            <p className="k-muted">{status === 'signed_out' ? t('offline.signedOut') : t('offline.unavailable')}</p>
            <p className="k-muted k-small">{t('offline.nothingLost')}</p>
            <Button variant="primary" size="lg" block icon="refresh" onClick={goBack}>{t('offline.tryAgain')}</Button>
          </section>
        </div>
      </main>
    </div>
  );
}
