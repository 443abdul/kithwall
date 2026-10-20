'use client';
// Settings → Security (Kithwall 2): passkeys, recovery key, trusted friends, authenticator app,
// where you're signed in, this device, lock and sign out. Logic reused from the v1 data layer
// (lib/auth/account, lib/recovery, lib/keys/session, Supabase MFA); the screens are new.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { getSession, lock, newRecoveryPhrase, confirmRecoverySaved, signOut, useSession, amk } from '@/lib/keys/session';
import { deviceStore } from '@/lib/keys/device';
import { accountApi, AccountError } from '@/lib/auth/account';
import { sb } from '@/lib/supabase';
import { people, usePeopleVersion } from '@/lib/people';
import {
  MAX_TRUSTEES, MIN_TRUSTEES, approveRecovery, incomingRecoveryRequests, myTrustees, phraseFor, removeTrustees,
  resplitToSameTrustees, rkFromPhrase, setupTrustees, trustedBy, type IncomingRequest, type ShareRow,
} from '@/lib/recovery';
import { dismissRecoveryNudge } from '@/components/onboarding/nudges';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { TextField, Textarea } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Callout';
import { Badge } from '@/components/ui/Badge';
import { Dialog } from '@/components/ui/Dialog';
import { Segmented } from '@/components/ui/Segmented';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { PersonAvatar } from '@/components/messages/look';
import { PeoplePicker } from '@/components/messages/PeoplePicker';
import { SettingsPage, Section } from './shared';
import { RecoveryPhrase } from './RecoveryPhrase';

function errText(t: (k: MessageKey) => string, e: unknown): string {
  if (e instanceof AccountError) return t(`errors.${e.code}` as MessageKey);
  return t('errors.unknown');
}

// ---------------------------------------------------------------------------------------------- passkeys

type Passkey = { id: string; label: string; createdAt: string; lastUsedAt: string | null };

function PasskeysSection({ onNeedRecovery }: { onNeedRecovery: () => void }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [list, setList] = useState<Passkey[] | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastMethod, setLastMethod] = useState(false);
  const [removing, setRemoving] = useState<Passkey | null>(null);

  const load = useCallback(async () => {
    try { setList(await accountApi.listPasskeys()); } catch (e) { setErr(errText(t, e)); }
  }, [t]);
  useEffect(() => {
    void load();
    accountApi.capabilities().then((c) => setSupported(c.passkey)).catch(() => setSupported(false));
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy('add'); setErr(null); setLastMethod(false);
    try {
      await accountApi.addPasskey(label.trim() || undefined);
      setLabel('');
      toast({ message: t('settings.passkeys.added') });
      await load();
    } catch (x) { setErr(errText(t, x)); } finally { setBusy(null); }
  }

  async function remove(p: Passkey) {
    setBusy(p.id); setErr(null); setLastMethod(false);
    try {
      await accountApi.removePasskey(p.id);
      setRemoving(null);
      toast({ message: t('settings.passkeys.removed') });
      await load();
    } catch (x) {
      setRemoving(null);
      if (x instanceof AccountError && x.code === 'last_unlock_method') setLastMethod(true);
      else setErr(errText(t, x));
    } finally { setBusy(null); }
  }

  const when = (iso: string) => f.date(new Date(iso), { dateStyle: 'medium' });
  return (
    <Section id="passkeys" title={t('settings.passkeys.title')} description={t('settings.passkeys.body')}>
      {err ? <Callout tone="danger">{err}</Callout> : null}
      {lastMethod ? (
        <Callout tone="warning">
          {t('errors.last_unlock_method')}{' '}
          <Button size="sm" variant="ghost" onClick={onNeedRecovery}>{t('settings.passkeys.saveRecovery')}</Button>
        </Callout>
      ) : null}
      {list === null ? <Skeleton height={56} /> : list.length ? (
        <ul className="k-set-items">
          {list.map((p) => (
            <li key={p.id}>
              <span className="k-item-icon k-item-lead" aria-hidden><Icon name="fingerprint" /></span>
              <span className="k-set-item-body">
                <span className="k-set-item-title">{p.label || t('settings.passkeys.unnamed')}</span>
                <span className="k-small k-muted">
                  {t('settings.passkeys.added_on', { date: when(p.createdAt) })}
                  {' · '}
                  {p.lastUsedAt ? t('settings.passkeys.used_on', { date: when(p.lastUsedAt) }) : t('settings.passkeys.never')}
                </span>
              </span>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setRemoving(p)}>{t('settings.passkeys.remove')}</Button>
            </li>
          ))}
        </ul>
      ) : <p className="k-muted">{t('settings.passkeys.none')}</p>}
      {supported === false ? <Callout>{t('errors.passkey_unsupported')}</Callout> : (
        <form className="k-stack-sm" onSubmit={(e) => void add(e)}>
          <TextField label={t('settings.passkeys.label')} hint={t('settings.passkeys.labelHint')} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
          <div><Button type="submit" variant="primary" icon="fingerprint" busy={busy === 'add'} disabled={!!busy}>{t('settings.passkeys.add')}</Button></div>
        </form>
      )}
      <Dialog open={!!removing} onClose={() => setRemoving(null)} title={t('settings.passkeys.removeTitle')} dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setRemoving(null)} disabled={!!busy}>{t('settings.cancel')}</Button>
          <Button variant="danger" busy={!!busy} onClick={() => removing && void remove(removing)}>{t('settings.passkeys.remove')}</Button></>}>
        <p className="k-muted">{t('settings.passkeys.removeBody', { name: removing?.label || t('settings.passkeys.unnamed') })}</p>
      </Dialog>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- recovery key

