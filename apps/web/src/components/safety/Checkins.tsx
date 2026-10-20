'use client';
// Safety centre → Check-ins: "If I don't check in by <time>, alert these people."
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormat, useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import {
  alertNow, cancelCheckin, captureLocation, checkIn, createCheckin, dmPeers, mapLink, type Checkin, type CheckinLocation,
} from '@/lib/safety/checkins';
import { people, usePeopleVersion } from '@/lib/people';
import { PeoplePicker } from '@/components/messages/PeoplePicker';
import { PersonAvatar } from '@/components/messages/look';
import { Section } from '@/components/settings/shared';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Segmented } from '@/components/ui/Segmented';
import { Switch } from '@/components/ui/Switch';
import { TextField, Textarea } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { SafetyPage, useCheckins } from './SafetyCentre';

const PRESETS = ['30', '60', '120', '240', '480', 'custom'] as const;
type Preset = (typeof PRESETS)[number];
const MAX_TEXT = 2000;

function localInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function usePeers(list: Checkin[] | undefined) {
  const { status } = useSession();
  const convs = useMemo(() => [...new Set((list ?? []).flatMap((c) => c.conversations))].sort(), [list]);
  return useQuery({
    queryKey: ['safety', 'peers', convs.join(',')], enabled: status === 'ready' && convs.length > 0,
    queryFn: async () => { const m = await dmPeers(convs); await people.ensure([...m.values()]); return m; },
  });
}

