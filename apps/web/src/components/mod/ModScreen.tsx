'use client';
// Moderation & admin (/mod), staff only. Reports queue with verified disclosures (./verify.ts; chat messages
// can carry sender proof that the database checked, reports.frank), decisions
// recorded in moderation_actions / reports (RPC mod_remove_content); admins also appoint moderators and
// change operator settings (sign-ups, the Public audience, the trusted-friend waiting period).
// The database enforces every permission (staff_roles + RLS); this screen only hides what can't work.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { sb, must } from '@/lib/supabase';
import { me } from '@/lib/keys/session';
import { useIsStaff } from '@/lib/hooks';
import { people, usePeopleVersion } from '@/lib/people';
import { Page } from '@/components/shell/AppShell';
import { PersonAvatar } from '@/components/messages/look';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField, Textarea } from '@/components/ui/Field';
import { Segmented } from '@/components/ui/Segmented';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { payloadText, reporterCopy, verifyReport, type ReportRow, type Verification } from './verify';

type Role = 'admin' | 'moderator';
type Status = 'open' | 'actioned' | 'dismissed';
type Action = 'remove' | 'warn' | 'suspend' | 'ban' | 'restore' | 'dismiss';

const REASONS = ['spam', 'harassment', 'hate', 'violence', 'nudity', 'child_safety', 'self_harm', 'impersonation', 'illegal', 'other'];
const FRANK_LABEL = {
  verified: 'mod.frank.state.verified', failed: 'mod.frank.state.failed', none: 'mod.frank.state.none', not_included: 'mod.frank.state.notIncluded',
} as const satisfies Record<string, MessageKey>;
const KINDS = ['post', 'comment', 'photo', 'message', 'profile', 'group', 'event'];

function useLabels() {
  const t = useT();
  return {
    reason: (r: string) => (REASONS.includes(r) ? t(`feed.reason.${r}` as MessageKey) : r),
    kind: (k: string) => (KINDS.includes(k) ? t(`mod.kind.${k}` as MessageKey) : k),
    who: (id: string | null) => {
      if (!id) return t('mod.deletedAccount');
      const p = people.get(id);
      return p ? `@${p.username}` : '…';
    },
  };
}

export function ModScreen() {
  const t = useT();
  const staff = useIsStaff();
  const [tab, setTab] = useState<'reports' | 'admin'>('reports');
  const role = staff.data ?? null;
  useDocumentTitle(t('mod.title'));
  return (
    <Page title={role === 'admin' ? t('mod.titleAdmin') : t('mod.title')} description={role ? t('mod.description') : undefined}>
      {staff.isPending ? <Skeleton text width="60%" /> : !role ? (
        <Card><EmptyState icon="lock" title={t('mod.noAccess')} body={t('mod.noAccessBody')}
          actions={<ButtonLink href="/home" variant="primary">{t('nav.home')}</ButtonLink>} /></Card>
      ) : role === 'admin' ? (
        <Tabs label={t('mod.title')} value={tab} onChange={setTab} items={[
          { value: 'reports', label: t('mod.reports'), panel: <Reports role={role} /> },
          { value: 'admin', label: t('mod.admin'), panel: <Admin /> },
        ]} />
      ) : <Reports role={role} />}
    </Page>
  );
}

// ------------------------------------------------------------------------------------------- reports

