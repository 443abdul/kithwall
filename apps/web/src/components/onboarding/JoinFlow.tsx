'use client';
// Sign-up (docs/v2/00-brief.md §5), target under 30 seconds:
//   1 style + mode → 2 name + @handle → 3 passkey (or passphrase fallback) → 4 find your people → /home
// Bot protection is invisible: the ALTCHA proof-of-work is fetched and solved in the background from the
// moment the page opens, and awaited (usually already done) when the account is created.
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { accountApi, type Capabilities } from '@/lib/auth/account';
import { fetchChallenge, solve } from '@/lib/auth/altcha';
import { useSession } from '@/lib/keys/session';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Callout';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { AuthFrame } from './PublicChrome';
import { StylePicker } from './StylePicker';
import { PassphraseField, passphraseOk } from './PassphraseField';
import { accountErrorMessage, errorCode } from './errors';
import { useDocumentTitle } from './useDocumentTitle';
import { markRecoveryNudge } from './nudges';
import { InvitePanel } from './InvitePanel';

type Step = 1 | 2 | 3 | 4;
type HandleState = 'idle' | 'checking' | 'ok' | 'invalid' | 'taken' | 'reserved' | 'error';

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase().replace(/\s+/g, '');
}

/** Starts the proof-of-work immediately; returns a getter that resolves to the payload. */
function useProofOfWork() {
  const job = useRef<Promise<string> | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const [closed, setClosed] = useState(false);
  const start = () => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    const p = fetchChallenge().then((r) => {
      if (!r.signupsEnabled) { setClosed(true); throw new Error('closed'); }
      return solve(r.challenge, c.signal);
    });
    p.catch(() => undefined); // surfaced when awaited
    job.current = p;
    return p;
  };
  useEffect(() => {
    start();
    return () => ctl.current?.abort();
  }, []);
  return {
    closed,
    /** Payload, restarting once if the background attempt failed. */
    get: async () => {
      try { return await (job.current ?? start()); } catch { return await start(); }
    },
  };
}

