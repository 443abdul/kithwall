'use client';
// The root layout itself failed: this replaces the whole document, so it brings its own <html> and plain
// styles (the app's style sheets and providers are not there) and follows the system's light or dark mode.
// The error goes to the crash reporter, which sends it only if "Send crash reports" is on (lib/crash).
import { useEffect } from 'react';
import { t } from '@/i18n';
import { crashReportsOn } from '@/lib/crash/prefs';

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    if (!crashReportsOn()) return;
    void import('@/lib/crash/client').then((m) => m.captureCrash('react', error)).catch(() => undefined);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, minBlockSize: '100dvh', display: 'grid', placeItems: 'center', padding: 24, font: '16px/1.5 system-ui, sans-serif', colorScheme: 'light dark', background: 'Canvas', color: 'CanvasText' }}>
        <main style={{ maxInlineSize: 420, textAlign: 'center' }}>
          <title>Kithwall</title>
          <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>{t('crash.screen.title')}</h1>
          <p style={{ margin: '0 0 20px' }}>{t('crash.screen.body')}</p>
          <button type="button" onClick={() => retry()} style={{ font: 'inherit', padding: '10px 18px', borderRadius: 10, border: '1px solid', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
            {t('crash.screen.retry')}
          </button>
        </main>
      </body>
    </html>
  );
}
