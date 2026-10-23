'use client';
// /setup: a signed-in session whose key bundle isn't readable yet (session status 'setup'). That happens
// to accounts with an authenticator app until the 6-digit code is entered (the database hides the bundle
// from aal1 sessions), e.g. after a reload in the middle of signing in.
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '@/i18n';
import { signOut, useSession } from '@/lib/keys/session';
import { finishMfaLogin, mfaRequired } from '@/lib/auth/login';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { TextField } from '@/components/ui/Field';
import { LoadingScreen } from '@/components/ui/Spinner';
import { AuthFrame } from './PublicChrome';
import { useDocumentTitle } from './useDocumentTitle';

export function SetupFlow() {
  const t = useT();
  const router = useRouter();
  const { status } = useSession();
  const [mfa, setMfa] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useDocumentTitle(t('setup.docTitle'));

  useEffect(() => {
    if (status === 'signed_out') router.replace('/signin');
    else if (status === 'ready' || status === 'locked') router.replace('/home');
    else if (status === 'setup') void mfaRequired().then(setMfa).catch(() => setMfa(false));
  }, [status, router]);

  async function onCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await finishMfaLogin(code);
      router.replace('/home');
    } catch { setErr(t('signin.mfaWrong')); } finally { setBusy(false); }
  }

  if (status !== 'setup' || mfa === null) return <LoadingScreen />;
  return (
    <AuthFrame cta="none">
      <div className="k-flow">
        {mfa ? (
          <section className="k-flow-step">
            <h1>{t('signin.mfaTitle')}</h1>
            <p className="k-muted">{t('signin.mfaBody')}</p>
            <form className="k-stack" onSubmit={(e) => void onCode(e)}>
              <TextField label={t('signin.mfaCode')} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric"
                autoComplete="one-time-code" maxLength={7} dir="ltr" required />
              {err ? <Callout tone="danger">{err}</Callout> : null}
              <Button type="submit" variant="primary" size="lg" block busy={busy}>{t('common.continue')}</Button>
            </form>
          </section>
        ) : (
          <section className="k-flow-step">
            <h1>{t('setup.docTitle')}</h1>
            <Callout tone="danger">{t('errors.unknown')}</Callout>
          </section>
        )}
        <Button variant="ghost" onClick={() => void signOut().then(() => router.replace('/'))}>{t('you.signOut')}</Button>
      </div>
    </AuthFrame>
  );
}
