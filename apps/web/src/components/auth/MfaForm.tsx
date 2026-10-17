'use client';
// "Enter the 6-digit code" step for accounts with an authenticator app (spec §7: MFA).
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { verifyTotp } from '@/lib/auth/login';
import { signOut } from '@/lib/keys/session';

export function MfaForm({ onVerified, verify = verifyTotp, submitLabel = 'Continue' }: {
  onVerified: () => void | Promise<void>; verify?: (code: string) => Promise<unknown>; submitLabel?: string;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    setBusy(true); setErr(null);
    try { await verify(code); await onVerified(); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={onSubmit} className="form" aria-label="Two-step verification">
      {err && <div className="err" role="alert"><b>That didn&rsquo;t work</b>{err}</div>}
      <p style={{ lineHeight: '16px', marginBottom: 8 }}>This account uses <b>two-step verification</b>. Open your authenticator app and enter the 6-digit code for Kithwall.</p>
      <table><tbody>
        <tr><td className="l"><label htmlFor="mfa-code">Code:</label></td>
          <td><input id="mfa-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required style={{ width: 110, letterSpacing: 2 }} /></td></tr>
        <tr><td /><td><button className="btn b" disabled={busy}>{busy ? 'Checking…' : submitLabel}</button>{' '}
          <button type="button" className="kw-link" onClick={() => void signOut().then(() => { location.href = '/'; })}>Cancel and log out</button></td></tr>
      </tbody></table>
      <p className="kw-help">Lost your phone? Your recovery key can&rsquo;t turn off two-step verification. See <Link href="/help#mfa">the Help Center</Link>.</p>
    </form>
  );
}
