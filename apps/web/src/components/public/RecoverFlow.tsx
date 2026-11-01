'use client';
// Account recovery (/recover). Starts from the @handle (accounts have no email): recovery key (24 words) or trusted friends, then a new
// passkey or passphrase. Logic in lib/auth/recover-client.ts; design in docs/v2/01-accounts.md §3.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Unlocked } from '@kithwall/crypto';
import { useFormat, useT } from '@/i18n';
import { accountApi } from '@/lib/auth/account';
import { finishMfaLogin } from '@/lib/auth/login';
import { confirmRecoverySaved } from '@/lib/keys/session';
import {
  afterFriendsRecovery, cancelFriends, findAccount, finishRecovery, forgetPending, friendsStatus, hasEphHere, openWithPhrase,
  pendingRecovery, rebuildFromFriends, setNewPassphrase, sixWords, startFriends, type RecoveryTarget,
} from '@/lib/auth/recover-client';
import { cleanPhrase, type FriendsStatusRes } from '@/lib/auth/recovery-shared';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { TextField, Textarea } from '@/components/ui/Field';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { AuthFrame } from '@/components/onboarding/PublicChrome';
import { PassphraseField, passphraseOk } from '@/components/onboarding/PassphraseField';
import { accountErrorMessage, errorCode } from '@/components/onboarding/errors';
import { normalizeHandle } from '@/components/onboarding/JoinFlow';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { RecoveryPhrase } from '@/components/settings/RecoveryPhrase';

type Step = 'who' | 'method' | 'phrase' | 'friends' | 'mfa' | 'secure' | 'newKey' | 'done';