function RecoverySection() {
  const t = useT();
  const toast = useToast();
  const { status } = useSession();
  const [saved, setSaved] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (status !== 'ready') return;
    accountApi.accountStatus().then((s) => setSaved(s.recoverySaved)).catch(() => setSaved(null));
  }, [status]);

  async function create() {
    setConfirming(false); setBusy(true); setErr(false);
    try {
      const r = await newRecoveryPhrase();
      await resplitToSameTrustees(r.rk).catch(() => false); // trusted friends get pieces of the NEW key
      r.rk.fill(0);
      setSaved(false);
      setPhrase(r.phrase);
    } catch { setErr(true); } finally { setBusy(false); }
  }
  async function done() {
    setBusy(true);
    try {
      await confirmRecoverySaved();
      dismissRecoveryNudge();
      setSaved(true); setPhrase(null);
      toast({ message: t('settings.recovery.saved') });
    } catch { setErr(true); } finally { setBusy(false); }
  }

  return (
    <Section id="recovery-key" title={t('settings.recovery.title')} description={t('settings.recovery.body')}>
      {err ? <Callout tone="danger">{t('errors.unknown')}</Callout> : null}
      {phrase ? <RecoveryPhrase phrase={phrase} onDone={() => void done()} busy={busy} /> : (
        <>
          {saved === true ? <p><Badge tone="success">{t('settings.recovery.statusSaved')}</Badge></p>
            : saved === false ? <Callout tone="warning">{t('settings.recovery.statusMissing')}</Callout> : null}
          <div><Button variant={saved ? 'secondary' : 'primary'} icon="key" busy={busy} onClick={() => setConfirming(true)}>{saved ? t('settings.recovery.replace') : t('settings.recovery.create')}</Button></div>
        </>
      )}
      <Dialog open={confirming} onClose={() => setConfirming(false)} title={t('settings.recovery.confirmTitle')}
        footer={<><Button variant="ghost" onClick={() => setConfirming(false)}>{t('settings.cancel')}</Button>
          <Button variant="primary" onClick={() => void create()}>{t('settings.recovery.confirmCta')}</Button></>}>
        <p className="k-muted">{t('settings.recovery.confirmBody')}</p>
      </Dialog>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- trusted friends

function TrustedSection() {
  const t = useT();
  const toast = useToast();
  usePeopleVersion();
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(2);
  const [source, setSource] = useState<'phrase' | 'new'>('phrase');
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const load = useCallback(async () => { try { setRows(await myTrustees()); } catch { setErr(t('errors.unknown')); } }, [t]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (picked.length < MIN_TRUSTEES) throw new Error(t('settings.trusted.pickMin', { min: MIN_TRUSTEES }));
      const k = Math.min(Math.max(threshold, 2), picked.length);
      if (source === 'phrase') {
        let rk: Uint8Array;
        try { rk = await rkFromPhrase(words.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')); }
        catch { throw new Error(t('settings.trusted.phraseWrong')); }
        await setupTrustees(rk, picked, k);
      } else {
        const r = await newRecoveryPhrase();
        await setupTrustees(r.rk, picked, k);
        setPhrase(r.phrase);
      }
      setEditing(false); setWords('');
      toast({ message: t('settings.trusted.saved') });
      await load();
    } catch (x) { setErr((x as Error).message || t('errors.unknown')); } finally { setBusy(false); }
  }

  const k = rows?.[0]?.threshold ?? 0;
  const maxK = Math.max(2, picked.length);
  return (
    <Section id="trusted-setup" title={t('settings.trusted.title')} description={t('settings.trusted.body', { min: MIN_TRUSTEES, max: MAX_TRUSTEES })}>
      {err ? <Callout tone="danger">{err}</Callout> : null}
      {phrase ? <RecoveryPhrase phrase={phrase} onDone={() => { void confirmRecoverySaved().catch(() => undefined); setPhrase(null); }} /> : null}
      {!editing && rows === null ? <Skeleton height={48} /> : null}
      {!editing && rows && rows.length ? (
        <>
          <p>{t('settings.trusted.current', { count: k })}</p>
          <ul className="k-set-items">
            {rows.map((r) => (
              <li key={r.trustee_id}><PersonAvatar id={r.trustee_id} size={36} /><span className="k-set-item-body"><span className="k-set-item-title">{people.person(r.trustee_id)?.name ?? '…'}</span></span></li>
            ))}
          </ul>
          <div className="k-row-wrap">
            <Button variant="secondary" onClick={() => { setPicked(rows.map((r) => r.trustee_id)); setThreshold(k || 2); setEditing(true); }}>{t('settings.trusted.change')}</Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(true)}>{t('settings.trusted.removeAll')}</Button>
          </div>
        </>
      ) : null}
      {!editing && rows && !rows.length ? <div><Button variant="primary" icon="users" onClick={() => { setPicked([]); setThreshold(2); setEditing(true); }}>{t('settings.trusted.choose')}</Button></div> : null}
      {editing ? (
        <div className="k-stack">
          <p className="k-small"><b>{t('settings.trusted.step1', { min: MIN_TRUSTEES, max: MAX_TRUSTEES })}</b> {t('settings.trusted.chosen', { count: picked.length })}</p>
          <PeoplePicker selected={picked} max={MAX_TRUSTEES} onToggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))} />
          <p className="k-small"><b>{t('settings.trusted.step2')}</b></p>
          <Segmented label={t('settings.trusted.step2')} value={String(Math.min(threshold, maxK))}
            onChange={(v) => setThreshold(Number(v))}
            options={Array.from({ length: Math.max(1, maxK - 1) }, (_, i) => ({ value: String(i + 2), label: String(i + 2) }))} />
          <p className="k-small"><b>{t('settings.trusted.step3')}</b></p>
          <Segmented label={t('settings.trusted.step3')} value={source} onChange={setSource}
            options={[{ value: 'phrase', label: t('settings.trusted.havePhrase') }, { value: 'new', label: t('settings.trusted.newPhrase') }]} />
          {source === 'phrase'
            ? <Textarea label={t('settings.trusted.phraseLabel')} value={words} rows={3} dir="ltr" autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(e) => setWords(e.target.value)} />
            : <Callout tone="warning">{t('settings.trusted.newPhraseNote')}</Callout>}
          <div className="k-row-wrap">
            <Button variant="primary" busy={busy} onClick={() => void save()}>{t('settings.trusted.save')}</Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>{t('settings.cancel')}</Button>
          </div>
        </div>
      ) : null}
      <Dialog open={confirmRemove} onClose={() => setConfirmRemove(false)} title={t('settings.trusted.removeTitle')}
        footer={<><Button variant="ghost" onClick={() => setConfirmRemove(false)}>{t('settings.cancel')}</Button>
          <Button variant="danger" onClick={() => { setConfirmRemove(false); void removeTrustees().then(load).catch(() => setErr(t('errors.unknown'))); }}>{t('settings.trusted.removeAll')}</Button></>}>
        <p className="k-muted">{t('settings.trusted.removeBody')}</p>
      </Dialog>
    </Section>
  );
}

