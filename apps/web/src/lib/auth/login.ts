'use client';
// Passphrase sign-in with optional MFA (spec §3.3, §7). The database requires an aal2 session once a user has a
// verified TOTP factor (migration 20261018000100), so for those users the key bundle is invisible
// until the code is entered: we sign in, ask for the code, then load and unlock the keys.
// Passkey sign-ins and recovery reach the same code step through finishMfaLogin (lib/keys/session holdPendingAmk).
import { getSession, initSession, signIn, unlock, type PasswordGrant, type SessionStatus } from '../keys/session';
import { sb } from '../supabase';

let pending: { password: string; remember: boolean } | null = null;

export type LoginOutcome = SessionStatus | 'mfa';

/** True when this session has a verified factor but hasn't passed the TOTP step yet. */
export async function mfaRequired(): Promise<boolean> {
  const { data, error } = await sb().auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return false;
  return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
}

/** Sign in with (synthetic address, passphrase); `grant` starts the auth session (lib/auth/account-impl.ts). */
export async function logIn(email: string, password: string, remember: boolean, grant: PasswordGrant): Promise<LoginOutcome> {
  pending = null;
  const st = await signIn(email.trim(), password, remember, grant);
  if (st === 'setup' && await mfaRequired()) {
    pending = { password, remember };
    return 'mfa';
  }
  return getSession().status;
}

/** Verify a 6-digit TOTP code for this session (upgrades it to aal2). */
export async function verifyTotp(code: string): Promise<void> {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) throw new Error('Enter the 6-digit code from your authenticator app.');
  const { data, error } = await sb().auth.mfa.listFactors();
  if (error) throw new Error(error.message);
  const factor = data.totp.find((f) => f.status === 'verified');
  if (!factor) throw new Error('No authenticator app is set up for this account.');
  const v = await sb().auth.mfa.challengeAndVerify({ factorId: factor.id, code: clean });
  if (v.error) throw new Error(v.error.message.includes('Invalid') ? 'That code didn\'t work. Check the time on your phone and try again.' : v.error.message);
}

/** After the TOTP step: reload the session (keys are now readable) and unlock with the passphrase we kept. */
export async function finishMfaLogin(code: string): Promise<SessionStatus> {
  await verifyTotp(code);
  await initSession();
  const p = pending;
  pending = null;
  if (p && getSession().status === 'locked') await unlock(p.password, p.remember);
  return getSession().status;
}
