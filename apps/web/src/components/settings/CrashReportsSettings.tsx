'use client';
// Settings → Your data → Crash reports. Off until the person turns it on (lib/crash). Says what a report
// holds and what it never holds, and "See what gets sent" shows the last report this device sent exactly
// as it went out, or, before there is one, the report it would send right now for a made-up error.
import { useState } from 'react';
import { useT } from '@/i18n';
import { setCrashReportsOn, useCrashReports } from '@/lib/crash/prefs';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Switch } from '@/components/ui/Switch';
import { Section } from './shared';

/** The transmitted JSON with line breaks added (same content, easier to read). */
function pretty(body: string): string {
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

export function CrashReportsSection() {
  const t = useT();
  const on = useCrashReports();
  const [shown, setShown] = useState<{ body: string; last: boolean } | null>(null);
  const [open, setOpen] = useState(false);

  function toggle(next: boolean) {
    setCrashReportsOn(next);
    // The Android app writes its own crashes down only while this is on.
    void import('@/lib/crash/client').then((m) => m.syncNativeCrashSetting(next)).catch(() => undefined);
  }

  async function see() {
    const m = await import('@/lib/crash/client');
    const last = m.lastReport();
    setShown(last ? { body: last, last: true } : { body: m.exampleReport(), last: false });
    setOpen(true);
  }

  return (
    <Section id="crash" title={t('crash.title')} description={t('crash.body')}>
      <Switch checked={on} onChange={toggle} label={t('crash.toggle')} description={t('crash.toggleNote')} />
      <div className="k-stack-sm">
        <p className="k-small"><strong>{t('crash.inTitle')}</strong> {t('crash.inBody')}</p>
        <p className="k-small"><strong>{t('crash.outTitle')}</strong> {t('crash.outBody')}</p>
        <p className="k-small k-muted">{t('crash.keep')}</p>
      </div>
      <div><Button variant="secondary" icon="eye" onClick={() => void see()}>{t('crash.see')}</Button></div>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('crash.see')}
        footer={<Button variant="primary" onClick={() => setOpen(false)}>{t('common.done')}</Button>}>
        <div className="k-stack">
          <p>{shown?.last ? t('crash.seeLast') : t('crash.seeExample')}</p>
          <pre className="k-crash-pre" dir="ltr" tabIndex={0} aria-label={t('crash.see')}>{shown ? pretty(shown.body) : ''}</pre>
          <p className="k-small k-muted">{t('crash.seeNote')}</p>
        </div>
      </Dialog>
    </Section>
  );
}
