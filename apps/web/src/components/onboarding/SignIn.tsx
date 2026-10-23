'use client';
// Sign in: passkey first; passphrase (handle + passphrase) second; then the authenticator-app code if the
// account has one.
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { accountApi } from '@/lib/auth/account';
import { finishMfaLogin } from '@/lib/auth/login';
import { safeNext } from '@/lib/auth/next';
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

type View = 'main' | 'phrase' | 'mfa';

/** Only same-site paths (lib/auth/next.ts; security review W1). */
export { safeNext };

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
  const [code, setCode] = useState('');

  useDocumentTitle(t('signin.docTitle'));

  // Already signed in → straight in.
  useEffect(() => {
    if (view === 'mfa') return;
    if (status === 'ready') router.replace(next);
  }, [status, view, next, router]);

  const show = (v: View) => { setErr(null); setView(v); };

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) {
      if (errorCode(e) === 'mfa_required') { setView('mfa'); return; }
      setErr(accountErrorMessage(t, e));
    } finally { setBusy(false); }
  }

  const passkey = () => run(async () => { await accountApi.signInWithPasskey(); router.replace(next); });

  function onPhrase(e: FormEvent) {
    e.preventDefault();
    void run(async () => { await accountApi.signInWithPassphrase(normalizeHandle(handle), phrase); router.replace(next); });
  }

  function onMfa(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    finishMfaLogin(code)
      .then((st) => {
        if (st !== 'ready') { setErr(t('signin.mfaFailed')); return; }
        router.replace(next);
      })
      .catch(() => setErr(t('signin.mfaWrong')))
      .finally(() => setBusy(false));
  }

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
      </div>
    </AuthFrame>
  );
}