export function RecoverFlow() {
  const t = useT();
  const router = useRouter();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<Step>('who');
  const [handle, setHandle] = useState('');
  const [target, setTarget] = useState<RecoveryTarget | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [viaFriends, setViaFriends] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useDocumentTitle(t('recover.docTitle'));

  useEffect(() => { headingRef.current?.focus(); }, [step]);

  // A trusted-friend request started earlier in this browser: offer to pick it up again.
  const [pending, setPending] = useState<ReturnType<typeof pendingRecovery>>(null);
  useEffect(() => { setPending(pendingRecovery()); }, []);

  const go = (s: Step) => { setErr(null); setStep(s); };
  const fail = (e: unknown) => setErr(accountErrorMessage(t, e));

  async function onWho(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { setTarget(await findAccount(handle)); go('method'); } catch (x) { fail(x); } finally { setBusy(false); }
  }

  async function resume() {
    if (!pending) return;
    setBusy(true); setErr(null);
    try {
      setHandle(pending.handle);
      setTarget(await findAccount(pending.handle));
      setRequestId(pending.requestId);
      go('friends');
    } catch (x) { fail(x); } finally { setBusy(false); }
  }

  /** Keys are open on this device: sign in, then choose a new way in. */
  async function signInWith(unlock: (fresh: RecoveryTarget) => Promise<Unlocked>, reqId?: string) {
    // A fresh nonce: the one from the first step may be older than its 5 minutes.
    const fresh = await findAccount(target?.handle ?? handle);
    setTarget(fresh);
    const u = await unlock(fresh);
    const outcome = await finishRecovery(fresh, u, reqId);
    go(outcome === 'mfa' ? 'mfa' : 'secure');
  }

  const step1 = (
    <>
      <Heading id={headingId} ref={headingRef} icon="key">{t('recover.title')}</Heading>
      <p className="k-muted">{t('recover.body')}</p>
      {pending && step === 'who' ? (
        <Callout tone="accent" icon="users">
          <span>{t('recover.resume', { handle: pending.handle })}</span>{' '}
          <span className="k-row-wrap">
            <Button size="sm" variant="primary" busy={busy} onClick={() => void resume()}>{t('recover.resumeCta')}</Button>
            <Button size="sm" variant="ghost" onClick={() => { forgetPending(); setPending(null); }}>{t('recover.resumeForget')}</Button>
          </span>
        </Callout>
      ) : null}
      <form className="k-stack" onSubmit={onWho} noValidate>
        <TextField label={t('join.handleLabel')} prefix="@" value={handle} onChange={(e) => setHandle(e.target.value)}
          autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} dir="ltr" required
          hint={t('recover.handleHint')} />
        {err ? <Callout tone="danger">{err}</Callout> : null}
        <div className="k-flow-actions k-flow-actions-stack">
          <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={!normalizeHandle(handle)}>{t('common.continue')}</Button>
        </div>
      </form>
      <p className="k-center k-small k-muted">{t('recover.remembered')} <Link href="/signin">{t('landing.signIn')}</Link> · <Link href="/help#recovery">{t('recover.howItWorks')}</Link></p>
    </>
  );

  let body: ReactNode = step1;

  if (step === 'method' && target) {
    body = (
      <>
        <Heading id={headingId} ref={headingRef} icon="key">{t('recover.methodTitle', { handle: target.handle })}</Heading>
        <p className="k-muted">{t('recover.methodBody')}</p>
        <div className="k-stack">
          <Choice icon="key" title={t('recover.phraseChoice')} body={t('recover.phraseChoiceBody')} onClick={() => go('phrase')} />
          <Choice icon="users" title={t('recover.friendsChoice')}
            body={target.trusted ? t('recover.friendsChoiceBody', { count: target.trusted.count, threshold: target.trusted.threshold }) : t('recover.friendsNone')}
            disabled={!target.trusted} onClick={() => { setRequestId(null); go('friends'); }} />
        </div>
        <div className="k-flow-actions"><Button variant="ghost" icon="back" onClick={() => go('who')}>{t('common.back')}</Button></div>
      </>
    );
  }

  if (step === 'phrase' && target) body = (
    <PhraseStep headingId={headingId} headingRef={headingRef} busy={busy} err={err} onBack={() => go('method')}
      onSubmit={(raw) => {
        setBusy(true); setErr(null);
        signInWith(async (fresh) => openWithPhrase(fresh, raw)).catch(fail).finally(() => setBusy(false));
      }} />
  );

  if (step === 'friends' && target) body = (
    <FriendsStep headingId={headingId} headingRef={headingRef} target={target} requestId={requestId} onRequest={setRequestId}
      onBack={() => go('method')} onFinish={async (st) => {
        if (!requestId) return;
        setViaFriends(true);
        await signInWith((fresh) => rebuildFromFriends(fresh, requestId, st), requestId);
      }} />
  );

  if (step === 'mfa') body = (
    <MfaStep headingId={headingId} headingRef={headingRef} onDone={() => go('secure')} />
  );

  if (step === 'secure') body = (
    <SecureStep headingId={headingId} headingRef={headingRef} handle={target?.handle ?? handle} onDone={async () => {
      if (viaFriends && requestId) {
        try { const r = await afterFriendsRecovery(requestId); setNewKey(r.phrase); go('newKey'); return; } catch (x) { console.warn('new recovery key', x); }
      }
      go('done');
    }} />
  );

  if (step === 'newKey' && newKey) body = (
    <>
      <Heading id={headingId} ref={headingRef} icon="key">{t('recover.newKeyTitle')}</Heading>
      <p className="k-muted">{t('recover.newKeyBody')}</p>
      <RecoveryPhrase phrase={newKey} busy={busy} onDone={() => {
        setBusy(true);
        void confirmRecoverySaved().catch(() => undefined).finally(() => { setBusy(false); setNewKey(null); go('done'); });
      }} />
    </>
  );

  if (step === 'done') body = (
    <>
      <div className="k-passkey-art k-celebrate" aria-hidden><Icon name="sparkle" /></div>
      <Heading id={headingId} ref={headingRef}>{t('recover.doneTitle')}</Heading>
      <p className="k-muted">{t('recover.doneBody')}</p>
      <div className="k-flow-actions k-flow-actions-stack">
        <Button variant="primary" size="lg" block iconEnd="forward" onClick={() => router.replace('/home')}>{t('join.goHome')}</Button>
        <Button variant="ghost" onClick={() => router.push('/you/settings/security')}>{t('settings.security.title')}</Button>
      </div>
    </>
  );

  return (
    <AuthFrame cta={step === 'done' || step === 'secure' || step === 'newKey' ? 'none' : 'signin'}>
      <div className="k-flow">
        <section className="k-flow-step" aria-labelledby={headingId}>{body}</section>
      </div>
    </AuthFrame>
  );
}

