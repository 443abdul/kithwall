'use client';
// 2010 login page (reference vLogin): used when the header login fails (?error=), and for the
// two-step verification code (?step=code).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { PublicPage } from '@/components/auth/PublicPage';
import { useHydrated } from '@/lib/auth/hydrated';
import { MfaForm } from '@/components/auth/MfaForm';
import { finishMfaLogin, logIn, mfaRequired } from '@/lib/auth/login';
import { useSession } from '@/lib/keys/session';

export default function LoginPage() {
  const hydrated = useHydrated();
  const router = useRouter();
  const { status } = useSession();
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const e = q.get('error');
    if (e) setErr(e.slice(0, 200));
    setEmail((q.get('email') ?? '').slice(0, 200));
    if (q.get('step') === 'code') setStep('code');
  }, []);

  useEffect(() => {
    if (status === 'ready') router.replace('/');
    // Signed in with a password but the code wasn't entered yet (e.g. after a reload).
    if (status === 'setup' && step === 'password') void mfaRequired().then((m) => { if (m) setStep('code'); else router.replace('/welcome'); });
  }, [status, step, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr(null);
    try {
      const st = await logIn(String(f.get('email')), String(f.get('pw')), f.get('keep') === 'on');
      if (st === 'mfa') setStep('code');
      else router.replace(st === 'setup' ? '/welcome' : '/');
    } catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <PublicPage plainHeader>
      <div className="kw-center" style={{ padding: '30px 0' }}>
        <div className="kw-box">
          <h3>{step === 'code' ? 'Two-Step Verification' : 'Log in to Kithwall'}</h3>
          <div className="in">
            {step === 'code' ? (
              <MfaForm verify={async (code) => { const st = await finishMfaLogin(code); router.replace(st === 'setup' ? '/welcome' : '/'); }} onVerified={() => undefined} />
            ) : (
              <>
                {err && <div className="err" role="alert"><b>{/incorrect/i.test(err) ? 'Incorrect Email/Password Combination' : 'Login failed'}</b>{err}
                  {/incorrect/i.test(err) ? <> Kithwall passwords are case sensitive. <Link href="/recover">Forgot your password?</Link></> : null}</div>}
                <form className="form" onSubmit={onSubmit} aria-label="Log in">
                  <table><tbody>
                    <tr><td className="l"><label htmlFor="email">Email:</label></td><td><input id="email" name="email" type="email" autoComplete="username" required defaultValue={email} key={email} /></td></tr>
                    <tr><td className="l"><label htmlFor="pw">Password:</label></td><td><input id="pw" name="pw" type="password" autoComplete="current-password" required autoFocus /></td></tr>
                    <tr><td /><td><label className="kw-check"><input type="checkbox" name="keep" /> Keep me logged in</label>
                      <div className="kw-help">Only on your own device: it keeps your keys here, protected by your browser.</div></td></tr>
                    <tr><td /><td><button className="btn b" disabled={busy || !hydrated}>{busy ? 'Unlocking…' : 'Log In'}</button> &nbsp;or <Link href="/">Sign up for Kithwall</Link></td></tr>
                    <tr><td /><td><Link href="/recover">Forgot your password?</Link></td></tr>
                  </tbody></table>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    </PublicPage>
  );
}