export function JoinFlow() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const invite = params.get('invite') ?? undefined;
  const { status } = useSession();
  const pow = useProofOfWork();
  const headingId = useId();
  const [step, setStep] = useState<Step>(1);
  // Set while creating the account, so the session turning 'ready' doesn't skip step 4.
  const creating = useRef(false);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [handleState, setHandleState] = useState<HandleState>('idle');
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [usePhrase, setUsePhrase] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [phrase2, setPhrase2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useDocumentTitle(t('join.docTitle'));

  // Already signed in (and not because we just created the account here): go to the app. An invite
  // link opened while signed in goes to Connections, which offers to send the inviter a request.
  useEffect(() => {
    if (!creating.current && (status === 'ready' || status === 'locked')) {
      router.replace(invite ? `/people?invite=${encodeURIComponent(invite)}` : '/home');
    }
  }, [status, router, invite]);

  useEffect(() => {
    let live = true;
    accountApi.capabilities().then((c) => {
      if (!live) return;
      setCaps(c);
      if (!c.passkey || c.prf === false) setUsePhrase(true);
    }).catch(() => { if (live) setCaps({ passkey: false, prf: false }); });
    return () => { live = false; };
  }, []);

  // Debounced live availability check.
  useEffect(() => {
    const h = normalizeHandle(handle);
    if (!h) { setHandleState('idle'); return; }
    setHandleState('checking');
    let live = true;
    const timer = setTimeout(() => {
      accountApi.handleProblem(h).then((p) => { if (live) setHandleState(p ?? 'ok'); })
        .catch(() => { if (live) setHandleState('error'); });
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [handle]);

  // Move focus to the new step's heading so screen readers announce it.
  useEffect(() => { headingRef.current?.focus(); }, [step]);

  const go = (s: Step) => { setErr(null); setStep(s); };
  const h = normalizeHandle(handle);
  const nameOk = name.trim().length >= 1 && name.trim().length <= 60;
  const step2Ok = nameOk && handleState === 'ok';

  async function create(withPhrase: boolean) {
    setBusy(true); setErr(null);
    creating.current = true;
    try {
      const altcha = await pow.get();
      await accountApi.createAccount({
        displayName: name.trim(), handle: h, altcha, inviteCode: invite,
        passphrase: withPhrase ? phrase : undefined,
      });
      markRecoveryNudge();
      go(4);
    } catch (e) {
      creating.current = false;
      const code = errorCode(e);
      if (code === 'passkey_unsupported' || code === 'prf_unsupported') setUsePhrase(true);
      if (code === 'handle_taken' || code === 'handle_invalid') { setHandleState(code === 'handle_taken' ? 'taken' : 'invalid'); go(2); }
      setErr(pow.closed ? t('join.closed') : accountErrorMessage(t, e));
    } finally { setBusy(false); }
  }

  function onStep2(e: FormEvent) {
    e.preventDefault();
    if (step2Ok) go(3);
  }

  function onPhrase(e: FormEvent) {
    e.preventDefault();
    if (phrase !== phrase2) { setErr(t('passphrase.mismatch')); return; }
    if (!passphraseOk(phrase, [h, name])) { setErr(t('errors.weak_passphrase')); return; }
    void create(true);
  }

  const handleHint = {
    idle: t('handle.hint'),
    checking: <span className="k-row"><Spinner size={14} /> {t('handle.checking')}</span>,
    ok: <span className="k-handle-ok"><Icon name="check" /> {t('handle.available', { handle: h })}</span>,
    invalid: null, taken: null, reserved: null,
    error: t('handle.checkFailed'),
  }[handleState];
  const handleError = handleState === 'invalid' ? t('handle.invalid') : handleState === 'taken' ? t('handle.taken')
    : handleState === 'reserved' ? t('handle.reserved') : null;

  return (
    <AuthFrame cta={step === 4 ? 'none' : 'signin'}>
      <div className="k-flow">
        <div className="k-flow-progress">
          <span className="k-small k-muted">{t('join.stepOf', { step, total: 4 })}</span>
          <div className="k-progress" role="progressbar" aria-valuemin={1} aria-valuemax={4} aria-valuenow={step} aria-label={t('join.progress')}>
            <span style={{ inlineSize: `${(step / 4) * 100}%` }} />
          </div>
        </div>

        {step === 1 ? (
          <section className="k-flow-step" aria-labelledby={headingId}>
            <h1 id={headingId} ref={headingRef} tabIndex={-1}>{t('join.styleTitle')}</h1>
            <p className="k-muted">{t('join.styleBody')}</p>
            <StylePicker headingId={headingId} />
            <div className="k-flow-actions">
              <Button variant="primary" size="lg" block iconEnd="forward" onClick={() => go(2)}>{t('common.continue')}</Button>
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="k-flow-step" aria-labelledby={headingId}>
            <h1 id={headingId} ref={headingRef} tabIndex={-1}>{t('join.nameTitle')}</h1>
            <p className="k-muted">{t('join.nameBody')}</p>
            <form className="k-stack" onSubmit={onStep2} noValidate>
              <TextField
                label={t('join.nameLabel')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                maxLength={60}
                hint={t('join.nameHint')}
                required
              />
              <TextField
                label={t('join.handleLabel')}
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                prefix="@"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={31}
                dir="ltr"
                hint={handleHint}
                error={handleError}
                required
              />
              {err ? <Callout tone="danger">{err}</Callout> : null}
              <div className="k-flow-actions">
                <Button variant="ghost" icon="back" onClick={() => go(1)}>{t('common.back')}</Button>
                <Button type="submit" variant="primary" size="lg" iconEnd="forward" disabled={!step2Ok}>{t('common.continue')}</Button>
              </div>
            </form>
          </section>
        ) : null}

        {step === 3 && !usePhrase ? (
          <section className="k-flow-step" aria-labelledby={headingId}>
            <div className="k-passkey-art" aria-hidden><Icon name="fingerprint" /></div>
            <h1 id={headingId} ref={headingRef} tabIndex={-1}>{t('join.passkeyTitle')}</h1>
            <p>{t('join.passkeyBody')}</p>
            <ul role="list" className="k-checks">
              <li><Icon name="check" /> {t('join.passkeyPoint1')}</li>
              <li><Icon name="check" /> {t('join.passkeyPoint2')}</li>
              <li><Icon name="check" /> {t('join.passkeyPoint3')}</li>
            </ul>
            {err ? <Callout tone="danger">{err}</Callout> : null}
            <div className="k-flow-actions k-flow-actions-stack">
              <Button variant="primary" size="lg" block icon="fingerprint" busy={busy} busyLabel={t('join.creating')} onClick={() => void create(false)} disabled={!caps}>
                {t('join.passkeyCta')}
              </Button>
              <Button variant="ghost" onClick={() => { setErr(null); setUsePhrase(true); }}>{t('join.usePassphrase')}</Button>
              <Button variant="ghost" icon="back" onClick={() => go(2)}>{t('common.back')}</Button>
            </div>
          </section>
        ) : null}

        {step === 3 && usePhrase ? (
          <section className="k-flow-step" aria-labelledby={headingId}>
            <div className="k-passkey-art" aria-hidden><Icon name="key" /></div>
            <h1 id={headingId} ref={headingRef} tabIndex={-1}>{t('join.phraseTitle')}</h1>
            <p className="k-muted">{caps && (!caps.passkey || caps.prf === false) ? t('join.phraseWhyDevice') : t('join.phraseWhy')}</p>
            <form className="k-stack" onSubmit={onPhrase} noValidate>
              <PassphraseField
                label={t('join.phraseLabel')}
                value={phrase}
                onValue={setPhrase}
                meter
                userInputs={[h, name]}
                autoComplete="new-password"
              />
              <PassphraseField label={t('join.phraseConfirm')} value={phrase2} onValue={setPhrase2} autoComplete="new-password" />
              <Callout tone="warning">{t('join.phraseWarning')}</Callout>
              {err ? <Callout tone="danger">{err}</Callout> : null}
              <div className="k-flow-actions k-flow-actions-stack">
                <Button type="submit" variant="primary" size="lg" block busy={busy} busyLabel={t('join.creating')}>{t('join.phraseCta')}</Button>
                {caps?.passkey && caps.prf !== false ? (
                  <Button variant="ghost" icon="fingerprint" onClick={() => { setErr(null); setUsePhrase(false); }}>{t('join.usePasskey')}</Button>
                ) : null}
                <Button variant="ghost" icon="back" onClick={() => go(2)}>{t('common.back')}</Button>
              </div>
            </form>
          </section>
        ) : null}

        {step === 4 ? (
          <section className="k-flow-step" aria-labelledby={headingId}>
            <div className="k-passkey-art k-celebrate" aria-hidden><Icon name="sparkle" /></div>
            <h1 id={headingId} ref={headingRef} tabIndex={-1}>{t('join.doneTitle', { name: name.trim() })}</h1>
            <p className="k-muted">{t('join.peopleBody')}</p>
            <InvitePanel />
            <div className="k-flow-actions k-flow-actions-stack">
              <Button variant="primary" size="lg" block iconEnd="forward" onClick={() => router.push('/home')}>{t('join.goHome')}</Button>
            </div>
          </section>
        ) : null}
      </div>
    </AuthFrame>
  );
}
