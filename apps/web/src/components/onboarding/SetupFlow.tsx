'use client';
// /setup: finishing a signed-in account that has no encryption keys yet (session status 'setup').
// Two cases: a v1 email account that confirmed its email but never created keys (the old /welcome
// page), and an account with an authenticator app whose session hasn't passed the 6-digit code yet.
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '@/i18n';
import { completeSetup, signOut, useSession } from '@/lib/keys/session';
import { finishMfaLogin, mfaRequired } from '@/lib/auth/login';
import { accountApi } from '@/lib/auth/account';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { TextField } from '@/components/ui/Field';
import { LoadingScreen } from '@/components/ui/Spinner';
import { AuthFrame } from './PublicChrome';
import { PassphraseField } from './PassphraseField';
import { normalizeHandle } from './JoinFlow';
import { markRecoveryNudge } from './nudges';
import { useDocumentTitle } from './useDocumentTitle';

export function SetupFlow() {
  const t = useT();
  const router = useRouter();
  const { status } = useSession();
  const [mfa, setMfa] = useState<boolean | null>(null);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
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
    try { await finishMfaLogin(code); router.replace('/home'); } catch { setErr(t('signin.mfaWrong')); } finally { setBusy(false); }
  }

  async function onKeys(e: FormEvent) {
    e.preventDefault();
    const h = normalizeHandle(handle);
    setBusy(true); setErr(null);
    try {
      const problem = await accountApi.handleProblem(h);
      if (problem) { setErr(t(problem === 'taken' ? 'handle.taken' : problem === 'reserved' ? 'handle.reserved' : 'handle.invalid')); return; }
      await completeSetup({ password, username: h, directoryName: null });
      const friends = await import('@/lib/friends');
      await friends.saveProfileInfo({ name: name.trim().slice(0, 80) }).catch(() => undefined);
      markRecoveryNudge();
      router.replace('/home');
    } catch (x) {
      const m = (x as Error).message ?? '';
      setErr(/password/i.test(m) ? t('setup.wrongPassword') : /taken/i.test(m) ? t('handle.taken') : t('errors.unknown'));
    } finally { setBusy(false); }
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
            <h1>{t('setup.title')}</h1>
            <p className="k-muted">{t('setup.body')}</p>
            <form className="k-stack" onSubmit={(e) => void onKeys(e)} noValidate>
              <TextField label={t('join.nameLabel')} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60}
                hint={t('join.nameHint')} required />
              <TextField label={t('join.handleLabel')} value={handle} onChange={(e) => setHandle(e.target.value)} prefix="@"
                autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={31} dir="ltr" hint={t('handle.hint')} required />
              <PassphraseField label={t('signin.password')} value={password} onValue={setPassword} autoComplete="current-password"
                hint={t('setup.passwordHint')} required />
              {err ? <Callout tone="danger">{err}</Callout> : null}
              <Button type="submit" variant="primary" size="lg" block busy={busy} busyLabel={t('join.creating')}
                disabled={!name.trim() || !normalizeHandle(handle) || !password}>{t('setup.cta')}</Button>
            </form>
          </section>
        )}
        <Button variant="ghost" onClick={() => void signOut().then(() => router.replace('/'))}>{t('you.signOut')}</Button>
      </div>
    </AuthFrame>
  );
}