function TrusteeSection() {
  const t = useT();
  const f = useFormat();
  usePeopleVersion();
  const [reqs, setReqs] = useState<IncomingRequest[] | null>(null);
  const [owners, setOwners] = useState<string[]>([]);
  const [approving, setApproving] = useState<IncomingRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async () => {
    try { const [r, o] = await Promise.all([incomingRecoveryRequests(), trustedBy()]); setReqs(r); setOwners(o); } catch { setErr(true); }
  }, []);
  useEffect(() => { void load(); const h = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(h); }, [load]);
  async function approve() {
    if (!approving) return;
    setBusy(true); setErr(false);
    try { await approveRecovery(approving); setApproving(null); await load(); } catch { setErr(true); } finally { setBusy(false); }
  }
  const nameOf = (id: string) => people.person(id)?.name ?? t('messages.someone');
  return (
    <Section id="trusted" title={t('settings.trustee.title')}>
      {err ? <Callout tone="danger">{t('errors.unknown')}</Callout> : null}
      {reqs === null ? <Skeleton height={40} /> : null}
      {reqs !== null && !owners.length ? <p className="k-muted">{t('settings.trustee.none')}</p> : null}
      {owners.length ? <p>{t('settings.trustee.for', { names: f.list(owners.map(nameOf)) })}</p> : null}
      {(reqs ?? []).map((r) => {
        const name = nameOf(r.owner_id);
        const open = now >= new Date(r.not_before).getTime();
        return (
          <Callout key={r.id} tone="warning">
            <div className="k-stack-sm">
              <b>{t('settings.trustee.asking', { name })}</b>
              {r.responded ? <span>{t('settings.trustee.helped')}</span> : (
                <>
                  <span>{t('settings.trustee.callFirst', { name })}</span>
                  <div className="k-set-six" translate="no">{phraseFor(r).join(' ')}</div>
                  <span>{t('settings.trustee.mismatch')}</span>
                  {open ? <div><Button variant="primary" size="sm" onClick={() => setApproving(r)}>{t('settings.trustee.help', { name })}</Button></div>
                    : <span className="k-small">{t('settings.trustee.wait', { time: f.date(new Date(r.not_before), { dateStyle: 'medium', timeStyle: 'short' }) })}</span>}
                </>
              )}
            </div>
          </Callout>
        );
      })}
      <Dialog open={!!approving} onClose={() => setApproving(null)} title={t('settings.trustee.confirmTitle')} dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setApproving(null)} disabled={busy}>{t('settings.cancel')}</Button>
          <Button variant="primary" busy={busy} onClick={() => void approve()}>{t('settings.trustee.confirmCta')}</Button></>}>
        <p className="k-muted">{t('settings.trustee.confirmBody', { name: approving ? nameOf(approving.owner_id) : '' })}</p>
      </Dialog>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- authenticator app