function CheckinCard({ c, peers }: { c: Checkin; peers: Map<string, string> | undefined }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const qc = useQueryClient();
  usePeopleVersion();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmNow, setConfirmNow] = useState(false);
  const names = c.conversations.map((id) => peers?.get(id)).filter((x): x is string => !!x);
  const due = new Date(c.due_at);
  const refresh = () => qc.invalidateQueries({ queryKey: ['safety', 'checkins'] });

  async function run(kind: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(kind);
    try { await fn(); toast({ message: ok }); await refresh(); }
    catch { toast({ message: t('errors.unknown'), tone: 'danger' }); }
    finally { setBusy(null); }
  }

  return (
    <li className="k-checkin">
      <div className="k-checkin-head">
        <span className="k-checkin-time">
          <strong>{c.released_at ? t('safety.checkins.sentAt', { time: f.date(new Date(c.released_at), { dateStyle: 'medium', timeStyle: 'short' }) })
            : t('safety.checkins.dueAt', { time: f.date(due, { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' }) })}</strong>
          {c.repeat_daily && !c.released_at ? <Badge tone="neutral">{t('safety.checkins.daily')}</Badge> : null}
          {c.released_at ? <Badge tone="danger">{t('safety.checkins.sent')}</Badge> : null}
        </span>
        <span className="k-checkin-who">
          {names.map((id) => <PersonAvatar key={id} id={id} size={28} />)}
          <span className="k-small k-muted">{names.length ? f.list(names.map((id) => people.person(id)?.name ?? '')) : t('safety.checkins.alerts', { count: c.conversations.length })}</span>
        </span>
      </div>
      {c.released_at ? null : (
        <div className="k-row-wrap">
          <Button variant="primary" icon="check" busy={busy === 'ok'} disabled={!!busy}
            onClick={() => void run('ok', () => checkIn(c.id), c.repeat_daily ? t('safety.checkins.okDaily') : t('safety.checkins.ok'))}>
            {t('safety.checkins.imOk')}
          </Button>
          <Button variant="ghost" busy={busy === 'cancel'} disabled={!!busy}
            onClick={() => void run('cancel', () => cancelCheckin(c.id), t('safety.checkins.cancelled'))}>{t('safety.checkins.cancel')}</Button>
          <Button variant="danger" size="sm" icon="alert" disabled={!!busy} onClick={() => setConfirmNow(true)}>{t('safety.checkins.alertNow')}</Button>
        </div>
      )}
      <Dialog open={confirmNow} onClose={() => setConfirmNow(false)} title={t('safety.checkins.alertNowTitle')}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirmNow(false)}>{t('safety.cancel')}</Button>
          <Button variant="danger" busy={busy === 'now'} onClick={() => { setConfirmNow(false); void run('now', () => alertNow(c.id), t('safety.checkins.alertSent')); }}>{t('safety.checkins.alertNow')}</Button>
        </>}>
        <p>{t('safety.checkins.alertNowBody')}</p>
      </Dialog>
    </li>
  );
}

function NewCheckin({ onDone }: { onDone: () => void }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const qc = useQueryClient();
  const [preset, setPreset] = useState<Preset>('120');
  const [custom, setCustom] = useState(() => localInputValue(new Date(Date.now() + 3 * 3600_000)));
  const [repeat, setRepeat] = useState(false);
  const [who, setWho] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [loc, setLoc] = useState<CheckinLocation | null>(null);
  const [locErr, setLocErr] = useState<string | null>(null);
  const [locBusy, setLocBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);

  const due = preset === 'custom' ? new Date(custom) : new Date(now + Number(preset) * 60_000);
  const dueOk = !Number.isNaN(due.getTime()) && due.getTime() >= now + 5 * 60_000 && due.getTime() <= now + 31 * 86_400_000;
  const dueLabel = dueOk ? f.date(due, { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' }) : '';

  function compose(): string {
    const parts = [t('safety.checkins.alertHeader', { time: dueLabel })];
    if (text.trim()) parts.push(text.trim());
    if (loc) parts.push(t('safety.checkins.alertLocation', {
      time: f.date(new Date(loc.at), { dateStyle: 'medium', timeStyle: 'short' }), accuracy: loc.accuracy, link: mapLink(loc),
    }));
    parts.push(t('safety.checkins.alertFooter'));
    return parts.join('\n\n');
  }

  async function attach() {
    setLocBusy(true); setLocErr(null);
    try { setLoc(await captureLocation()); }
    catch (e) { setLocErr((e as Error).message === 'denied' ? t('safety.checkins.locDenied') : t('safety.checkins.locUnavailable')); }
    finally { setLocBusy(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!dueOk) { setErr(t('safety.checkins.badDeadline')); return; }
    if (!who.length) { setErr(t('safety.checkins.choosePeople')); return; }
    setBusy(true); setErr(null);
    try {
      await createCheckin({ due, repeatDaily: repeat, text: compose(), contacts: who, location: loc });
      toast({ message: t('safety.checkins.armed', { time: dueLabel }) });
      await qc.invalidateQueries({ queryKey: ['safety', 'checkins'] });
      onDone();
    } catch (e2) {
      const m = (e2 as Error).message;
      setErr(m === 'too_many' ? t('safety.checkins.tooMany') : m === 'bad_deadline' ? t('safety.checkins.badDeadline') : t('errors.unknown'));
    } finally { setBusy(false); }
  }

  return (
    <form className="k-stack" onSubmit={submit}>
      <div className="k-stack-sm">
        <span className="k-label">{t('safety.checkins.when')}</span>
        <Segmented label={t('safety.checkins.when')} value={preset} onChange={setPreset}
          options={PRESETS.map((p) => ({ value: p, label: p === 'custom' ? t('safety.checkins.custom') : Number(p) < 60 ? t('safety.checkins.inMinutes', { count: Number(p) }) : t('safety.checkins.inHours', { count: Number(p) / 60 }) }))} />
        {preset === 'custom' ? (
          <TextField label={t('safety.checkins.deadline')} type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
        ) : null}
        <p className="k-hint">{dueOk ? t('safety.checkins.dueHint', { time: dueLabel }) : t('safety.checkins.badDeadline')}</p>
      </div>
      <Switch checked={repeat} onChange={setRepeat} label={t('safety.checkins.repeat')} description={t('safety.checkins.repeatHint')} />
      <div className="k-stack-sm">
        <span className="k-label">{t('safety.checkins.who')}</span>
        <p className="k-hint">{t('safety.checkins.whoHint')}</p>
        <PeoplePicker selected={who} max={10} onToggle={(id) => setWho((w) => (w.includes(id) ? w.filter((x) => x !== id) : w.length >= 10 ? w : [...w, id]))} />
      </div>
      <Textarea label={t('safety.checkins.message')} hint={t('safety.checkins.messageHint')} rows={4} maxLength={MAX_TEXT} dir="auto"
        value={text} onChange={(e) => setText(e.target.value)} placeholder={t('safety.checkins.messagePlaceholder')} />
      <div className="k-stack-sm">
        <span className="k-label">{t('safety.checkins.location')}</span>
        {loc ? (
          <div className="k-row-wrap">
            <Badge tone="success">{t('safety.checkins.locAttached', { accuracy: loc.accuracy })}</Badge>
            <Button size="sm" variant="ghost" onClick={() => setLoc(null)}>{t('safety.checkins.locRemove')}</Button>
          </div>
        ) : (
          <div><Button variant="secondary" icon="mapPin" busy={locBusy} onClick={() => void attach()}>{t('safety.checkins.locAttach')}</Button></div>
        )}
        <p className="k-hint">{locErr ?? t('safety.checkins.locHint')}</p>
      </div>
      <details className="k-checkin-preview">
        <summary>{t('safety.checkins.preview')}</summary>
        <p dir="auto">{dueOk ? compose() : ''}</p>
      </details>
      {err ? <Callout tone="danger">{err}</Callout> : null}
      <div className="k-row-wrap">
        <Button type="submit" variant="primary" icon="clock" busy={busy} disabled={!dueOk || !who.length}>{t('safety.checkins.arm')}</Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>{t('safety.cancel')}</Button>
      </div>
    </form>
  );
}

export function Checkins() {
  const t = useT();
  const q = useCheckins();
  const peers = usePeers(q.data);
  const [creating, setCreating] = useState(false);
  const active = (q.data ?? []).filter((c) => !c.released_at);
  const past = (q.data ?? []).filter((c) => c.released_at);
  return (
    <SafetyPage title={t('safety.checkins.title')} description={t('safety.checkins.pageBody')}>
      <Section id="checkins-active" title={t('safety.checkins.yours')}>
        {q.isLoading ? <Skeleton height={64} /> : null}
        {q.data && !active.length && !creating ? <p className="k-muted k-small">{t('safety.checkins.none')}</p> : null}
        {active.length ? <ul className="k-checkins">{active.map((c) => <CheckinCard key={c.id} c={c} peers={peers.data} />)}</ul> : null}
        {creating ? null : <div><Button variant="primary" icon="plus" onClick={() => setCreating(true)} disabled={active.length >= 5}>{t('safety.checkins.new')}</Button></div>}
      </Section>
      {creating ? (
        <Section id="checkins-new" title={t('safety.checkins.new')}>
          <NewCheckin onDone={() => setCreating(false)} />
        </Section>
      ) : null}
      {past.length ? (
        <Section id="checkins-past" title={t('safety.checkins.past')}>
          <ul className="k-checkins">{past.map((c) => <CheckinCard key={c.id} c={c} peers={peers.data} />)}</ul>
        </Section>
      ) : null}
      <Callout tone="info" icon="info">{t('safety.checkins.how')}</Callout>
    </SafetyPage>
  );
}