// ------------------------------------------------------------------------------------------------ bits

function Heading({ id, ref, icon, children }: { id: string; ref: React.Ref<HTMLHeadingElement>; icon?: IconName; children: ReactNode }) {
  return (
    <>
      {icon ? <div className="k-passkey-art" aria-hidden><Icon name={icon} /></div> : null}
      <h1 id={id} ref={ref} tabIndex={-1}>{children}</h1>
    </>
  );
}

function Choice({ icon, title, body, onClick, disabled }: { icon: IconName; title: string; body: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="k-choice" onClick={onClick} disabled={disabled}>
      <span className="k-choice-ico" aria-hidden><Icon name={icon} /></span>
      <span className="k-choice-text"><strong>{title}</strong><span className="k-small k-muted">{body}</span></span>
      <Icon name="forward" />
    </button>
  );
}

interface StepProps { headingId: string; headingRef: React.Ref<HTMLHeadingElement> }

function PhraseStep({ headingId, headingRef, busy, err, onSubmit, onBack }: StepProps & { busy: boolean; err: string | null; onSubmit: (raw: string) => void; onBack: () => void }) {
  const t = useT();
  const [raw, setRaw] = useState('');
  const n = cleanPhrase(raw).words;
  return (
    <>
      <Heading id={headingId} ref={headingRef} icon="key">{t('recover.phraseTitle')}</Heading>
      <p className="k-muted">{t('recover.phraseBody')}</p>
      <form className="k-stack" onSubmit={(e) => { e.preventDefault(); if (n === 24) onSubmit(raw); }} noValidate>
        <Textarea label={t('recover.phraseLabel')} value={raw} onChange={(e) => setRaw(e.target.value)} rows={5} dir="ltr"
          autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} translate="no"
          hint={t('recover.phraseCount', { count: n })} />
        {err ? <Callout tone="danger">{err}</Callout> : null}
        <div className="k-flow-actions k-flow-actions-stack">
          <Button type="submit" variant="primary" size="lg" block busy={busy} busyLabel={t('recover.unlocking')} disabled={n !== 24}>{t('recover.phraseCta')}</Button>
          <Button variant="ghost" icon="back" onClick={onBack}>{t('common.back')}</Button>
        </div>
      </form>
    </>
  );
}

