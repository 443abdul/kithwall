'use client';
// /mod → Admin → Crash reports: the opt-in reports (app/api/crash), one row per bug. Each row is a group
// of reports with the same fingerprint: how many, the first and last hour seen, the builds it happened in,
// and the newest report as a sample. Admins only (the database refuses everyone else). There is nothing
// here about who sent a report, because the reports don't hold it (lib/crash/scrub.ts).
import { useEffect, useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { sb, must } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

interface Sample {
  kind: string; platform: string; os: string; browser: string; route: string; locale: string;
  app_web: string; app_version: string; app_build: string;
  name: string; message: string; stack: string; component_stack: string;
}
interface Group {
  fingerprint: string; reports: number; first_seen: string; last_seen: string;
  versions: string[]; platforms: string[]; sample: Sample | null;
}

export function CrashReports() {
  const t = useT();
  const f = useFormat();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [err, setErr] = useState(false);
  // Bumped by "Refresh": the list is read again.
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.resolve(sb().rpc('crash_report_groups', { p_limit: 100 }))
      .then((res) => { if (live) { setGroups(must(res) as Group[]); setErr(false); } })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [round]);

  const when = (iso: string) => f.date(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="k-stack" aria-labelledby="mod-crash">
      <h2 id="mod-crash" className="k-section-title">{t('mod.crash.title')}</h2>
      <Card className="k-stack">
        <p className="k-small k-muted">{t('mod.crash.note')}</p>
        {err ? <Callout tone="danger">{t('mod.crash.failed')}</Callout> : null}
        {groups === null && !err ? <Skeleton text /> : null}
        {groups && !groups.length ? <p className="k-muted">{t('mod.crash.empty')}</p> : null}
        {groups?.length ? (
          <ul role="list" className="k-mod-crashes">
            {groups.map((g) => (
              <li key={g.fingerprint}>
                <details>
                  <summary>
                    <span className="k-mod-crash-name" dir="ltr">{g.sample?.name ?? '…'}{g.sample?.message ? `: ${g.sample.message}` : ''}</span>
                    <span className="k-small k-muted">
                      {t('mod.crash.count', { count: g.reports })} · {t('mod.crash.seen', { first: when(g.first_seen), last: when(g.last_seen) })}
                    </span>
                    <span className="k-small k-muted" dir="ltr">{[...g.platforms, ...g.versions].join(' · ')}</span>
                  </summary>
                  {g.sample ? (
                    <div className="k-stack-sm">
                      <p className="k-small k-muted" dir="ltr">
                        {[g.sample.kind, g.sample.platform, g.sample.os, g.sample.browser, g.sample.route, g.sample.locale].filter(Boolean).join(' · ')}
                      </p>
                      <pre className="k-crash-pre" dir="ltr" tabIndex={0}>{[g.sample.stack, g.sample.component_stack].filter(Boolean).join('\n\n')}</pre>
                    </div>
                  ) : null}
                </details>
              </li>
            ))}
          </ul>
        ) : null}
        <div><Button size="sm" variant="ghost" icon="refresh" onClick={() => setRound((n) => n + 1)}>{t('mod.crash.refresh')}</Button></div>
      </Card>
    </section>
  );
}
