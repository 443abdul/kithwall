'use client';
// Forgot password, step 1 (spec §3.4): send a reset link. The link alone can't unlock anything:
// on the next page you also need your recovery key or your trusted friends.
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { PublicPage } from '@/components/auth/PublicPage';
import { useHydrated } from '@/lib/auth/hydrated';
import { sb } from '@/lib/supabase';

export default function RecoverPage() {
  const hydrated = useHydrated();
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email') ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr('Please enter a valid email address.'); return; }
    setBusy(true); setErr(null);
    try {
      const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/recover/reset` });
      // Same message whether or not the account exists (no account enumeration).
      if (error && !/not.?found|no user/i.test(error.message)) {
        if (/rate|seconds|too many/i.test(error.message)) throw new Error('Please wait a minute before asking for another email.');
        throw new Error(error.message);
      }
      setSent(email);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  return (
    <PublicPage>
      <div className="kw-center" style={{ padding: '20px 0' }}>
        <div className="kw-box">
          <h3>Forgot Your Password?</h3>
          <div className="in">
            {sent ? (
              <div className="ok"><b>Check your email.</b>If an account uses {sent}, we sent it a link. Open it <b>in this browser</b> to continue.
                The link expires in an hour.</div>
            ) : (
              <>
                {err && <div className="err" role="alert">{err}</div>}
                <div className="kw-warn">
                  <b>Your posts are encrypted &mdash; read this first.</b>
                  Kithwall can&rsquo;t read your posts, so we can&rsquo;t simply reset your password and give them back.
                  After you open the email link you&rsquo;ll need <b>one</b> of these:
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    <li>your <b>24-word recovery key</b>, or</li>
                    <li>help from your <b>trusted friends</b> (if you chose them), which takes at least a day.</li>
                  </ul>
                  Without either, your encrypted posts, photos and messages can&rsquo;t be recovered by anyone.
                  You can still delete the account and start over.
                </div>
                <form className="form" onSubmit={onSubmit} aria-label="Send password reset email">
                  <table><tbody>
                    <tr><td className="l"><label htmlFor="rec-email">Your Email:</label></td><td><input id="rec-email" name="email" type="email" autoComplete="email" required /></td></tr>
                    <tr><td /><td><button className="btn b" disabled={busy || !hydrated}>{busy ? 'Sending…' : 'Send Me a Link'}</button> &nbsp;<Link href="/">Cancel</Link></td></tr>
                  </tbody></table>
                </form>
                <p className="kw-help" style={{ marginTop: 8 }}>Remembered it? <Link href="/login">Log in</Link>. Want to know more? <Link href="/help#recovery">How recovery works</Link>.</p>
              </>
            )}
          </div>
        </div>
      </div>
    </PublicPage>
  );
}
