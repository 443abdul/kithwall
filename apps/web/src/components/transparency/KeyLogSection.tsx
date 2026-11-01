'use client';
// The public key log on /transparency (#key-log, docs/v2/09-key-transparency.md): what it is, the head this
// device verified, a link to the public witness on GitHub and, on request, a comparison with the latest
// witnessed head. Signed in: whether your own current key is in the log. Works signed out too.
import { useEffect, useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { useSession } from '@/lib/keys/session';
import { checkWitness, clearKeyLogAlarm, refreshHead, useKeyLog, useKeyLogAlarm, useStoredHead, type HeadResult, type WitnessResult } from '@/lib/kt/client';
import { KT_WITNESS } from '@/lib/kt/witness';
import { repoFileUrl } from '@/lib/source';

const short = (h: string) => `${h.slice(0, 16)}…`;

export function KeyLogSection() {
  const t = useT();
  const f = useFormat();
  const { status, userId, profile } = useSession();
  const alarm = useKeyLogAlarm();
  const stored = useStoredHead();
  const [head, setHead] = useState<HeadResult | null>(null);
  const [busy, setBusy] = useState<'head' | 'witness' | null>(null);
  const [witness, setWitness] = useState<WitnessResult | null>(null);
  // Re-checked when the alarm is cleared (nothing counts as checked while it is up).
  const mine = useKeyLog(status === 'ready' && !alarm ? userId : null, profile, { force: true });

  useEffect(() => { let on = true; void refreshHead().then((r) => { if (on) setHead(r); }); return () => { on = false; }; }, []);

  // While the alarm is up, "right now" is what the server showed last, not the head this device trusted.
  const shown = head?.ok ? head.head : alarm ? alarm.got : stored;
  const when = (iso: string | null | undefined) => (iso ? f.date(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  return (
    <section id="key-log" aria-labelledby="key-log-h" className="k-stack">
      <h2 id="key-log-h">{t('kt.page.title')}</h2>
      <p>{t('kt.page.body1')}</p>
      <p>{t('kt.page.body2')}</p>

      {alarm ? (
        <Callout tone="danger">
          <div className="k-stack-sm">
            <strong>{t('kt.alarmTitle')}</strong>
            <p>{t(alarm.kind === 'shrunk' ? 'kt.alarmShrunk' : 'kt.alarmForked')}</p>
            <p className="k-small">{t('kt.page.alarmEvidence', { seen: alarm.seen.size, got: alarm.got.size, date: when(alarm.at) })}</p>
            <p className="k-small k-kt-hash k-ltr" translate="no">{alarm.seen.root} ≠ {alarm.got.root}</p>
            <p className="k-small">{t('kt.page.alarmReset')}</p>
            <div><Button size="sm" variant="ghost" onClick={() => { clearKeyLogAlarm(); setWitness(null); void refreshHead(true).then(setHead); }}>{t('kt.page.reset')}</Button></div>
          </div>
        </Callout>
      ) : null}

      <Card>
        <div className="k-stack-sm">
          <h3 className="k-tr-h3"><Icon name="book" /> {t('kt.page.headTitle')}</h3>
          {shown ? (
            <dl className="k-kt-head">
              <dt>{t('kt.page.entries')}</dt><dd>{f.number(shown.size)}</dd>
              <dt>{t('kt.page.root')}</dt><dd className="k-kt-hash k-ltr" translate="no" title={shown.root}>{short(shown.root)}</dd>
              <dt>{t('kt.page.lastEntry')}</dt><dd>{when(shown.at)}</dd>
              <dt>{t('kt.page.deviceHead')}</dt><dd>{stored ? f.number(stored.size) : t('kt.page.deviceNone')}</dd>
            </dl>
          ) : head && !head.ok && head.reason === 'unavailable' ? <p className="k-small k-muted">{t('kt.unavailableState')}</p> : <p className="k-small k-muted">{t('kt.checking')}</p>}
          {head?.ok ? <p className="k-small k-muted">{t('kt.page.verifiedNote')}</p> : null}
          <div>
            <Button size="sm" variant="secondary" icon="refresh" busy={busy === 'head'} onClick={() => {
              setBusy('head');
              void refreshHead(true).then(setHead).finally(() => setBusy(null));
            }}>{t('kt.page.checkNow')}</Button>
          </div>
          {status === 'ready' && profile && !alarm ? <OwnKey state={mine.state} /> : null}
        </div>
      </Card>

      {KT_WITNESS ? (
        <Card>
          <div className="k-stack-sm">
            <h3 className="k-tr-h3"><Icon name="eye" /> {t('kt.page.witnessTitle')}</h3>
            <p className="k-small">{t('kt.page.witnessBody')}</p>
            <p className="k-small">
              <a href={KT_WITNESS.branchUrl} target="_blank" rel="noopener noreferrer">{t('kt.page.witnessLink')}</a>
            </p>
            <div>
              <Button size="sm" variant="secondary" icon="shield" busy={busy === 'witness'} onClick={() => {
                setBusy('witness');
                void checkWitness().then(setWitness).finally(() => setBusy(null));
              }}>{t('kt.page.compare')}</Button>
            </div>
            <p className="k-xs k-muted">{t('kt.page.compareNote')}</p>
            {witness ? <WitnessCallout r={witness} when={when} /> : null}
          </div>
        </Card>
      ) : null}

      <p className="k-small k-muted">
        <a href={repoFileUrl('docs/v2/09-key-transparency.md')} target="_blank" rel="noopener noreferrer">{t('kt.page.howLink')}</a>
      </p>
    </section>
  );
}

function OwnKey({ state }: { state: string }) {
  const t = useT();
  if (state === 'ok') return <p className="k-keylog k-keylog-ok k-small"><Icon name="check" /><span>{t('kt.page.ownOk')}</span></p>;
  if (state === 'missing' || state === 'bad') return <p className="k-keylog k-keylog-bad k-small" role="alert"><Icon name="alert" /><span>{t('kt.page.ownMissing')}</span></p>;
  if (state === 'checking') return <p className="k-keylog k-small k-muted"><Icon name="info" /><span>{t('kt.checking')}</span></p>;
  if (state === 'unavailable') return <p className="k-keylog k-small k-muted"><Icon name="info" /><span>{t('kt.unavailableState')}</span></p>;
  return null;
}

function WitnessCallout({ r, when }: { r: WitnessResult; when: (iso: string | null | undefined) => string }) {
  const t = useT();
  if (r.ok) return <Callout tone="success">{t('kt.page.witnessMatch', { size: r.witnessed.size, date: when(r.witnessedAt ?? r.witnessed.at) })}</Callout>;
  if (r.reason === 'alarm') return <Callout tone="danger">{t('kt.page.witnessMismatch')}</Callout>;
  return <Callout tone="warning">{t('kt.page.witnessUnavailable')}</Callout>;
}
