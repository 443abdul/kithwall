'use client';
// Shown when a session exists but keys are not in memory (spec §3.13: after a reload without
// "Keep me logged in", or after auto-lock). The password unlocks the keys on this device only.
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { signOut, unlock, useSession } from '@/lib/keys/session';
import { afterLogin } from '@/lib/auth/login';
import { usePerson } from '@/lib/people';
import { Avatar } from '@/components/Avatar';
import { Footer } from '@/components/Shell';
import '@/styles/auth.css';

export function UnlockScreen() {
  const { userId, email } = useSession();
  const person = usePerson(userId);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr(null);
    try {
      await unlock(String(f.get('pw')), f.get('keep') === 'on');
      await afterLogin();
    } catch (x) {
      const m = (x as Error & { code?: string }).message;
      setErr(/bad_password|decrypt|password/i.test(m) || (x as { code?: string }).code === 'bad_password'
        ? 'The password you entered is incorrect. Please try again.' : m);
    } finally { setBusy(false); }
  }

  return (
    <>
      <div id="blue"><div id="hd"><Link id="logo" href="/">kithwall</Link></div></div>
      <main className="kw-center" style={{ padding: '40px 10px 60px' }}>
        <div className="kw-box">
          <h3>Unlock Kithwall</h3>
          <div className="in">
            {err && <div className="err" role="alert"><b>Couldn&rsquo;t unlock</b>{err}</div>}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
              {userId ? <Avatar id={userId} size={50} /> : null}
              <div>
                <b style={{ fontSize: 13 }}>{person?.name ?? email ?? 'Your account'}</b>
                {email ? <div className="gray">{email}</div> : null}
              </div>
            </div>
            <p style={{ lineHeight: '16px', marginBottom: 10 }}>Enter your password to unlock Kithwall on this device.
              Your posts and messages are encrypted; your password opens them here, and it never leaves this browser.</p>
            <form className="form" onSubmit={onSubmit} aria-label="Unlock">
              <table><tbody>
                <tr><td className="l"><label htmlFor="unlock-pw">Password:</label></td>
                  <td><input id="unlock-pw" name="pw" type="password" autoComplete="current-password" required autoFocus /></td></tr>
                <tr><td /><td><label className="kw-check"><input type="checkbox" name="keep" /> Keep me logged in</label></td></tr>
                <tr><td /><td><button className="btn b" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button></td></tr>
              </tbody></table>
            </form>
            <p style={{ marginTop: 10, borderTop: '1px solid #e2e2e2', paddingTop: 8 }}>
              Not you? <button type="button" className="kw-link" onClick={() => void signOut().then(() => { location.href = '/'; })}>Log out</button>
              {' '}&middot; <Link href="/recover">Forgot your password?</Link>
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
