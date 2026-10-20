'use client';
// Safety centre → Devices and sessions: where this account is signed in (coarse "last active"), the
// devices that get push notifications, and the passkeys. Sign out one session, or every other one.
import { useCallback, useEffect, useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { sb } from '@/lib/supabase';
import { useSession } from '@/lib/keys/session';
import { accountApi } from '@/lib/auth/account';
import { currentSubscription } from '@/lib/push';
import { Section } from '@/components/settings/shared';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Badge } from '@/components/ui/Badge';
import { Dialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/Skeleton';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { SafetyPage } from './SafetyCentre';

interface SessionRow { id: string; created_at: string; last_active: string; aal: string; user_agent: string | null; is_current: boolean }
interface PushRow { id: string; endpoint: string; user_agent: string | null; created_at: string }

/** "Active now / today / this week / this month / a while ago": deliberately coarse. */
export function coarseSeen(iso: string | null, now = Date.now()): MessageKey {
  if (!iso) return 'safety.devices.seenLongAgo';
  const d = now - new Date(iso).getTime();
  if (d < 15 * 60_000) return 'safety.devices.seenNow';
  if (d < 24 * 3600_000) return 'safety.devices.seenToday';
  if (d < 7 * 86_400_000) return 'safety.devices.seenWeek';
  if (d < 31 * 86_400_000) return 'safety.devices.seenMonth';
  return 'safety.devices.seenLongAgo';
}

function describeAgent(ua: string | null, unknown: string): string {
  if (!ua) return unknown;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : unknown;
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

function SessionsList() {
  const t = useT();
  const toast = useToast();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('my_sessions');
    if (error) setErr(true); else setRows(data as SessionRow[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function revoke(id: string) {
    setBusy(id);
    const { error } = await sb().rpc('revoke_my_session', { session: id });
    setBusy(null);
    if (error) toast({ message: t('errors.unknown'), tone: 'danger' }); else { toast({ message: t('safety.devices.signedOutOne') }); await load(); }
  }
  async function others() {
    setBusy('others');
    const { error } = await sb().auth.signOut({ scope: 'others' });
    setBusy(null); setConfirm(false);
    if (error) toast({ message: t('errors.unknown'), tone: 'danger' }); else { toast({ message: t('safety.devices.signedOutOthers') }); await load(); }
  }
  const otherCount = rows?.filter((r) => !r.is_current).length ?? 0;
  return (
    <Section id="sessions" title={t('safety.devices.sessions')} description={t('safety.devices.sessionsBody')}>
      {err ? <Callout tone="danger">{t('errors.unknown')}</Callout> : null}
      {rows === null && !err ? <Skeleton height={56} /> : null}
      {rows?.length ? (
        <ul className="k-set-items">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="k-safety-devico" aria-hidden><Icon name={/Android|iPhone|iPad/.test(r.user_agent ?? '') ? 'phone' : 'monitor'} /></span>
              <span className="k-set-item-body">
                <span className="k-set-item-title">{describeAgent(r.user_agent, t('safety.devices.unknown'))} {r.is_current ? <Badge tone="success">{t('safety.devices.thisDevice')}</Badge> : null}</span>
                <span className="k-small k-muted">{t(coarseSeen(r.last_active))}</span>
              </span>
              {r.is_current ? null : <Button size="sm" variant="ghost" busy={busy === r.id} onClick={() => void revoke(r.id)}>{t('safety.devices.signOut')}</Button>}
            </li>
          ))}
        </ul>
      ) : null}
      <div><Button variant="danger" icon="logout" disabled={!otherCount} onClick={() => setConfirm(true)}>{t('safety.devices.signOutOthers')}</Button></div>
      <p className="k-hint">{t('safety.devices.tokenNote')}</p>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={t('safety.devices.signOutOthers')}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(false)}>{t('safety.cancel')}</Button>
          <Button variant="danger" busy={busy === 'others'} onClick={() => void others()}>{t('safety.devices.signOutOthers')}</Button>
        </>}>
        <p>{t('safety.devices.othersBody', { count: otherCount })}</p>
      </Dialog>
    </Section>
  );
}

function PushDevices() {
  const t = useT();
  const toast = useToast();
  const { userId } = useSession();
  const [rows, setRows] = useState<PushRow[] | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data } = await sb().from('push_subscriptions').select('id, endpoint, user_agent, created_at').order('created_at', { ascending: false });
    setRows((data ?? []) as PushRow[]);
    setMine((await currentSubscription().catch(() => null))?.endpoint ?? null);
  }, []);
  useEffect(() => { if (userId) void load(); }, [userId, load]);
  async function remove(id: string) {
    const { error } = await sb().from('push_subscriptions').delete().eq('id', id);
    if (error) toast({ message: t('errors.unknown'), tone: 'danger' }); else { toast({ message: t('safety.devices.pushRemoved') }); await load(); }
  }
  return (
    <Section id="push-devices" title={t('safety.devices.push')} description={t('safety.devices.pushBody')}>
      {rows === null ? <Skeleton height={48} /> : rows.length ? (
        <ul className="k-set-items">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="k-safety-devico" aria-hidden><Icon name="activity" /></span>
              <span className="k-set-item-body">
                <span className="k-set-item-title">{r.user_agent || t('safety.devices.unknown')} {r.endpoint === mine ? <Badge tone="success">{t('safety.devices.thisDevice')}</Badge> : null}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void remove(r.id)}>{t('safety.devices.stopPush')}</Button>
            </li>
          ))}
        </ul>
      ) : <p className="k-muted k-small">{t('safety.devices.noPush')}</p>}
    </Section>
  );
}

function Passkeys() {
  const t = useT();
  const [list, setList] = useState<{ id: string; label: string; lastUsedAt: string | null }[] | null>(null);
  useEffect(() => { accountApi.listPasskeys().then(setList).catch(() => setList([])); }, []);
  return (
    <Section id="passkeys" title={t('safety.devices.passkeys')} description={t('safety.devices.passkeysBody')}>
      {list === null ? <Skeleton height={48} /> : list.length ? (
        <ul className="k-set-items">
          {list.map((p) => (
            <li key={p.id}>
              <span className="k-safety-devico" aria-hidden><Icon name="fingerprint" /></span>
              <span className="k-set-item-body">
                <span className="k-set-item-title">{p.label}</span>
                <span className="k-small k-muted">{t(coarseSeen(p.lastUsedAt))}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="k-muted k-small">{t('safety.devices.noPasskeys')}</p>}
      <div><ButtonLink href="/you/settings/security" variant="secondary" size="sm">{t('safety.devices.managePasskeys')}</ButtonLink></div>
    </Section>
  );
}

export function Devices() {
  const t = useT();
  return (
    <SafetyPage title={t('safety.devices.title')} description={t('safety.devices.pageBody')}>
      <SessionsList />
      <PushDevices />
      <Passkeys />
    </SafetyPage>
  );
}
