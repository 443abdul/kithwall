'use client';
// What a person sees when a screen breaks (React error boundary: app/error.tsx). Says so plainly, offers
// "Try again" and the way home, and hands the error to the crash reporter, which sends it only if the
// person turned "Send crash reports" on (lib/crash). Their content is untouched: it is on the server,
// encrypted, and this screen only failed to draw it.
import Link from 'next/link';
import { useEffect } from 'react';
import { useT } from '@/i18n';
import { useCrashReports } from '@/lib/crash/prefs';
import { Button, ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

/** Hand a caught error to the reporter (a no-op while crash reports are off). */
export function reportCaught(error: unknown, componentStack?: string | null) {
  void import('@/lib/crash/client').then((m) => m.captureCrash('react', error, { componentStack })).catch(() => undefined);
}

export function CrashScreen({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useT();
  const on = useCrashReports();
  useEffect(() => { if (on) reportCaught(error); }, [error, on]);
  return (
    <main id="main" className="k-crash" tabIndex={-1}>
      <EmptyState icon="alert" headingLevel={1} title={t('crash.screen.title')} body={t('crash.screen.body')}
        actions={<>
          <Button variant="primary" icon="refresh" onClick={() => retry()}>{t('crash.screen.retry')}</Button>
          <ButtonLink href="/home" variant="secondary" icon="home">{t('nav.home')}</ButtonLink>
        </>} />
      <p className="k-small k-muted k-crash-note" role="status">
        {on ? t('crash.screen.sent') : t('crash.screen.off')}{' '}
        {on ? null : <Link href="/you/settings/data#crash">{t('crash.screen.settings')}</Link>}
      </p>
    </main>
  );
}
