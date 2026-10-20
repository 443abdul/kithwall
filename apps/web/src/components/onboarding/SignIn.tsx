'use client';
// Sign in: passkey first; passphrase (handle + passphrase) second; v1 email + password (+ two-step code)
// third, after which we offer to add a passkey (brief §5 "Migration").
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { accountApi } from '@/lib/auth/account';
import { finishMfaLogin } from '@/lib/auth/login';
import { useSession } from '@/lib/keys/session';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Callout';
import { Icon } from '@/components/ui/Icon';
import { AuthFrame } from './PublicChrome';
import { PassphraseField } from './PassphraseField';
import { accountErrorMessage, errorCode } from './errors';
import { normalizeHandle } from './JoinFlow';
import { useDocumentTitle } from './useDocumentTitle';

type View = 'main' | 'phrase' | 'legacy' | 'mfa' | 'addPasskey';

/** Only same-site paths (no protocol-relative or absolute URLs). */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/home';
  return raw;
}

export function SignIn() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const { status } = useSession();
  const [view, setView] = useState<View>('main');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [handle, setHandle] = useState('');
  const [phrase, setPhrase] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // Set while a legacy sign-in is in progress, so the session turning 'ready' doesn't skip the passkey offer.
  const hold = useRef(false);

  useDocumentTitle(t('signin.docTitle'));

  // Already signed in → straight in (except while we're offering the passkey upgrade).
  useEffect(() => {
    if (hold.current || view === 'addPasskey' || view === 'mfa') return;
    if (status === 'ready') router.replace(next);
  }, [status, view, next, router]);

  const show = (v: View) => { setErr(null); setView(v); };

  // Where to go after the two-step code: v1 accounts get the passkey offer first.
  const afterMfa = useRef<'addPasskey' | 'next'>('next');

  async function run(fn: () => Promise<void>, legacy = false) {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) {
      const code = errorCode(e);
      if (code === 'mfa_required') { afterMfa.current = legacy ? 'addPasskey' : 'next'; setView('mfa'); return; }
      // v1 sign-in failures (wrong email/password) aren't about passphrases or handles.
      setErr(legacy && (code === 'unknown' || code === 'wrong_passphrase') ? t('signin.legacyFailed') : accountErrorMessage(t, e));
    } finally { setBusy(false); }
  }

  const passkey = () => run(async () => { await accountApi.signInWithPasskey(); router.replace(next); });

  function onPhrase(e: FormEvent) {
    e.preventDefault();
    void run(async () => { await accountApi.signInWithPassphrase(normalizeHandle(handle), phrase); router.replace(next); });
  }

  function onLegacy(e: FormEvent) {
    e.preventDefault();
    hold.current = true;
    void run(async () => {
      try {
        const r = await accountApi.signInLegacy(email.trim(), password);
        if (r === 'mfa') { afterMfa.current = 'addPasskey'; setView('mfa'); return; }
        setView('addPasskey');
      } catch (x) { hold.current = false; throw x; }
    }, true);
  }

  function onMfa(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    finishMfaLogin(code)
      .then((st) => {
        if (st !== 'ready') { setErr(t('signin.mfaFailed')); return; }
        if (afterMfa.current === 'addPasskey') setView('addPasskey'); else router.replace(next);
      })
      .catch(() => setErr(t('signin.mfaWrong')))
      .finally(() => setBusy(false));
  }

  const addPasskey = () => run(async () => { await accountApi.addPasskey(); router.replace(next); });

  return (
    <AuthFrame cta="join">
      <div className="k-flow">
        {view === 'main' ? (
          <section className="k-flow-step">
            <div className="k-passkey-art" aria-hidden><Icon name="fingerprint" /></div>
            <h1>{t('signin.title')}</h1>
            <p className="k-muted">{t('signin.body')}</p>
            {err ? <Callout tone="danger">{err}</Callout> : null}
            <div className="k-flow-actions k-flow-actions-stack">
              <Button variant="primary" size="lg" block icon="fingerprint" busy={busy} onClick={() => void passkey()}>{t('signin.passkey')}</Button>
              <Button variant="secondary" block icon="key" onClick={() => show('phrase')}>{t('signin.usePassphrase')}</Button>
            </div>
            <div className="k-divider"><span>{t('signin.older')}</span></div>
            <Button variant="ghost" block icon="mail" onClick={() => show('legacy')}>{t('signin.legacy')}</Button>
            <p className="k-center k-small k-muted">{t('signin.noAccount')} <Link href="/join">{t('landing.cta')}</Link></p>
          </section>
        ) : null}

        {view === 'phrase' ? (
          <section className="k-flow-step">
            <h1>{t('signin.phraseTitle')}</h1>
            <form className="k-stack" onSubmit={onPhrase}>
              <TextField label={t('join.handleLabel')} prefix="@" value={handle} onChange={(e) => setHandle(e.target.value)}
                autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} dir="ltr" required />
              <PassphraseField label={t('join.phraseLabel')} value={phrase} onValue={setPhrase} autoComplete="current-password" required />
              {err ? <Callout tone="danger">{err}</Callout> : null}
              <div className="k-flow-actions k-flow-actions-stack">
                <Button type="submit" variant="primary" size="lg" block busy={busy}>{t('signin.submit')}</Button>
                <Button variant="ghost" icon="back" onClick={() => show('main')}>{t('common.back')}</Button>
              </div>
            </form>
          </section>
        ) : null}

        {view === 'legacy' ? (
          <section className="k-flow-step">
            <h1>{t('signin.legacyTitle')}</h1>
            <p className="k-muted">{t('signin.legacyBody')}</p>
            <form className="k-stack" onSubmit={onLegacy}>
              <TextField label={t('signin.email')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" dir="ltr" required />
              <PassphraseField label={t('signin.password')} value={password} onValue={setPassword} autoComplete="current-password" required />
              {err ? <Callout tone="danger">{err}</Callout> : null}
              <div className="k-flow-actions k-flow-actions-stack">
                <Button type="submit" variant="primary" size="lg" block busy={busy}>{t('signin.submit')}</Button>
                <Button variant="ghost" icon="back" onClick={() => show('main')}>{t('common.back')}</Button>
              </div>
              <p className="k-center k-small"><Link href="/recover">{t('signin.forgot')}</Link></p>
            </form>
          </section>
        ) : null}

        {view === 'mfa' ? (
          <section className="k-flow-step">
            <div className="k-passkey-art" aria-hidden><Icon name="shield" /></div>
            <h1>{t('signin.mfaTitle')}</h1>
            <p className="k-muted">{t('signin.mfaBody')}</p>
            <form className="k-stack" onSubmit={onMfa}>
              <TextField label={t('signin.mfaCode')} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric"
                autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} dir="ltr" required />
              {err ? <Callout tone="danger">{err}</Callout> : null}
              <Button type="submit" variant="primary" size="lg" block busy={busy}>{t('common.continue')}</Button>
            </form>
          </section>
        ) : null}

        {view === 'addPasskey' ? (
          <section className="k-flow-step">
            <div className="k-passkey-art k-celebrate" aria-hidden><Icon name="fingerprint" /></div>
            <h1>{t('signin.upgradeTitle')}</h1>
            <p>{t('signin.upgradeBody')}</p>
            <ul role="list" className="k-checks">
              <li><Icon name="check" /> {t('join.passkeyPoint1')}</li>
              <li><Icon name="check" /> {t('signin.upgradePoint')}</li>
            </ul>
            {err ? <Callout tone="danger">{err}</Callout> : null}
            <div className="k-flow-actions k-flow-actions-stack">
              <Button variant="primary" size="lg" block icon="fingerprint" busy={busy} onClick={() => void addPasskey()}>{t('signin.upgradeCta')}</Button>
              <Button variant="ghost" onClick={() => router.replace(next)}>{t('common.notNow')}</Button>
            </div>
          </section>
        ) : null}
      </div>
    </AuthFrame>
  );
}
