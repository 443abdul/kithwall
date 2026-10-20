'use client';
// "Scheduled" (You → Scheduled posts, phase 3): my posts waiting for their publish time. They are already
// sealed and stored; the database shows them to nobody else until then (RLS + kw.can_read_post), and a
// clock job notifies me when each one goes out. From here: edit, change the time, post now, or cancel.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '@/i18n';
import { Page } from '@/components/shell/AppShell';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { fetchScheduled, readPost, reschedulePost } from '@/lib/content';
import { checkSchedule, durationKey, fromLocalInput, toLocalInput, type ScheduleProblem } from '@/lib/chat/ephemeral';
import { useClock } from '@/lib/chat/clock';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { usePeopleVersion } from '@/lib/people';
import type { PostRow } from '@/lib/types';
import { AudienceTag } from './bits';
import { audienceOf, deletePostFully } from './data';
import { EditDialog, PostBody } from './PostCard';
import { SchedulePicker, scheduleProblemKey, useWhen } from './PostOptions';

export function ScheduledScreen() {
  const t = useT();
  const { status } = useSession();
  useKeyringVersion();
  usePeopleVersion();
  useDocumentTitle(t('schedule.title'));
  const q = useQuery({ queryKey: ['scheduled'], enabled: status === 'ready', queryFn: fetchScheduled });
  // A post leaves this list the moment it goes out.
  const now = useClock(q.data ?? []);
  const rows = (q.data ?? []).filter((r) => r.publish_at && Date.parse(r.publish_at) > now);
  return (
    <Page title={t('schedule.title')} description={t('schedule.youSub')} back={{ href: '/you', label: t('nav.you') }}>
      {q.isPending ? (
        <div className="k-stack"><Card><Skeleton text width="40%" /><Skeleton text width="90%" /></Card></div>
      ) : q.isError ? (
        <Card><EmptyState icon="alert" title={t('schedule.failed')} actions={<Button variant="soft" icon="refresh" onClick={() => void q.refetch()}>{t('feed.retry')}</Button>} /></Card>
      ) : rows.length ? (
        <ul className="k-eph-sched" role="list">
          {rows.map((r) => <li key={r.id}><ScheduledItem row={r} /></li>)}
        </ul>
      ) : (
        <Card>
          <EmptyState icon="calendar" title={t('schedule.emptyTitle')} body={t('schedule.emptyBody')}
            actions={<ButtonLink href="/home" variant="primary" icon="edit">{t('nav.home')}</ButtonLink>} />
        </Card>
      )}
    </Page>
  );
}

function ScheduledItem({ row }: { row: PostRow }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const when = useWhen();
  const d = readPost(row);
  const payload = d.ok ? d.value : null;
  const [step, setStep] = useState<null | 'edit' | 'time' | 'cancel'>(null);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<ScheduleProblem | null>(null);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['scheduled'] });
    void qc.invalidateQueries({ queryKey: ['v2feed'] });
  };
  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true);
    try { await fn(); await refresh(); setStep(null); toast({ message: ok }); }
    catch { toast({ message: t('schedule.failed'), tone: 'danger' }); }
    finally { setBusy(false); }
  }
  function saveTime() {
    const dt = fromLocalInput(value);
    const p = checkSchedule(dt);
    if (p || !dt) { setProblem(p ?? 'invalid'); return; }
    void run(() => reschedulePost(row, dt.toISOString()), t('schedule.rescheduled', { when: when(dt) }));
  }

  return (
    <Card as="article" className="k-eph-sitem" aria-label={t('schedule.goesOut', { when: when(row.publish_at!) })}>
      <header className="k-eph-sitem-head">
        <span className="k-eph-sitem-when"><Icon name="calendar" /> {t('schedule.goesOut', { when: when(row.publish_at!) })}</span>
        <span className="k-eph-sitem-meta k-small k-muted">
          <AudienceTag audience={audienceOf(row)} />
          {row.disappear_secs ? <span><Icon name="clock" /> {t('ephemeral.post.chip', { duration: t(durationKey(row.disappear_secs)) })}</span> : null}
        </span>
      </header>
      {payload ? <PostBody payload={payload} onOpenPhoto={() => undefined} /> : (
        <p className="k-muted k-small"><Icon name="key" /> {t('feed.unverified')}</p>
      )}
      <div className="k-eph-sitem-actions">
        {payload ? <Button size="sm" variant="soft" icon="edit" onClick={() => setStep('edit')} disabled={busy}>{t('schedule.edit')}</Button> : null}
        <Button size="sm" variant="soft" icon="calendar" disabled={busy}
          onClick={() => { setValue(toLocalInput(new Date(row.publish_at!))); setProblem(null); setStep('time'); }}>{t('schedule.reschedule')}</Button>
        <Button size="sm" variant="soft" icon="send" busy={busy && step === null}
          onClick={() => void run(() => reschedulePost(row, null), t('schedule.published'))}>{t('schedule.publishNow')}</Button>
        <Button size="sm" variant="ghost" icon="trash" disabled={busy} onClick={() => setStep('cancel')}>{t('schedule.cancel')}</Button>
      </div>

      {step === 'edit' && payload ? <EditDialog row={row} payload={payload} onClose={() => setStep(null)} /> : null}
      <Dialog open={step === 'time'} onClose={() => setStep(null)} title={t('schedule.reschedule')} sheet dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setStep(null)} disabled={busy}>{t('feed.cancel')}</Button>
          <Button variant="primary" busy={busy} onClick={saveTime}>{t('edit.save')}</Button></>}>
        <SchedulePicker value={value} onChange={(v) => { setValue(v); setProblem(null); }} error={problem ? t(scheduleProblemKey(problem)) : null} />
      </Dialog>
      <Dialog open={step === 'cancel'} onClose={() => setStep(null)} title={t('schedule.cancelTitle')} dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setStep(null)} disabled={busy}>{t('common.back')}</Button>
          <Button variant="danger" busy={busy} onClick={() => void run(() => deletePostFully(row, payload), t('schedule.cancelled'))}>{t('schedule.cancel')}</Button></>}>
        <p>{t('schedule.cancelBody')}</p>
      </Dialog>
    </Card>
  );
}
