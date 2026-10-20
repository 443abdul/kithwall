'use client';
// Create / edit an event: title, start (+ optional end) in a chosen time zone, place, description,
// optionally inside one of my circles, and who to invite. All details are sealed on this device.
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { TextField, Textarea } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { me } from '@/lib/keys/session';
import { circleMembers, useCircleMembers, useCircleOptions } from '@/components/circles/data';
import { ConnectionPicker, E2eeLine, Loading, NotFound, SelectField } from '@/components/circles/shared';
import { createEvent2, isHost, readEvent2, saveEvent, useEvent2, type EventInfo2 } from './data';
import { checkTimes, deviceTimeZone, timeZoneList, utcToZonedInput, zonedToUtc } from './time';

interface Draft { name: string; start: string; end: string; tz: string; where: string; description: string; circleId: string }

function defaultStart(tz: string): string {
  // The next full hour after an hour from now.
  const ms = Math.ceil(Date.now() / 3600_000) * 3600_000 + 3600_000;
  return utcToZonedInput(new Date(ms).toISOString(), tz);
}

function EventForm({ initial, mode, onSubmit, busy }: {
  initial: Draft; mode: 'new' | 'edit'; busy: boolean;
  onSubmit: (d: Draft, invite: string[], inviteCircle: boolean) => void;
}) {
  const t = useT();
  const [d, setD] = useState<Draft>(initial);
  const [invite, setInvite] = useState<string[]>([]);
  const [inviteCircle, setInviteCircle] = useState(true);
  const [errors, setErrors] = useState<{ name?: string; start?: string; end?: string }>({});
  const circles = useCircleOptions();
  const zones = useMemo(() => timeZoneList(), []);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const circle = circles.options.find((o) => o.id === d.circleId) ?? null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const s = zonedToUtc(d.start, d.tz);
    const en = d.end ? zonedToUtc(d.end, d.tz) : null;
    const err = checkTimes(s, en);
    const next = {
      name: d.name.trim() ? undefined : t('events.form.titleRequired'),
      start: err === 'start' ? t('events.form.startRequired') : undefined,
      end: err === 'order' ? t('events.form.endOrder') : undefined,
    };
    setErrors(next);
    if (next.name || next.start || next.end) return;
    onSubmit(d, invite, inviteCircle);
  };

  return (
    <form className="k-stack" onSubmit={submit} noValidate>
      <Card>
        <div className="k-stack">
          <TextField label={t('events.form.title')} value={d.name} maxLength={140} required error={errors.name}
            placeholder={t('events.form.titlePh')} onChange={(e) => set({ name: e.target.value })} />
          <div className="ke-when">
            <TextField label={t('events.form.start')} type="datetime-local" value={d.start} required error={errors.start}
              onChange={(e) => set({ start: e.target.value })} />
            <TextField label={t('events.form.end')} type="datetime-local" value={d.end} error={errors.end}
              hint={t('events.form.endHint')} onChange={(e) => set({ end: e.target.value })} />
          </div>
          <SelectField label={t('events.form.tz')} value={d.tz} onChange={(tz) => set({ tz })}
            options={zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} hint={t('events.form.tzHint')} />
          <TextField label={t('events.form.where')} value={d.where} maxLength={300} placeholder={t('events.form.wherePh')}
            onChange={(e) => set({ where: e.target.value })} />
          <Textarea label={t('events.form.description')} value={d.description} maxLength={8000} rows={4}
            placeholder={t('events.form.descriptionPh')} onChange={(e) => set({ description: e.target.value })} />
        </div>
      </Card>
      {mode === 'new' ? (
        <Card>
          <div className="k-stack">
            <SelectField label={t('events.form.circle')} value={d.circleId} onChange={(circleId) => set({ circleId })}
              options={[{ value: '', label: t('events.form.noCircle') }, ...circles.options.map((o) => ({ value: o.id, label: o.info?.name ?? t('circles.ui.sealedCircle') }))]}
              hint={d.circleId ? t('events.form.circleHint') : t('events.form.noCircleHint')} />
            {circle ? (
              <Switch checked={inviteCircle} onChange={setInviteCircle} label={t('events.form.inviteCircle')}
                description={t('events.form.inviteCircleHint', { name: circle.info?.name ?? '' })} />
            ) : null}
            {!circle || !inviteCircle ? (
              <div className="k-stack-sm">
                <p className="k-label">{t('events.form.invite')}</p>
                {circle ? <CircleMemberPicker circleRow={circle.row} value={invite} onChange={setInvite} />
                  : <ConnectionPicker value={invite} onChange={setInvite} />}
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}
      <div className="kc-form-actions">
        <Button type="submit" variant="primary" icon="check" busy={busy}>{mode === 'new' ? t('events.form.submit') : t('circles.ui.save')}</Button>
      </div>
      <E2eeLine>{t('events.e2ee')}</E2eeLine>
    </form>
  );
}

function CircleMemberPicker({ circleRow, value, onChange }: { circleRow: Parameters<typeof useCircleMembers>[0]; value: string[]; onChange: (ids: string[]) => void }) {
  const m = useCircleMembers(circleRow);
  if (m.isLoading) return <Loading />;
  const ids = (m.data ?? []).filter((r) => r.status === 'active' && r.member_id !== me()).map((r) => r.member_id);
  return <ConnectionPicker value={value} onChange={onChange} candidates={ids} />;
}

export function NewEventScreen({ circleId }: { circleId?: string }) {
  const t = useT();
  useDocumentTitle(t('events.create'));
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const circles = useCircleOptions();
  const tz = deviceTimeZone();
  const initial: Draft = { name: '', start: defaultStart(tz), end: '', tz, where: '', description: '', circleId: circleId ?? '' };

  const submit = async (d: Draft, invite: string[], inviteCircle: boolean) => {
    setBusy(true);
    try {
      let ids = invite;
      const circle = circles.options.find((o) => o.id === d.circleId);
      if (circle && inviteCircle) {
        ids = (await circleMembers(circle.row)).filter((m) => m.status === 'active' && m.member_id !== me()).map((m) => m.member_id);
      }
      const info: EventInfo2 = {
        name: d.name, start: zonedToUtc(d.start, d.tz)!, ...(d.end ? { end: zonedToUtc(d.end, d.tz)! } : {}),
        tz: d.tz, where: d.where, description: d.description,
      };
      const id = await createEvent2({ info, invite: ids, circleId: circle ? circle.id : null });
      void qc.invalidateQueries({ queryKey: ['events'] });
      toast({ message: t('events.form.created') });
      router.replace(`/circles/events/${id}`);
    } catch {
      toast({ message: t('circles.ui.error'), tone: 'danger' });
      setBusy(false);
    }
  };
  if (circleId && circles.isLoading) return <Page title={t('events.create')}><Loading /></Page>;
  return (
    <Page title={t('events.create')} back={{ href: circleId ? `/circles/${circleId}?tab=events` : '/circles/events', label: t('common.back') }}>
      <EventForm initial={initial} mode="new" busy={busy} onSubmit={(d, i, c) => void submit(d, i, c)} />
    </Page>
  );
}

export function EditEventScreen({ id }: { id: string }) {
  const t = useT();
  useDocumentTitle(t('events.edit'));
  const q = useEvent2(id);
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [initial, setInitial] = useState<Draft | null>(null);
  const s = q.data ?? null;
  const d = s ? readEvent2(s.event) : null;
  const info = d?.ok ? d.value : null;
  useEffect(() => {
    if (!info || initial) return;
    const tz = info.tz ?? deviceTimeZone();
    setInitial({ name: info.name, start: utcToZonedInput(info.start, tz), end: info.end ? utcToZonedInput(info.end, tz) : '', tz,
      where: info.where ?? '', description: info.description ?? '', circleId: s?.event.group_id ?? '' });
  }, [info, initial, s]);
  const back = { href: `/circles/events/${id}`, label: t('common.back') };
  if (q.isLoading) return <Page title={t('events.edit')} back={back}><Loading /></Page>;
  if (!s || !isHost(s.event, s.me)) return <Page title={t('events.edit')} back={back}><NotFound icon="lock" title={t('events.hostsOnly')} /></Page>;
  const submit = async (dr: Draft) => {
    if (!info) return;
    setBusy(true);
    try {
      await saveEvent(s.event, { ...info, name: dr.name, start: zonedToUtc(dr.start, dr.tz)!, end: dr.end ? zonedToUtc(dr.end, dr.tz)! : undefined, tz: dr.tz, where: dr.where, description: dr.description });
      void qc.invalidateQueries({ queryKey: ['events'] });
      toast({ message: t('events.saved') });
      router.replace(`/circles/events/${id}`);
    } catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); setBusy(false); }
  };
  return (
    <Page title={t('events.edit')} back={back}>
      {initial ? <EventForm initial={initial} mode="edit" busy={busy} onSubmit={(dr) => void submit(dr)} /> : <Loading />}
    </Page>
  );
}