function FriendsStep({ headingId, headingRef, target, requestId, onRequest, onBack, onFinish }: StepProps & {
  target: RecoveryTarget; requestId: string | null; onRequest: (id: string | null) => void; onBack: () => void;
  onFinish: (st: FriendsStatusRes) => Promise<void>;
}) {
  const t = useT();
  const f = useFormat();
  const [st, setSt] = useState<FriendsStatusRes | null>(null);
  const [here, setHere] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!requestId) return;
    try {
      const s = await friendsStatus(requestId);
      setSt(s);
      setHere(await hasEphHere(target.userId, requestId));
      if (s.status !== 'pending') { forgetPending(); }
    } catch (x) { setErr(accountErrorMessage(t, x)); }
  }, [requestId, target.userId, t]);

  useEffect(() => {
    if (!requestId) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 15_000);
    return () => clearInterval(timer);
  }, [requestId, refresh]);

  async function start() {
    setBusy(true); setErr(null);
    try { const r = await startFriends(target); onRequest(r.requestId); } catch (x) { setErr(accountErrorMessage(t, x)); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!requestId) return;
    setBusy(true); setErr(null);
    try { await cancelFriends(requestId); onRequest(null); setSt(null); } catch (x) { setErr(accountErrorMessage(t, x)); } finally { setBusy(false); }
  }
  async function finish() {
    if (!st) return;
    setBusy(true); setErr(null);
    try { await onFinish(st); } catch (x) { setErr(accountErrorMessage(t, x)); } finally { setBusy(false); }
  }

  if (!requestId) {
    return (
      <>
        <Heading id={headingId} ref={headingRef} icon="users">{t('recover.friendsTitle')}</Heading>
        <p className="k-muted">{t('recover.friendsIntro', { threshold: target.trusted?.threshold ?? 2, count: target.trusted?.count ?? 3 })}</p>
        <ol className="k-recover-steps">
          <li>{t('recover.friendsStep1')}</li>
          <li>{t('recover.friendsStep2')}</li>
          <li>{t('recover.friendsStep3')}</li>
        </ol>
        {err ? <Callout tone="danger">{err}</Callout> : null}
        <div className="k-flow-actions k-flow-actions-stack">
          <Button variant="primary" size="lg" block busy={busy} onClick={() => void start()}>{t('recover.friendsStart')}</Button>
          <Button variant="ghost" icon="back" onClick={onBack}>{t('common.back')}</Button>
        </div>
      </>
    );
  }

  const waiting = st ? new Date(st.notBefore).getTime() > Date.now() : true;
  const enough = !!st && st.threshold > 0 && st.responses.length >= st.threshold;
  return (
    <>
      <Heading id={headingId} ref={headingRef} icon="users">{t('recover.friendsWaitingTitle')}</Heading>
      {!st ? <div className="k-center"><Spinner /></div> : st.status !== 'pending' ? (
        <Callout tone="warning">{st.status === 'cancelled' ? t('recover.friendsCancelled') : t('recover.friendsClosed')}</Callout>
      ) : (
        <>
          <Card tone="accent" className="k-stack">
            <h2 className="k-section-title">{t('recover.wordsTitle')}</h2>
            <p className="k-words6" translate="no" dir="ltr" aria-label={t('recover.wordsTitle')}>{sixWords(requestId, st.ephPub).join(' ')}</p>
            <p className="k-small k-muted">{t('recover.wordsBody')}</p>
          </Card>
          <ul role="list" className="k-checks">
            <li><Icon name="clock" /> {waiting ? t('recover.waitUntil', { time: f.date(new Date(st.notBefore), { dateStyle: 'medium', timeStyle: 'short' }) }) : t('recover.canRespond')}</li>
            <li><Icon name="users" /> {t('recover.responses', { count: st.responses.length, threshold: st.threshold })}</li>
            <li><Icon name="calendar" /> {t('recover.expires', { time: f.date(new Date(st.expiresAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</li>
          </ul>
          {!here ? <Callout tone="warning">{t('recover.otherDevice')}</Callout> : null}
          <p className="k-small k-muted">{t('recover.comeBack')}</p>
        </>
      )}
      {err ? <Callout tone="danger">{err}</Callout> : null}
      <div className="k-flow-actions k-flow-actions-stack">
        {enough && here && st?.status === 'pending' ? (
          <Button variant="primary" size="lg" block busy={busy} busyLabel={t('recover.unlocking')} onClick={() => void finish()}>{t('recover.friendsFinish')}</Button>
        ) : null}
        {st?.status === 'pending' ? <Button variant="secondary" icon="refresh" onClick={() => void refresh()}>{t('recover.checkNow')}</Button> : null}
        {st?.status === 'pending' ? <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>{t('recover.friendsCancel')}</Button>
          : <Button variant="ghost" icon="back" onClick={() => { forgetPending(); onRequest(null); setSt(null); }}>{t('common.back')}</Button>}
      </div>
    </>
  );
}

function MfaStep({ headingId, headingRef, onDone }: StepProps & { onDone: () => void }) {
  const t = useT();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    finishMfaLogin(code)
      .then((s) => { if (s === 'ready') onDone(); else setErr(t('signin.mfaFailed')); })
      .catch(() => setErr(t('signin.mfaWrong')))
      .finally(() => setBusy(false));
  }
  return (
    <>
      <Heading id={headingId} ref={headingRef} icon="shield">{t('signin.mfaTitle')}</Heading>
      <p className="k-muted">{t('signin.mfaBody')}</p>
      <form className="k-stack" onSubmit={submit}>
        <TextField label={t('signin.mfaCode')} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric"
          autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} dir="ltr" required />
        {err ? <Callout tone="danger">{err}</Callout> : null}
        <Button type="submit" variant="primary" size="lg" block busy={busy}>{t('common.continue')}</Button>
      </form>
    </>
  );
}

function SecureStep({ headingId, headingRef, handle, onDone }: StepProps & { handle: string; onDone: () => Promise<void> }) {
  const t = useT();
  const [canPasskey, setCanPasskey] = useState<boolean | null>(null);
  const [phrase, setPhrase] = useState('');
  const [phrase2, setPhrase2] = useState('');
  const [busy, setBusy] = useState<'passkey' | 'phrase' | 'skip' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    accountApi.capabilities().then((c) => setCanPasskey(c.passkey && c.prf !== false)).catch(() => setCanPasskey(false));
  }, []);

  async function run(kind: 'passkey' | 'phrase' | 'skip', fn: () => Promise<void>) {
    setBusy(kind); setErr(null);
    try { await fn(); await onDone(); } catch (x) {
      const code = errorCode(x);
      if (code === 'passkey_unsupported' || code === 'passkey_not_linked' || code === 'prf_unsupported') setCanPasskey(false);
      setErr(accountErrorMessage(t, x));
    } finally { setBusy(null); }
  }
  async function onPhrase(e: FormEvent) {
    e.preventDefault();
    if (phrase !== phrase2) { setErr(t('passphrase.mismatch')); return; }
    if (!(await passphraseOk(phrase, [handle]))) { setErr(t('errors.weak_passphrase')); return; }
    void run('phrase', () => setNewPassphrase(phrase));
  }

  return (
    <>
      <Heading id={headingId} ref={headingRef} icon="shield">{t('recover.secureTitle')}</Heading>
      <p className="k-muted">{t('recover.secureBody')}</p>
      {canPasskey ? (
        <div className="k-flow-actions k-flow-actions-stack">
          <Button variant="primary" size="lg" block icon="fingerprint" busy={busy === 'passkey'} onClick={() => void run('passkey', () => accountApi.addPasskey())}>{t('recover.securePasskey')}</Button>
        </div>
      ) : null}
      {canPasskey ? <div className="k-divider"><span>{t('recover.secureOr')}</span></div> : null}
      <form className="k-stack" onSubmit={(e) => void onPhrase(e)} noValidate>
        <PassphraseField label={t('recover.newPhrase')} value={phrase} onValue={setPhrase} meter userInputs={[handle]} autoComplete="new-password" />
        <PassphraseField label={t('join.phraseConfirm')} value={phrase2} onValue={setPhrase2} autoComplete="new-password" />
        {err ? <Callout tone="danger">{err}</Callout> : null}
        <Button type="submit" variant={canPasskey ? 'secondary' : 'primary'} size="lg" block busy={busy === 'phrase'}>{t('recover.securePhrase')}</Button>
      </form>
      <Button variant="ghost" onClick={() => void run('skip', async () => undefined)} disabled={!!busy}>{t('recover.secureSkip')}</Button>
    </>
  );
}