function Reports({ role }: { role: Role }) {
  const t = useT();
  const f = useFormat();
  const L = useLabels();
  usePeopleVersion();
  const [status, setStatus] = useState<Status>('open');
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(async () => {
    setErr(false);
    try {
      const r = must(await sb().from('reports').select('*').eq('status', status).order('created_at', { ascending: status === 'open' }).limit(200)) as ReportRow[];
      await people.ensure(r.flatMap((x) => [x.reporter_id, x.target_owner_id ?? '']).filter(Boolean));
      setRows(r);
    } catch { setErr(true); }
  }, [status]);
  useEffect(() => { setRows(null); setSel(null); void load(); }, [load]);
  const cur = rows?.find((r) => r.id === sel) ?? null;

  return (
    <div className="k-stack">
      <div className="k-row-wrap">
        <Segmented label={t('mod.show')} value={status} onChange={setStatus} options={[
          { value: 'open', label: t('mod.status.open') },
          { value: 'actioned', label: t('mod.status.actioned') },
          { value: 'dismissed', label: t('mod.status.dismissed') },
        ]} />
        <Button variant="ghost" size="sm" icon="refresh" onClick={() => void load()}>{t('mod.refresh')}</Button>
        {rows ? <span className="k-small k-muted">{t('mod.count', { count: rows.length })}</span> : null}
      </div>
      {err ? <Callout tone="danger">{t('errors.network')}</Callout> : null}
      <div className="k-mod" data-selected={cur ? '' : undefined}>
        <Card padding="flush" className="k-mod-queue">
          {rows === null ? <div className="k-pad"><Skeleton text /><Skeleton text width="70%" /></div>
            : rows.length === 0 ? <EmptyState icon="check" title={t('mod.empty')} />
            : (
              <ul role="list" className="k-mod-list">
                {rows.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="k-mod-item" aria-current={sel === r.id ? 'true' : undefined} onClick={() => setSel(r.id)}>
                      <strong>{L.reason(r.reason)}</strong> <Badge tone="neutral">{L.kind(r.target_kind)}</Badge>
                      <span className="k-small k-muted">{L.who(r.target_owner_id)} · {f.date(new Date(r.created_at), { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </Card>
        <div className="k-mod-detail">
          {cur ? <ReportDetail key={cur.id} r={cur} role={role} onBack={() => setSel(null)} onChanged={() => { setSel(null); void load(); }} />
            : <p className="k-muted k-mod-hint">{t('mod.choose')}</p>}
        </div>
      </div>
    </div>
  );
}

function ReportDetail({ r, role, onChanged, onBack }: { r: ReportRow; role: Role; onChanged: () => void; onBack: () => void }) {
  const t = useT();
  const f = useFormat();
  const L = useLabels();
  const toast = useToast();
  usePeopleVersion();
  const [v, setV] = useState<Verification | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [days, setDays] = useState('7');
  const [history, setHistory] = useState<{ action: string; reason: string; created_at: string }[]>([]);
  const when = (iso: string) => f.date(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    void verifyReport(r).then(setV).catch((e) => setV({ state: 'unverifiable', why: (e as Error).message }));
    if (r.target_owner_id) {
      void sb().from('moderation_actions').select('action, reason, created_at').eq('target_user_id', r.target_owner_id)
        .order('created_at', { ascending: false }).limit(10).then(({ data }) => setHistory((data ?? []) as typeof history));
    }
  }, [r]);

  async function act(kind: Action) {
    setBusy(true); setErr(null);
    try {
      const reason = note.trim();
      if (!reason) throw new Error(t('mod.noteRequired'));
      if (kind === 'dismiss') {
        must(await sb().from('reports').update({ status: 'dismissed', decision_note: reason }).eq('id', r.id));
      } else if (kind === 'remove') {
        must(await sb().rpc('mod_remove_content', { report: r.id, note: reason }));
      } else {
        if (!r.target_owner_id) throw new Error(t('mod.deletedAccount'));
        const expires = kind === 'suspend' ? new Date(Date.now() + Number(days) * 86400_000).toISOString() : null;
        must(await sb().from('moderation_actions').insert({ moderator_id: me(), target_user_id: r.target_owner_id, report_id: r.id, action: kind, reason, expires_at: expires }));
        if (r.status === 'open') must(await sb().from('reports').update({ status: 'actioned', decision_note: reason }).eq('id', r.id));
      }
      setConfirm(null);
      toast({ message: t('mod.saved') });
      onChanged();
    } catch (x) { setErr((x as Error).message); setConfirm(null); } finally { setBusy(false); }
  }

  const copy = reporterCopy(r);
  const disclosedText = payloadText(copy);
  const frank = r.target_kind === 'message' ? (r.frank?.state ?? 'none') : null;
  const label = (a: Action) => (a === 'suspend' ? t('mod.action.suspendFor', { count: Number(days) }) : t(`mod.action.${a}` as MessageKey));
  const removable = ['post', 'comment', 'photo', 'message'].includes(r.target_kind) && r.status !== 'dismissed';
  return (
    <div className="k-stack">
      <Button variant="ghost" size="sm" icon="back" className="k-mod-back" onClick={onBack}>{t('mod.backToQueue')}</Button>
      <Card className="k-stack">
        <div className="k-row-wrap">
          <h2 className="k-card-title">{L.reason(r.reason)} · {L.kind(r.target_kind)}</h2>
          <Badge tone={r.status === 'open' ? 'danger' : 'neutral'}>{t(`mod.status.${r.status}` as MessageKey)}</Badge>
        </div>
        <dl className="k-mod-facts">
          <dt>{t('mod.reported')}</dt>
          <dd><span className="k-row"><PersonAvatar id={r.target_owner_id} size={28} /> {L.who(r.target_owner_id)}</span></dd>
          <dt>{t('mod.reporter')}</dt>
          <dd>{L.who(r.reporter_id)} · {when(r.created_at)}</dd>
          {frank ? <><dt>{t('mod.frank.title')}</dt><dd><Badge tone={frank === 'verified' ? 'success' : frank === 'failed' ? 'danger' : 'neutral'}>{t(FRANK_LABEL[frank])}</Badge></dd></> : null}
          {r.details ? <><dt>{t('mod.reporterSays')}</dt><dd className="k-mod-pre" dir="auto">{r.details}</dd></> : null}
          {r.decision_note ? <><dt>{t('mod.decision')}</dt><dd dir="auto">{r.decision_note}{r.resolved_at ? ` · ${when(r.resolved_at)}` : ''}</dd></> : null}
        </dl>
      </Card>

      <Card className="k-stack">
        <h2 className="k-card-title">{t('mod.disclosed')}</h2>
        {frank === 'failed' ? <Callout tone="danger">{t('mod.frank.failed')}</Callout>
          : frank === 'not_included' ? <Callout>{t('mod.frank.notIncluded')}</Callout> : null}
        {v === null ? <Skeleton text /> : v.state === 'franked' ? (
          <Callout tone="success">{t('mod.frank.verified', { who: L.who(v.sender || null), date: v.at ? when(v.at) : '' })}</Callout>
        ) : v.state === 'verified' ? (
          <Callout tone={v.matches ? 'success' : 'warning'}>{v.matches ? t('mod.verified') : t('mod.verifiedDiffers')}</Callout>
        ) : frank === 'not_included' ? null : <Callout tone="danger">{t('mod.notVerified')} {v.why}</Callout>}
        {frank === 'none' && r.disclosed ? <p className="k-small k-muted">{t('mod.frank.none')}</p> : null}
        {v?.state === 'verified' || v?.state === 'franked' ? <div className="k-mod-pre" dir="auto">{payloadText(v.content) || JSON.stringify(v.content, null, 2)}</div> : null}
        {v?.state !== 'franked' && (v?.state !== 'verified' || !v.matches) && (disclosedText || copy) ? (
          <>
            <p className="k-small k-muted">{v?.state === 'verified' ? t('mod.reporterCopy') : t('mod.reporterCopyUnverified')}</p>
            <div className="k-mod-pre" dir="auto">{disclosedText || JSON.stringify(copy, null, 2)}</div>
          </>
        ) : null}
        <p className="k-small k-muted">{t('mod.mediaNote')}</p>
      </Card>

      {history.length ? (
        <Card className="k-stack">
          <h2 className="k-card-title">{t('mod.history')}</h2>
          <ul role="list" className="k-plain-list">
            {history.map((h, i) => <li key={i}><strong>{t(`mod.action.${h.action === 'remove_content' ? 'remove' : h.action}` as MessageKey)}</strong> · <span dir="auto">{h.reason}</span> <span className="k-small k-muted">{when(h.created_at)}</span></li>)}
          </ul>
        </Card>
      ) : null}

      <Card className="k-stack">
        <h2 className="k-card-title">{t('mod.decision')}</h2>
        <Textarea label={t('mod.note')} hint={t('mod.noteHint')} value={note} maxLength={2000} rows={3} dir="auto" onChange={(e) => setNote(e.target.value)} />
        {err ? <Callout tone="danger">{err}</Callout> : null}
        <div className="k-row-wrap">
          {r.status === 'open' ? <Button variant="secondary" disabled={busy} onClick={() => setConfirm('dismiss')}>{t('mod.action.dismiss')}</Button> : null}
          {removable ? <Button variant="danger" disabled={busy} onClick={() => setConfirm('remove')}>{t('mod.action.remove')}</Button> : null}
          <Button variant="secondary" disabled={busy || !r.target_owner_id} onClick={() => setConfirm('warn')}>{t('mod.action.warn')}</Button>
        </div>
        <div className="k-row-wrap">
          <label className="k-mod-days">
            <span className="k-small">{t('mod.suspendLength')}</span>
            <select value={days} onChange={(e) => setDays(e.target.value)} className="k-control">
              {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{t('mod.days', { count: d })}</option>)}
            </select>
          </label>
          <Button variant="secondary" disabled={busy || !r.target_owner_id} onClick={() => setConfirm('suspend')}>{t('mod.action.suspend')}</Button>
          {role === 'admin' ? <Button variant="danger" disabled={busy || !r.target_owner_id} onClick={() => setConfirm('ban')}>{t('mod.action.ban')}</Button> : null}
          <Button variant="ghost" disabled={busy || !r.target_owner_id} onClick={() => setConfirm('restore')}>{t('mod.action.restore')}</Button>
        </div>
      </Card>

      <Dialog open={!!confirm} onClose={() => setConfirm(null)} title={confirm ? label(confirm) : ''}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>{t('feed.cancel')}</Button>
          <Button variant={confirm === 'remove' || confirm === 'ban' ? 'danger' : 'primary'} busy={busy} onClick={() => confirm && void act(confirm)}>{confirm ? label(confirm) : ''}</Button>
        </>}>
        {confirm ? <p>{t(`mod.confirm.${confirm}` as MessageKey, { who: L.who(r.target_owner_id), kind: L.kind(r.target_kind), count: Number(days) })}</p> : null}
        <div className="k-mod-pre" dir="auto">{note.trim() || t('mod.noNote')}</div>
      </Dialog>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- admin

function Admin() {
  const t = useT();
  const f = useFormat();
  const L = useLabels();
  const qc = useQueryClient();
  const toast = useToast();
  usePeopleVersion();
  const [staff, setStaff] = useState<{ user_id: string; role: string; created_at: string }[] | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [err, setErr] = useState<string | null>(null);
  const [wait, setWait] = useState('24');
  const [handle, setHandle] = useState('');
  const [newRole, setNewRole] = useState<Role>('moderator');

  const load = useCallback(async () => {
    try {
      const s = must(await sb().from('staff_roles').select('user_id, role, created_at').order('created_at')) as { user_id: string; role: string; created_at: string }[];
      await people.ensure(s.map((x) => x.user_id));
      setStaff(s);
      const a = must(await sb().from('app_settings').select('key, value')) as { key: string; value: unknown }[];
      const map = Object.fromEntries(a.map((x) => [x.key, x.value]));
      setSettings(map);
      setWait(String(map.recovery_wait_hours ?? 24));
    } catch (x) { setErr((x as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function appoint(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const u = handle.trim().replace(/^@/, '').toLowerCase();
      const p = await people.byUsername(u);
      if (!p) throw new Error(t('mod.noSuchHandle'));
      must(await sb().rpc('grant_staff_role', { target: p.id, new_role: newRole }));
      setHandle('');
      toast({ message: t('mod.appointed', { handle: p.username, role: t(`mod.role.${newRole}`) }) });
      await load();
    } catch (x) { setErr((x as Error).message); }
  }
  async function remove(id: string) {
    setErr(null);
    try { must(await sb().rpc('revoke_staff_role', { target: id })); await load(); } catch (x) { setErr((x as Error).message); }
  }
  async function setSetting(key: string, value: unknown) {
    setErr(null);
    try {
      must(await sb().from('app_settings').update({ value }).eq('key', key));
      toast({ message: t('mod.saved') });
      await load();
      await qc.invalidateQueries({ queryKey: ['setting'] });
    } catch (x) { setErr((x as Error).message); }
  }

  return (
    <div className="k-stack">
      {err ? <Callout tone="danger">{err}</Callout> : null}
      <section className="k-stack" aria-labelledby="mod-staff">
        <h2 id="mod-staff" className="k-section-title">{t('mod.staff')}</h2>
        <Card className="k-stack">
          {staff === null ? <Skeleton text /> : (
            <ul role="list" className="k-mod-staff">
              {staff.map((s) => (
                <li key={s.user_id}>
                  <PersonAvatar id={s.user_id} size={36} />
                  <span className="k-mod-staff-who">
                    <strong>{L.who(s.user_id)}</strong>
                    <span className="k-small k-muted">{t(s.role === 'admin' ? 'mod.role.admin' : 'mod.role.moderator')} · {t('mod.since', { date: f.date(new Date(s.created_at)) })}</span>
                  </span>
                  {s.user_id !== me() ? <Button size="sm" variant="ghost" onClick={() => void remove(s.user_id)}>{t('mod.remove')}</Button> : null}
                </li>
              ))}
            </ul>
          )}
          <form className="k-stack" onSubmit={(e) => void appoint(e)}>
            <TextField label={t('mod.appointHandle')} prefix="@" value={handle} onChange={(e) => setHandle(e.target.value)}
              autoCapitalize="none" autoCorrect="off" spellCheck={false} dir="ltr" required />
            <Segmented label={t('mod.appointRole')} value={newRole} onChange={setNewRole} options={[
              { value: 'moderator', label: t('mod.role.moderator') }, { value: 'admin', label: t('mod.role.admin') },
            ]} />
            <div><Button type="submit" variant="primary" disabled={!handle.trim()}>{t('mod.appoint')}</Button></div>
          </form>
          <p className="k-small k-muted">{t('mod.staffNote')}</p>
        </Card>
      </section>

      <section className="k-stack" aria-labelledby="mod-settings">
        <h2 id="mod-settings" className="k-section-title">{t('mod.settings')}</h2>
        <Card className="k-stack">
          <Switch checked={settings.signups_enabled !== false} onChange={(v) => void setSetting('signups_enabled', v)} label={t('mod.signups')} />
          <Switch checked={settings.public_audience_enabled === true} onChange={(v) => void setSetting('public_audience_enabled', v)}
            label={t('mod.public')} description={t('mod.publicNote')} />
          <Switch checked={settings.franking_required === true} onChange={(v) => void setSetting('franking_required', v)}
            label={t('mod.franking')} description={t('mod.frankingNote')} />
          <form className="k-row-wrap k-mod-wait" onSubmit={(e) => { e.preventDefault(); void setSetting('recovery_wait_hours', Number(wait)); }}>
            <TextField label={t('mod.wait')} hint={t('mod.waitNote')} type="number" min={0} max={168} step={1} value={wait}
              onChange={(e) => setWait(e.target.value)} dir="ltr" />
            <Button type="submit" variant="secondary">{t('mod.save')}</Button>
          </form>
        </Card>
      </section>
    </div>
  );
}