interface Factor { id: string; friendly_name?: string; factor_type: string; status: string; created_at: string }

function MfaSection() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [off, setOff] = useState<Factor | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await sb().auth.mfa.listFactors();
    if (error) { setErr(t('errors.unknown')); return; }
    setFactors(data.all as Factor[]);
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  async function start() {
    setBusy(true); setErr(null);
    try {
      for (const x of factors ?? []) if (x.status !== 'verified') await sb().auth.mfa.unenroll({ factorId: x.id });
      const { data, error } = await sb().auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
      if (error) throw error;
      const qr = data.totp.qr_code.startsWith('data:') ? data.totp.qr_code : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.totp.qr_code)}`;
      setEnroll({ id: data.id, qr, secret: data.totp.secret });
    } catch { setErr(t('errors.unknown')); } finally { setBusy(false); }
  }
  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!enroll) return;
    setBusy(true); setErr(null);
    try {
      const v = await sb().auth.mfa.challengeAndVerify({ factorId: enroll.id, code: code.replace(/\s+/g, '') });
      if (v.error) { setErr(t('signin.mfaWrong')); return; }
      setEnroll(null); setCode('');
      toast({ message: t('settings.mfa.on') });
      await load();
    } finally { setBusy(false); }
  }
  async function turnOff(x: Factor) {
    setBusy(true); setErr(null); setOff(null);
    try {
      const { error } = await sb().auth.mfa.unenroll({ factorId: x.id });
      if (error) throw error;
      await sb().auth.refreshSession();
      toast({ message: t('settings.mfa.offDone') });
      await load();
    } catch { setErr(t('errors.unknown')); } finally { setBusy(false); }
  }

  const verified = (factors ?? []).filter((x) => x.status === 'verified');
  return (
    <Section id="mfa" title={t('settings.mfa.title')} description={t('settings.mfa.body')}>
      {err ? <Callout tone="danger">{err}</Callout> : null}
      {factors === null ? <Skeleton height={40} /> : enroll ? (
        <form className="k-stack" onSubmit={(e) => void verify(e)}>
          <p>{t('settings.mfa.scan')}</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="k-set-qr" src={enroll.qr} alt={t('settings.mfa.qrAlt')} />
          <p className="k-small k-muted">{t('settings.mfa.manual')}</p>
          <code className="k-set-code">{enroll.secret}</code>
          <TextField label={t('signin.mfaCode')} inputMode="numeric" autoComplete="one-time-code" maxLength={7} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} />
          <div className="k-row-wrap">
            <Button type="submit" variant="primary" busy={busy} disabled={code.replace(/\s+/g, '').length < 6}>{t('settings.mfa.turnOn')}</Button>
            <Button variant="ghost" onClick={() => { void sb().auth.mfa.unenroll({ factorId: enroll.id }); setEnroll(null); }}>{t('settings.cancel')}</Button>
          </div>
        </form>
      ) : verified.length ? (
        <>
          <p><Badge tone="success">{t('settings.mfa.statusOn')}</Badge></p>
          <ul className="k-set-items">
            {verified.map((x) => (
              <li key={x.id}>
                <span className="k-set-item-body"><span className="k-set-item-title">{t('settings.mfa.app')}</span>
                  <span className="k-small k-muted">{t('settings.passkeys.added_on', { date: f.date(new Date(x.created_at), { dateStyle: 'medium' }) })}</span></span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOff(x)}>{t('settings.mfa.turnOff')}</Button>
              </li>
            ))}
          </ul>
        </>
      ) : <div><Button variant="secondary" busy={busy} onClick={() => void start()}>{t('settings.mfa.setUp')}</Button></div>}
      <Dialog open={!!off} onClose={() => setOff(null)} title={t('settings.mfa.offTitle')}
        footer={<><Button variant="ghost" onClick={() => setOff(null)}>{t('settings.cancel')}</Button>
          <Button variant="danger" onClick={() => off && void turnOff(off)}>{t('settings.mfa.turnOff')}</Button></>}>
        <p className="k-muted">{t('settings.mfa.offBody')}</p>
      </Dialog>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- sessions + device

interface SessionRow { id: string; created_at: string; last_active: string; aal: string; user_agent: string | null; is_current: boolean }

function describeAgent(ua: string | null, unknown: string): string {
  if (!ua) return unknown;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : unknown;
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

function SessionsSection() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('my_sessions');
    if (error) setErr(true); else setRows(data as SessionRow[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function revoke(id: string) {
    const { error } = await sb().rpc('revoke_my_session', { session: id });
    if (error) toast({ message: t('errors.unknown'), tone: 'danger' }); else { toast({ message: t('settings.sessions.revoked') }); await load(); }
  }
  async function others() {
    const { error } = await sb().auth.signOut({ scope: 'others' });
    if (error) toast({ message: t('errors.unknown'), tone: 'danger' }); else { toast({ message: t('settings.sessions.othersDone') }); await load(); }
  }
  return (
    <Section id="sessions" title={t('settings.sessions.title')} description={t('settings.sessions.body')}>
      {err ? <Callout tone="danger">{t('errors.unknown')}</Callout> : null}
      {rows === null && !err ? <Skeleton height={56} /> : null}
      {rows?.length ? (
        <ul className="k-set-items">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="k-set-item-body">
                <span className="k-set-item-title">{describeAgent(r.user_agent, t('settings.sessions.unknown'))} {r.is_current ? <Badge tone="success">{t('settings.sessions.this')}</Badge> : null}</span>
                <span className="k-small k-muted">{t('settings.sessions.active', { date: f.date(new Date(r.last_active), { dateStyle: 'medium', timeStyle: 'short' }) })}</span>
              </span>
              {r.is_current ? null : <Button size="sm" variant="ghost" onClick={() => void revoke(r.id)}>{t('settings.sessions.signOut')}</Button>}
            </li>
          ))}
        </ul>
      ) : null}
      <div><Button variant="secondary" onClick={() => void others()}>{t('settings.sessions.others')}</Button></div>
    </Section>
  );
}

function DeviceSection() {
  const t = useT();
  const toast = useToast();
  const { userId } = useSession();
  const [remembered, setRemembered] = useState<boolean | null>(null);
  useEffect(() => { if (userId) void deviceStore.load(userId).then((v) => { setRemembered(!!v); v?.fill(0); }).catch(() => setRemembered(false)); }, [userId]);
  async function forget() { await deviceStore.clear(); setRemembered(false); toast({ message: t('settings.device.forgotten') }); }
  async function remember() { if (!userId) return; await deviceStore.save(userId, amk()); setRemembered(true); toast({ message: t('settings.device.remembered') }); }
  return (
    <Section id="device" title={t('settings.device.title')} description={remembered ? t('settings.device.rememberedBody') : t('settings.device.askBody')}>
      <div className="k-row-wrap">
        {remembered ? <Button variant="secondary" onClick={() => void forget()}>{t('settings.device.forget')}</Button>
          : remembered === false ? <Button variant="secondary" onClick={() => void remember()}>{t('settings.device.remember')}</Button> : null}
        <Button variant="secondary" icon="lock" onClick={() => { if (getSession().status === 'ready') void lock(); }}>{t('settings.device.lock')}</Button>
        <Button variant="ghost" icon="logout" onClick={() => void signOut().then(() => { location.href = '/'; })}>{t('you.signOut')}</Button>
      </div>
    </Section>
  );
}

export function SecuritySettings() {
  const t = useT();
  const toRecovery = () => document.getElementById('recovery-key')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <SettingsPage title={t('settings.security.title')} description={t('settings.security.description')}>
      <PasskeysSection onNeedRecovery={toRecovery} />
      <RecoverySection />
      <TrustedSection />
      <TrusteeSection />
      <MfaSection />
      <SessionsSection />
      <DeviceSection />
    </SettingsPage>
  );
}
